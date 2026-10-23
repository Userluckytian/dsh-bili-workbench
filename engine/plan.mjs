/**
 * plan.mjs —— 给一句"我想做什么样的片子"，让它自己从素材库里找料并出方案
 *
 *   node plan.mjs "做一期 iPhone 折叠屏的资讯盘点，轻松点" [--limit 40]
 *
 * 做三件事：
 *   ① 把素材库的**索引**（标题/UP/档位/字数/金句时间点）喂给模型
 *   ② 模型挑素材 + 写分镜（每镜旁白），并指明引用哪条素材的哪个时间点
 *   ③ 校验 + 对齐时间戳（把模型给的时间吸附到真实字幕句子上）→ 落盘 plans/
 *
 * 产物：bili-store/plans/<时间戳>.json
 * 注意：**这一步不渲染**。渲染由 index.js 的 /render/start → engine/render.mjs → bili-op/build.mjs 接。
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { list, STORE, paths } from './store.mjs'
import { chatJSON, assertKey } from '../../bili-op/llm.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const KINDS = new Set(['title', 'item', 'data', 'outro'])
const cn = (s) => String(s || '').replace(/\s/g, '').length
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`

const SYSTEM = `你是 B站「资讯盘点」的编导。你手上有一个素材库索引，用户说一句想做什么样的片子，你要：
① 从索引里挑出合适的素材（只挑真的能支撑这一期的）
② 写一期 60–90 秒的分镜脚本，每镜一段口语旁白
③ 每一镜尽可能绑定一条素材的**具体时间点**（用索引里给的秒数），方便后面画面直接截那一帧

只输出 JSON，不要解释、不要代码块围栏。所有文字用简体中文，旁白要口语、短句。`

/** 人设（偏好里填的 personaPrompt）：只影响措辞，不影响结构 */
function personaLine() {
  const p = String(process.env.BILI_OP_PERSONA || arg('persona', '')).trim()
  return p ? `\n\n【人设 / 口径】${p}\n写标题、点评和旁白都按这个人设说话。` : ''
}

function buildPrompt(brief, rows, limit, revise = null) {
  const lines = rows.slice(0, limit).map((r, i) => {
    const q = (r.quotes || []).slice(0, 3).map((x) => `${Math.round(x.t)}s「${x.text.slice(0, 18)}」`).join(' / ')
    return `${i + 1}. ${r.bvid} | ${String(r.title).slice(0, 40)} | ${r.up?.name || '?'} | ${Math.round((r.duration || 0) / 60)}分 | ${r.judge?.tier || '未判定'} | ${r.subtitle?.chars || 0}字`
      + (q ? ` | 可用片段：${q}` : '')
  }).join('\n')

  const reviseBlock = revise
    ? `\n\n上一版方案（JSON，只需要按下面的指令改它，不要推翻重来）：\n${JSON.stringify(revise, null, 2).slice(0, 12000)}\n\n这次的修改指令：${brief}\n输出里必须多一个 "changed" 字段，用一句话说清这版改了什么（≤40字）。`
    : ''

  return `用户想做：${brief}

素材库索引（${rows.length} 条，只用这些）：
${lines}
${reviseBlock}

请输出：
{
  "title": "本期标题（≤20字）",
  "subtitle": "副标题（≤24字）",
  "angle": "一句话说你打算怎么串（≤30字）"${revise ? ',\n  "changed": "这版改了什么（≤40字）"' : ''},
  "picks": [
    { "bv": "索引里的 BV 号", "why": "为什么选它（≤20字）", "use": "标题" | "数据" | "画面" | "观点" }
  ],
  "shots": [
    { "kind": "title", "headline": "…", "sub": "…", "narration": "30–45字口语" },
    { "kind": "item", "headline": "≤16字", "body": "≤40字", "badge": "2–4字", "narration": "30–45字",
      "source": { "bv": "BV…", "t": 39 } },
    { "kind": "data", "headline": "…", "stats": [{ "label": "≤6字", "value": "≤10字" }], "narration": "…" },
    { "kind": "outro", "headline": "…", "sub": "…", "narration": "…" }
  ]
}

硬性要求：
- picks 至少 3 条，必须来自上面的索引，不许编 BV 号
- shots 里每个 item 镜**尽量**带 source（bv + t），t 用索引里出现的秒数或你判断的关键时刻
- 全部 narration 加起来 260–380 个汉字
- 旁白别写「首先/其次/综上」这种作文腔`
}

/** 把模型给的秒数吸附到真实字幕句子起点（±6 秒内最近的） */
function snapToSubtitle(bv, t) {
  try {
    const f = paths(bv).subs
    if (!existsSync(f)) return { t: Number(t) || 0, text: '', snapped: false }
    const items = JSON.parse(readFileSync(f, 'utf8')).items || []
    if (!items.length) return { t: Number(t) || 0, text: '', snapped: false }
    let best = null
    for (const it of items) {
      const d = Math.abs(Number(it.from) - Number(t))
      if (best === null || d < best.d) best = { d, it }
    }
    if (best && best.d <= 6) return { t: Number(best.it.from), text: best.it.content, snapped: true }
    return { t: Number(t) || 0, text: '', snapped: false }
  } catch { return { t: Number(t) || 0, text: '', snapped: false } }
}

