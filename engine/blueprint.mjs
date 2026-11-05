/**
 * blueprint.mjs —— 创作方案蓝图
 *
 * 蓝图是“方案确认页”的数据结构：把现有 plan 拆成可编辑的 8 个部分，
 * 用户可以删除某节、让 AI 只改某节、直接替换内容、预览声音/角色/分镜。
 *
 * 只做数据转换；LLM 改单节走 CLI（--revise），由宿主 spawn。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const EDGE = new Set([
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural',
  'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural',
])

const cn = (s) => String(s || '').replace(/\s/g, '').length

function estDuration(narration) {
  return Math.max(2, Math.round(cn(narration) / 4.5))
}

const SECTION_META = [
  ['brief', '项目简报与交付规格', false],
  ['script', '脚本', false],
  ['storyboard', '分镜与镜头表', false],
  ['characters', '角色与视觉风格', true],
  ['voice', '配音与声音', true],
  ['assets', '素材与版权', true],
  ['models', '模型与输出', false],
  ['compliance', '合规与发布', false],
]

function section(id, content, extra = {}) {
  const meta = SECTION_META.find((x) => x[0] === id) || [id, id, true]
  return {
    id, title: meta[1], enabled: true, core: !meta[2], removable: meta[2], content,
    updatedAt: new Date().toISOString(), ...extra,
  }
}

export function deriveBlueprint({ plan, project, cfg = {}, characters = [] }) {
  const shots = Array.isArray(plan?.shots) ? plan.shots : []
  const picks = Array.isArray(plan?.picks) ? plan.picks : []
  const voiceId = String(cfg.voice || plan?.voice || '').trim()
  const generation = cfg.generation || {}
  const chapters = shots.map((s, i) => ({
    n: i + 1,
    shotId: String(i + 1),
    enabled: true,
    kind: s.kind || 'item',
    duration: estDuration(s.narration),
    shotSize: s.kind === 'broll' ? 'WS' : 'MS',
    angle: 'eye level',
    camera: s.kind === 'broll' ? '跟随/平移' : '固定机位',
    lighting: '自然光',
    visual: s.headline || s.body || '',
    narration: s.narration || '',
    ui: s.ui || '',
    onScreenText: s.onScreenText || '',
    audio: s.audio || '',
    onScreen: s.headline || s.sub || '',
    audio: 'VO',
    asset: s.source ? `${s.source.bv} @${Math.round(Number(s.source.t) || 0)}s` : '',
    transition: s.transition || '',
    prompt: s.headline || s.body || '',
    negative: '文字, 水印, 多余手指, 换脸',
    status: 'draft',
  }))

  const sections = [
    section('brief', {
      title: plan?.title || project?.title || '',
      subtitle: plan?.subtitle || '',
      angle: plan?.angle || '',
      brief: plan?.brief || project?.brief || '',
      duration: plan?.stats?.estSeconds || 0,
      aspect: '16:9',
      platform: 'B站',
      language: '简体中文',
      tone: '',
      cta: '',
      budget: '',
    }),
    section('script', {
      logline: plan?.angle || '',
      audioMode: 'voiceover',
      hook: shots[0]?.narration || '',
      lines: shots.map((s) => s.narration || ''),
      onScreen: shots.map((s) => s.headline || s.sub || '').filter(Boolean),
      beats: shots.map((s) => s.kind || 'item'),
      claims: [],
      cta: shots[shots.length - 1]?.narration || '',
      wordCount: shots.reduce((n, s) => n + cn(s.narration), 0),
      readSeconds: plan?.stats?.estSeconds || 0,
    }),
    section('storyboard', { shots: chapters }),
    section('characters', {
      items: characters,
      selected: characters[0]?.id || '',
      style: '',
      palette: '',
      font: '',
      turnaround: '',
      expressions: '',
      seed: '',
    }),
    section('voice', {
      voiceId,
      mode: EDGE.has(voiceId) ? 'edge' : 'clone',
      language: '简体中文',
      speed: 1,
      pronunciation: '',
      bgm: '',
      sfx: '',
      loudness: '-16 LUFS',
    }),
    section('assets', {
      picks: picks.map((p) => ({ bv: p.bv || '', use: p.use || '', why: p.why || '' })),
      missing: Array.isArray(plan?.missing) ? plan.missing : [],
      licenses: [],
      notes: 'B站素材仅用于盘点/评论，控制引用时长；来源不明不用。',
    }),
    section('models', {
      t2i: generation.t2i || '',
      i2i: generation.i2i || '',
      t2v: generation.t2v || '',
      i2v: generation.i2v || '',
      resolution: '1920×1080',
      fps: 30,
      aspect: '16:9',
      motion: 'medium',
      seed: '',
      negative: '文字, 水印, 换脸, 多余肢体',
      retryBudget: 2,
      budget: '',
    }),
    section('compliance', {
      aiDeclaration: '本视频包含 AI 生成内容',
      modelNote: 'AI 模型由用户自行添加',
      rights: '只用自有/授权/二创标注素材',
      privacy: '已检查无隐私信息',
      consent: '声音/肖像已授权（如使用）',
      copyright: 'BGM/字体/贴图/影视片段已确认许可',
      platform: '遵守 B站 AI 内容声明与社区规则',
      audit: '',
      title: plan?.title || project?.title || '',
      tags: cfg.defaultTags || [],
    }),
  ]

  // 保留用户已编辑的 section 内容；新增字段用派生值补全
  const old = new Map(((plan?.blueprint?.sections) || []).map((s) => [s.id, s]))
  const merged = sections.map((s) => {
    const o = old.get(s.id)
    if (!o) return s
    return {
      ...s,
      ...o,
      title: s.title,
      core: s.core,
      removable: s.removable,
      enabled: o.enabled !== false,
      content: (Array.isArray(s.content) || Array.isArray(o.content))
        ? (o.content ?? s.content)
        : { ...s.content, ...(o.content || {}) },
    }
  })
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    approvedAt: plan?.blueprint?.approvedAt || '',
    sections: merged,
  }
}

/** 把蓝图写回 plan：只使用「参与」的章节；关掉的章节保留在蓝图里，随时可恢复 */
export function applyBlueprint(plan, bp) {
  const out = { ...plan, blueprint: bp }
  const get = (id) => (bp?.sections || []).find((s) => s.id === id)
  const on = (id) => {
    const s = get(id)
    return !s || s.enabled !== false
  }

  const brief = get('brief')
  if (brief && brief.enabled !== false && brief.content) {
    if (brief.content.title) out.title = String(brief.content.title).slice(0, 80)
    out.subtitle = String(brief.content.subtitle || out.subtitle || '')
    out.angle = String(brief.content.angle || out.angle || '')
    out.brief = String(brief.content.brief || out.brief || '')
  }

  const sb = get('storyboard')
  const rows = Array.isArray(sb?.content?.shots) ? sb.content.shots : []
  const activeRows = rows.filter((r) => r.enabled !== false)
  if (on('storyboard')) {
    const oldShots = Array.isArray(plan.shots) ? plan.shots : []
    out.shots = activeRows.map((row, i) => {
      const orig = Number(row.shotId)
      const prev = oldShots[Number.isFinite(orig) && orig > 0 ? orig - 1 : i] || oldShots[i] || {}
      const shot = { ...prev, kind: row.kind || prev.kind || 'item', narration: String(row.narration || '') }
      if (row.duration) shot.duration = Math.max(1, Number(row.duration) || prev.duration || 0)
      const visual = String(row.visual || '').trim()
      if (visual) {
        if (['title', 'outro', 'data', 'scene'].includes(shot.kind)) shot.headline = visual.slice(0, 24)
        else {
          shot.headline = visual.slice(0, 22)
          if (visual.length > 22) shot.body = visual.slice(22, 62)
        }
      }
      if (row.transition) shot.transition = String(row.transition).slice(0, 20)
      if (row.ui) shot.ui = String(row.ui).slice(0, 200)
      if (row.onScreenText) shot.onScreenText = String(row.onScreenText).slice(0, 200)
      if (row.audio) shot.audio = String(row.audio).slice(0, 20)
      const m = /^(BV[0-9A-Za-z]{10})\s*@\s*(\d+(?:\.\d+)?)s?/.exec(String(row.asset || ''))
      if (m) shot.source = { ...(prev.source || {}), bv: m[1], t: Number(m[2]) }
      return shot
    })
  } else {
    // 分镜不参与：不伪造分镜，渲染会被明确拦住；内容仍在蓝图里
    out.shots = []
  }

  if (!on('script')) out.shots = (out.shots || []).map((s) => ({ ...s, narration: '' }))
  const scriptSec = get('script')
  if (scriptSec?.content?.audioMode) out.audioMode = String(scriptSec.content.audioMode)

  const ch = get('characters')
  if (ch && ch.enabled !== false) {
    if (ch.content?.selected) out.characterId = ch.content.selected
    if (ch.content?.selected) out.mascot = true
  } else {
    out.mascot = false
  }

  const voice = get('voice')
  if (voice && voice.enabled !== false) {
    if (voice.content?.voiceId) out.voice = String(voice.content.voiceId)
  } else {
    out.voice = ''
  }

  const assets = get('assets')
  if (assets && assets.enabled !== false) {
    out.picks = (assets.content?.picks || []).map((p) => ({
      bv: String(p.bv || ''), use: String(p.use || ''), why: String(p.why || ''),
    })).filter((p) => p.bv)
  } else {
    out.picks = []
  }

  const models = get('models')
  out.aiModelsDisabled = Boolean(models && models.enabled === false)

  const comp = get('compliance')
  out.compliance = comp && comp.enabled !== false ? (comp.content || {}) : {}

  const total = (out.shots || []).reduce((n, s) => n + cn(s.narration), 0)
  const declared = (out.shots || []).reduce((n, s) => n + (Number(s.duration) || 0), 0)
  out.stats = {
    ...(out.stats || {}),
    shotCount: (out.shots || []).length,
    narrationChars: total,
    estSeconds: (out.audioMode && out.audioMode !== 'voiceover' && declared)
      ? Math.round(declared)
      : Math.round(total / 4.5),
  }
  return out
}

