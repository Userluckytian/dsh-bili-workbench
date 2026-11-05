/**
 * worker.mjs —— 单个生成任务的执行进程
 *
 * 由宿主 spawn：node worker.mjs --job <id>
 * 只做一件事：读 job → 调代理 → 下载 → 入库 → 把状态写回 job JSON。
 * 宿主重启/取消时不会留在 dsh 事件循环里。
 */
import { readJob, updateJob } from './jobstore.mjs'
import { runJob, cancelUpstream } from './fal.mjs'

const args = process.argv.slice(2)
const i = args.indexOf('--job')
const id = i >= 0 ? String(args[i + 1] || '') : ''
if (!id) {
  console.error('usage: node worker.mjs --job <jobId>')
  process.exit(2)
}

let job = readJob(id)
if (!job) {
  console.error('job not found: ' + id)
  process.exit(2)
}
if (!['queued', 'running'].includes(job.status)) {
  console.error(`job ${id} is ${job.status}; nothing to do`)
  process.exit(0)
}

let upstreamId = job.upstreamJobId || ''
let stopping = false

function activeUpdate(patch) {
  const cur = readJob(id)
  if (!cur || !['queued', 'running'].includes(cur.status)) return cur
  return updateJob(id, patch)
}

async function stop(signal) {
  if (stopping) return
  stopping = true
  if (upstreamId) await cancelUpstream(job.baseUrl, upstreamId)
  const cur = readJob(id)
  if (cur && ['queued', 'running'].includes(cur.status)) {
    updateJob(id, {
      status: 'cancelled', stage: '已取消', error: '已手动取消',
      endedAt: new Date().toISOString(),
    })
  }
  console.log(`[${id}] stopped by ${signal}`)
  process.exit(0)
}

process.once('SIGTERM', () => { stop('SIGTERM') })
process.once('SIGINT', () => { stop('SIGINT') })

job = updateJob(id, {
  status: 'running',
  stage: '启动中',
  attempts: Number(job.attempts || 0) + 1,
  childPid: process.pid,
  startedAt: job.startedAt || new Date().toISOString(),
})

const hooks = {
  stage(stage) {
    activeUpdate({ status: 'running', stage: String(stage || '生成中').slice(0, 120) })
    console.log(`[${id}] ${stage}`)
  },
  upstream(uid) {
    upstreamId = String(uid || '')
    activeUpdate({ upstreamJobId: upstreamId })
    console.log(`[${id}] upstream=${upstreamId}`)
  },
}

try {
  const out = await runJob(job, hooks)
  const cur = readJob(id)
  if (cur && cur.status === 'cancelled') {
    console.log(`[${id}] finished after cancel; asset kept but job stays cancelled`)
    process.exit(0)
  }
  updateJob(id, {
    status: 'done',
    stage: '完成',
    progress: 100,
    media: out.asset,
    billable: out.billable ?? null,
    error: '',
    endedAt: new Date().toISOString(),
  })
  console.log(`[${id}] done ${out.asset?.file || ''}`)
} catch (e) {
  const cur = readJob(id)
  if (!cur || cur.status !== 'cancelled') {
    updateJob(id, {
      status: 'failed',
      stage: '失败',
      error: String(e?.message ?? e).slice(0, 2000),
      endedAt: new Date().toISOString(),
    })
  }
  console.error(`[${id}] failed: ${String(e?.message ?? e)}`)
  process.exitCode = 1
}