function normalize(json, rows) {
  const byBv = new Map(rows.map((r) => [r.bvid, r]))
  const picks = (Array.isArray(json.picks) ? json.picks : [])
    .map((p) => ({ bv: String(p.bv || ''), why: String(p.why || '').slice(0, 40), use: String(p.use || '').slice(0, 6) }))
    .filter((p) => byBv.has(p.bv))
  if (picks.length < 2) throw new Error('模型没从库里挑出足够素材（<2 条）')

  const shots = []
  for (const [i, s] of (json.shots || []).entries()) {
    const kind = String(s.kind || '')
    if (!KINDS.has(kind)) throw new Error(`第 ${i + 1} 镜 kind 不认识：${kind}`)
    const narration = String(s.narration || '').replace(/\s+/g, ' ').trim()
    if (cn(narration) < 8) throw new Error(`第 ${i + 1} 镜旁白太短`)
    const shot = { kind, narration }
    if (kind === 'title' || kind === 'outro') {
      shot.headline = String(s.headline || '').slice(0, 24)
      shot.sub = String(s.sub || '').slice(0, 30)
    } else if (kind === 'item') {
      shot.headline = String(s.headline || '').slice(0, 22)
      shot.body = String(s.body || '').slice(0, 48)
      shot.badge = String(s.badge || '').slice(0, 6)
    } else if (kind === 'data') {
      shot.headline = String(s.headline || '').slice(0, 22)
      shot.stats = (Array.isArray(s.stats) ? s.stats : [])
        .map((x) => ({ label: String(x?.label || '').slice(0, 8), value: String(x?.value || '').slice(0, 12) }))
        .filter((x) => x.label && x.value).slice(0, 4)
    }
    // 绑定素材
    const srcBv = String(s?.source?.bv || '')
    if (byBv.has(srcBv)) {
      const snap = snapToSubtitle(srcBv, Number(s?.source?.t) || 0)
      shot.source = { bv: srcBv, t: snap.t, quote: snap.text, snapped: snap.snapped, frame: 'auto' }
    }
    shots.push(shot)
  }
  if (!shots.length) throw new Error('没有可用镜头')
  if (shots[0].kind !== 'title') throw new Error('第 1 镜必须是 title')
  if (shots[shots.length - 1].kind !== 'outro') throw new Error('最后一镜必须是 outro')

  const total = shots.reduce((n, s) => n + cn(s.narration), 0)
  if (total < 150 || total > 560) throw new Error(`旁白总字数 ${total} 不在合理区间`)

  return {
    title: String(json.title || '').slice(0, 24) || shots[0].headline,
    subtitle: String(json.subtitle || '').slice(0, 30),
    angle: String(json.angle || '').slice(0, 60),
    changed: String(json.changed || '').slice(0, 120),
    picks,
    shots,
    stats: {
      shotCount: shots.length,
      narrationChars: total,
      estSeconds: Math.round(total / 4.5),
      withSource: shots.filter((s) => s.source).length,
      snapped: shots.filter((s) => s.source?.snapped).length,
    },
  }
}

async function main() {
  assertKey()
  const reviseFile = arg('revise', '')
  const instruction = arg('instruction', '')
  const brief = reviseFile
    ? String(instruction || '').trim()
    : (process.argv[2] && !process.argv[2].startsWith('--') ? String(process.argv[2]) : '')
  if (!brief) { console.error('用法: node plan.mjs "想做一期什么样的片子" [--limit 40] [--out file]\n      node plan.mjs --revise <上一版.json> --instruction "第 5 条换个素材" [--out file]'); process.exit(2) }
  const limit = Math.max(5, Math.min(Number(arg('limit', 40)) || 40, 120))

  let prev = null
  if (reviseFile) {
    if (!existsSync(reviseFile)) { console.error('上一版方案不存在：' + reviseFile); process.exit(2) }
    prev = JSON.parse(readFileSync(reviseFile, 'utf8'))
  }

  const rows = list({ limit: 2000 }).filter((r) => (r.subtitle?.chars || 0) > 0 || (r.quotes || []).length)
  if (!rows.length) { console.error('素材库里还没有可用素材（需要字幕或可用片段）'); process.exit(3) }

  console.log(reviseFile ? `改一版：${brief}` : `新方案：${brief}`)
  console.log(`素材候选 ${rows.length} 条（带字幕/片段），喂给模型前 ${Math.min(rows.length, limit)} 条`)
  const t0 = Date.now()
  const { json, model } = await chatJSON(
    [{ role: 'system', content: SYSTEM + personaLine() }, { role: 'user', content: buildPrompt(brief, rows, limit, prev) }],
    { maxTokens: 3500, temperature: 0.55 },
  )
  const plan = normalize(json, rows)
  plan.brief = prev?.brief || brief
  plan.instruction = reviseFile ? brief : ''
  plan.model = model
  plan.createdAt = new Date().toISOString()
  if (reviseFile && !plan.changed) plan.changed = '按指令改了这一版'

  const out = arg('out', '')
  let file
  if (out) {
    const abs = resolve(out)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(plan, null, 2), 'utf8')
    file = abs
  } else {
    const dir = join(STORE, 'plans')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8')
  }

  console.log(`\n模型：${model}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  console.log(`标题：${plan.title}`)
  console.log(`角度：${plan.angle}`)
  console.log(`选料 ${plan.picks.length} 条：`)
  for (const p of plan.picks) console.log(`  · ${p.bv}（${p.use}）${p.why}`)
  console.log(`分镜 ${plan.stats.shotCount} 镜 · 旁白 ${plan.stats.narrationChars} 字 ≈ ${plan.stats.estSeconds} 秒 · 绑定素材 ${plan.stats.withSource} 镜（吸附字幕 ${plan.stats.snapped}）`)
  for (const s of plan.shots) {
    const src = s.source ? ` ← ${s.source.bv} @ ${mmss(s.source.t)}${s.source.quote ? '「' + s.source.quote.slice(0, 14) + '」' : ''}` : ''
    console.log(`  [${s.kind}] ${s.headline || ''} · ${cn(s.narration)}字${src}`)
  }
  console.log(`\nPLAN_FILE=${file}`)
}

main().catch((e) => { console.error('失败：' + (e?.message ?? e)); process.exit(1) })
