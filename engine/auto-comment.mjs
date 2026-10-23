/**
 * auto-comment.mjs —— 给"今天采到的、还没评论过的视频"自动写评论并发送
 *
 *   node auto-comment.mjs --limit 3 [--mention <UID>] [--dry-run]
 *
 * 规则（按使用者 2026-10-23 的要求）：
 *   · 每天采到的每条视频都留一条评论（评论数由 index.js 按 perDay 剩余额度传 --limit）
 *   · 评论里 @ 主人（--mention 传 UID / 昵称；不传就取当前登录账号的 mid）
 *   · 默认真的发；--dry-run 只打印命令，用于测试
 *   · 生成失败/风控失败都停，不自动重试
 */
import { list } from './store.mjs'
import { runBili } from './bili.mjs'
import * as interact from './interact.mjs'
import { composeText } from './compose-lib.mjs'
import { ownerInfo } from './owner.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (n) => process.argv.includes('--' + n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const localDay = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const log = (s) => console.log(s)

/** @ 谁：优先参数；否则用主人 UID；再否则用当前登录账号的 mid */
function resolveMention(ownerUid) {
  const given = String(arg('mention', '') || '').trim()
  if (given) return given
  if (ownerUid) return ownerUid
  try {
    const r = runBili(['auth', 'status'], { timeoutMs: 20000 })
    return String(r.data?.user?.mid || '')
  } catch { return '' }
}

/** 评论里必须出现对主人的称呼；模型没写就补在开头 */
function ensureOwnerCall(text, call) {
  const t = String(text || '').trim()
  if (!t || !call || t.includes(call)) return t
  return `${call}，${t}`.slice(0, 60)
}

async function main() {
  const dryRun = flag('dry-run')
  const limit = Math.max(1, Math.min(Number(arg('limit', 3)) || 3, 20))
  const owner = ownerInfo()
  const mention = resolveMention(owner.uid)
  const persona = String(process.env.BILI_OP_PERSONA || '')

  const rows = list({ limit: 2000 })
    .filter((r) => localDay(r.fetchedAt) === today() && !interact.isCommented(r.bvid) && r.title)
    .slice(0, limit)

  if (!rows.length) { log('没有需要评论的新视频'); return }
  log(`待评论 ${rows.length} 条${dryRun ? '（dry-run）' : ''}${mention ? ` · @ ${mention}` : ''}${owner.call ? ` · 称呼 ${owner.call}` : ''}`)

  let ok = 0, fail = 0
  for (const rec of rows) {
    const ctx = {
      title: rec.title,
      up: rec.up?.name || '',
      quotes: (rec.quotes || []).slice(0, 3).map((x) => x.text),
      memes: (rec.memes || []).slice(0, 3),
      hotComments: (rec.hotComments || []).slice(0, 3).map((x) => x.text),
      ownerCall: owner.call,
    }
    let text = ''
    try {
      const c = await composeText('comment', ctx, persona)
      text = ensureOwnerCall(c.text, owner.call)
    } catch (e) {
      log(`  ✗ ${rec.bvid} 生成失败：${String(e?.message ?? e).split('\n')[0]}`)
      fail++
      continue
    }
    if (!text) { log(`  ✗ ${rec.bvid} 生成为空`); fail++; continue }

    const args = []
    if (dryRun) args.push('--dry-run')
    args.push('comment', 'post', rec.bvid, text)
    if (mention) args.push('--at', mention)
    const r = runBili(args, { timeoutMs: 60000 })
    if (r.ok) {
      if (!dryRun) interact.markComment(rec.bvid, { rpid: r.data?.rpid || 0, text })
      ok++
      log(`  ✓ ${rec.bvid} ${dryRun ? 'dry-run' : '已评论'}：${text}`)
    } else {
      fail++
      const msg = r.error?.message || r.error?.code || '未知错误'
      log(`  ✗ ${rec.bvid} 发送失败：${msg}`)
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