/* ── CLI：只改一节 ── */
if (process.argv.includes('--revise')) {
  const arg = (name) => {
    const i = process.argv.indexOf(name)
    return i >= 0 ? process.argv[i + 1] : ''
  }
  const inputFile = arg('--in')
  const outFile = arg('--out')
  try {
    const input = JSON.parse(readFileSync(inputFile, 'utf8'))
    const { loadLLM } = await import('./llmpath.mjs')
    const { chatJSON } = await loadLLM()
    const sec = input.section
    const sys = `你是短视频预制作编辑。只改用户指定的一个部分，其他部分不动。
只输出合法 JSON，不要解释、不要代码块围栏。
规则：
- 用简体中文；口语、短句。
- 分镜里不得编造 BV 号、时间点或素材；沿用已有引用。
- 不写政治、低俗、引战、未核实信息。
- 返回 {"content": <与输入同结构的内容>}。`
    const user = `整片标题：${input.title || ''}
当前部分：${sec?.title || sec?.id}
当前内容：
${JSON.stringify(sec?.content, null, 2)}

修改要求：${input.instruction}

请只返回 {"content": ...}。
如果是 storyboard，保持镜头数量不变，保留每镜的 kind、asset、shotId 和 enabled 字段；只改视觉/运镜/旁白/时长。
如果是 script，保持 lines 数组长度不变，只改文字。
如果是 brief/compliance，保持字段结构不变。`
    const r = await chatJSON([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], { temperature: 0.4, max_tokens: 2400 })
    const content = r?.json?.content ?? r?.json?.section?.content ?? r?.json
    if (!content) throw new Error('模型没有返回 content')
    writeFileSync(outFile, JSON.stringify({ ok: true, content, model: r.model }, null, 2), 'utf8')
  } catch (e) {
    try { writeFileSync(outFile, JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2), 'utf8') } catch { /* ignore */ }
    process.exitCode = 1
  }
}
