/**
 * jobstore.mjs —— 生成任务持久化（一条任务一个 JSON）
 *
 * 设计：
 *  · 宿主只负责调度，真正调模型/下载在独立 worker 子进程里跑；
 *  · 任务状态写文件，宿主重启后能恢复 queued、能把遗留 running 标 interrupted；
 *  · 所有写入先写临时文件再 rename，避免宿主/worker 同时写坏。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { STORE } from '../store.mjs'

const ID_RE = /^[a-f0-9]{16}$/
const MODES = new Set(['t2i', 'i2i', 't2v', 'i2v'])
const KINDS = new Set(['image', 'video'])

export const jobDir = () => join(STORE, 'generated-jobs')
const jobFile = (id) => join(jobDir(), `${id}.json`)

function ensureDir() {
  mkdirSync(jobDir(), { recursive: true })
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data)
  try { renameSync(tmp, file) } catch {
    writeFileSync(file, data)
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

export function readJob(id) {
  const s = String(id || '')
  if (!ID_RE.test(s)) return null
  try { return JSON.parse(readFileSync(jobFile(s), 'utf8')) } catch { return null }
}

export function writeJob(job) {
  if (!job?.id || !ID_RE.test(job.id)) throw new Error('invalid job id')
  ensureDir()
  atomicWrite(jobFile(job.id), JSON.stringify(job, null, 2))
  return job
}

export function updateJob(id, patch) {
  const cur = readJob(id)
  if (!cur) return null
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
  writeJob(next)
  return next
}

export function listJobs(limit = 50) {
  ensureDir()
  const out = []
  for (const f of readdirSync(jobDir())) {
    if (!f.endsWith('.json') || !ID_RE.test(f.slice(0, -5))) continue
    const j = readJob(f.slice(0, -5))
    if (j) out.push(j)
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return out.slice(0, Math.max(1, Number(limit) || 50))
}

export function createJob(input = {}) {
  const kind = KINDS.has(input.kind) ? input.kind : 'image'
  const mode = MODES.has(input.mode) ? input.mode : (kind === 'video' ? 't2v' : 't2i')
  const prompt = String(input.prompt || '').trim().slice(0, 4000)
  const refImages = (Array.isArray(input.refImages) ? input.refImages : [])
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4)
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? input.params : {}
  const now = new Date().toISOString()
  const job = {
    id: randomBytes(8).toString('hex'),
    kind,
    mode,
    model: String(input.model || '').trim().slice(0, 80),
    baseUrl: String(input.baseUrl || '').trim().slice(0, 300),
    prompt,
    refImages,
    params,
    parentId: String(input.parentId || '').slice(0, 80),
    retryOf: String(input.retryOf || '').slice(0, 80),
    projectId: String(input.projectId || '').slice(0, 80),
    shotId: String(input.shotId || '').slice(0, 40),
    phase: String(input.phase || '').slice(0, 24),
    takeNo: Number(input.takeNo) || 0,
    meta: input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta) ? input.meta : {},
    title: String(input.title || '').trim().slice(0, 80) || prompt.slice(0, 30) || (kind === 'video' ? 'AI 视频' : 'AI 图片'),
    priority: Number(input.priority) || 0,
    dryRun: Boolean(input.dryRun),
    status: 'queued',
    stage: '排队中',
    progress: 0,
    attempts: 0,
    error: '',
    media: null,
    billable: null,
    upstreamJobId: '',
    childPid: null,
    createdAt: now,
    updatedAt: now,
    startedAt: '',
    endedAt: '',
  }
  return writeJob(job)
}

export function retryJob(id) {
  const old = readJob(id)
  if (!old) return null
  if (['queued', 'running'].includes(old.status)) return null
  return createJob({
    kind: old.kind,
    mode: old.mode,
    model: old.model,
    baseUrl: old.baseUrl,
    prompt: old.prompt,
    refImages: old.refImages,
    params: old.params,
    parentId: old.parentId || old.id,
    retryOf: old.id,
    projectId: old.projectId,
    shotId: old.shotId,
    phase: old.phase,
    takeNo: old.takeNo,
    meta: old.meta,
    title: old.title,
    priority: old.priority,
    dryRun: old.dryRun,
  })
}

export function cancelJob(id) {
  const cur = readJob(id)
  if (!cur) return null
  if (['done', 'failed', 'cancelled'].includes(cur.status)) return cur
  return updateJob(id, { status: 'cancelled', stage: '已取消', endedAt: new Date().toISOString(), error: '已手动取消' })
}

/** 宿主启动时调用：上一个进程留下的 running 不会再回来，标中断而不是假装还在跑 */
export function recoverInterrupted() {
  let n = 0
  for (const j of listJobs(500)) {
    if (j.status !== 'running') continue
    updateJob(j.id, {
      status: 'interrupted',
      stage: '已中断',
      error: '宿主重启，任务中断；可点重试',
      endedAt: new Date().toISOString(),
    })
    n++
  }
  return n
}
