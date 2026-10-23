/**
 * auto-reply.mjs —— 有人回复/评论时，AI 自动写回复并发送
 *
 *   node auto-reply.mjs --limit 5 [--dry-run]
 *
 * 规则：
 *   · 只看 feed replies 里 is_new 的条目，且 rpid 没回过（interactions.json 账本）
 *   · 不回复自己
 *   · 默认真的发；--dry-run 只打印命令
 *   · 风控/限流立刻停，不自动重发
 */
import { runBili } from './bili.mjs'
import * as interact from './interact.mjs'
import { composeText } from './compose-lib.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(s)

function selfMid() {
  try {
    const r = runBili(['auth', 'status'], { timeoutMs: 20000 })
    return String(r.data?.user?.mid || '')
  } catch { return '' }
}

async function main() {
  const dryRun = flag('dry-run')
  const limit = Math.max(1, Math.min(Number(arg('limit', 5)) || 5, 20))
  const persona = String(process.env.BILI_OP_PERSONA || '')
  const myMid = selfMid()

  const r = runBili(['feed', 'replies', '--limit', String(Math.max(limit * 3, 20))], { timeoutMs: 45000 })
  if (!r.ok) { log('拉回复失败：' + (r.error?.message || r.error?.code || '')); return }
  const items = (r.data?.items || [])
  const db = interact.load()

  const targets = items.filter((m) => {
    if (!m?.is_new) return false
    if (m.user?.mid && myMid && String(m.user.mid) === myMid) return false
    if (db.replied[String(m.rpid)]) return false
    return Boolean(m.on?.bvid) && Boolean(m.content)
  }).slice(0, limit)

  if (!targets.length) { log('没有需要回复的新消息'); return }
  log(`待回复 ${targets.length} 条${dryRun ? '（dry-run）' : ''}`)

  let ok = 0, fail = 0
  for (const m of targets) {
    let text = ''
    try {
      const c = await composeText('reply', {
        message: m.content || '',
        replyingTo: m.replying_to || '',
        video: m.on?.title || '',
      }, persona)
      text = c.text
    } catch (e) {
      log(`  ✗ ${m.rpid} 生成失败：${String(e?.message ?? e).split('\n')[0]}`)
      fail++
      continue
    }
    if (!text) { log(`  ✗ ${m.rpid} 生成为空`); fail++; continue }

    const args = []
    if (dryRun) args.push('--dry-run')
    args.push('comment', 'reply', m.on.bvid, String(m.rpid), text)
    if (m.root) args.push('--root', String(m.root))
    const res = runBili(args, { timeoutMs: 60000 })
    if (res.ok) {
      if (!dryRun) interact.markReply(m.rpid, { text })
      ok++
      log(`  ✓ ${m.rpid} ${dryRun ? 'dry-run' : '已回复'}：${text}`)
    } else {
      fail++
      const msg = res.error?.message || res.error?.code || '未知错误'
      log(`  ✗ ${m.rpid} 发送失败：${msg}`)
      if (/风控|risk|频繁|限流|稍后|被封|禁止|间隔/i.test(String(msg))) {
        log('  命中风控/限流，停止本轮，不重试')
        break
      }
    }
    if (!dryRun) await sleep(12_000)
  }
  log(`完成：成功 ${ok} · 失败 ${fail}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
