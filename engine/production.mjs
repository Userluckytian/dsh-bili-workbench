/**
 * production.mjs —— 方案的两段制作 + 组合
 *
 * 一个方案不拆成两个方案：
 *   方案蓝图确认 → ① 关键帧（图）→ ② 视频（图生视频）→ ③ 组合
 *
 * 这里只做数据与提示词：
 *   · 从蓝图的分镜行派生"每镜要什么图/什么运动"；
 *   · 把生成任务需要的 projectId/shotId/phase/takeNo 一并带上，产物落库后可反查；
 *   · 选中哪条 take 记在 project.production 里，蓝图改版不丢。
 * 真正的生成仍走 generation 队列，组合走 production/assemble.mjs。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetsRoot } from './store.mjs'

const cn = (s) => String(s || '').replace(/\s/g, '').length
const active = (x) => x && x.enabled !== false

export function emptyProduction() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    keyframes: {},
    videos: {},
    assembly: { status: 'idle', runId: '', error: '', at: '' },
  }
}

export function ensureProduction(project) {
  if (!project.production || typeof project.production !== 'object') project.production = emptyProduction()
  const p = project.production
  if (!p.keyframes || typeof p.keyframes !== 'object') p.keyframes = {}
  if (!p.videos || typeof p.videos !== 'object') p.videos = {}
  if (!p.assembly || typeof p.assembly !== 'object') p.assembly = { status: 'idle', runId: '', error: '', at: '' }
  return p
}

/** 当前版本的分镜行：优先用蓝图里用户改过的分镜，保持 shotId 稳定 */
export function shotRows(plan) {
  const secs = plan?.blueprint?.sections || []
  const sb = secs.find((s) => s.id === 'storyboard')
  const scriptOff = secs.find((s) => s.id === 'script')?.enabled === false
  const src = sb?.enabled && Array.isArray(sb.content?.shots) && sb.content.shots.length
    ? sb.content.shots
    : (Array.isArray(plan?.shots) ? plan.shots : []).map((s, i) => ({
      shotId: String(i + 1),
      kind: s.kind || 'item',
      visual: s.headline || s.body || '',
      narration: s.narration || '',
      camera: '',
      duration: Math.max(2, Math.round(cn(s.narration) / 4.5)),
      transition: s.transition || '',
      asset: s.source ? `${s.source.bv} @${Math.round(Number(s.source.t) || 0)}s` : '',
      ui: s.ui || '',
      onScreenText: s.onScreenText || '',
      audio: s.audio || '',
    }))
  return src.map((r, i) => ({
    shotId: String(r.shotId || i + 1),
    n: i + 1,
    kind: r.kind || 'item',
    visual: String(r.visual || ''),
    narration: scriptOff ? '' : String(r.narration || ''),
    camera: String(r.camera || ''),
    duration: Math.max(2, Number(r.duration) || Math.round(cn(r.narration) / 4.5) || 4),
    transition: String(r.transition || ''),
    asset: String(r.asset || ''),
    prompt: String(r.prompt || ''),
    ui: String(r.ui || ''),
    onScreenText: String(r.onScreenText || ''),
    audio: String(r.audio || ''),
    enabled: r.enabled !== false,
  }))
}

const readIndex = (sub) => {
  const f = join(assetsRoot(), 'generated', sub, 'index.json')
  try {
    const a = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(a) ? a : []
  } catch { return [] }
}

const withFile = (kind, x) => ({
  ...x,
  kind,
  path: `generated/${kind === 'video' ? 'videos' : 'images'}/${x.file}`,
})

/** 从素材索引反查这个项目产生的 take（不要求任务写回 project.json） */
export function productionTakes(projectId) {
  const keyframes = {}
  const videos = {}
  for (const x of readIndex('images')) {
    if (x.projectId !== projectId || !x.shotId || x.phase !== 'keyframe') continue
    const id = String(x.shotId)
    ;(keyframes[id] ||= []).push(withFile('image', x))
  }
  for (const x of readIndex('videos')) {
    if (x.projectId !== projectId || !x.shotId || x.phase !== 'video') continue
    const id = String(x.shotId)
    ;(videos[id] ||= []).push(withFile('video', x))
  }
  const sort = (g) => {
    for (const k of Object.keys(g)) {
      g[k].sort((a, b) => (Number(a.takeNo) || 0) - (Number(b.takeNo) || 0)
        || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    }
    return g
  }
  return { keyframes: sort(keyframes), videos: sort(videos) }
}

export function pickCharacter(plan, characters, production) {
  const sec = (plan?.blueprint?.sections || []).find((s) => s.id === 'characters')
  if (sec && sec.enabled === false) return null
  const id = String(sec?.content?.selected || plan?.characterId || production?.characterId || '')
  if (!id) return null
  return (characters || []).find((x) => String(x.id) === id) || null
}

export function modelCfg(plan, cfg) {
  const sec = (plan?.blueprint?.sections || []).find((s) => s.id === 'models')
  const c = sec?.enabled === false ? {} : (sec?.content || {})
  const g = cfg?.generation || {}
  return {
    t2i: c.t2i || g.t2i || 'fal-flux-schnell',
    i2i: c.i2i || g.i2i || 'flux-dev-i2i',
    t2v: c.t2v || g.t2v || 'ltx-video',
    i2v: c.i2v || g.i2v || 'ltx-video-i2v',
    aspect: c.aspect || '16:9',
    motion: c.motion || 'medium',
    seed: c.seed || '',
    negative: c.negative || '文字, 水印, 多余肢体, 换脸',
  }
}

const sizeOf = (aspect) => {
  const a = String(aspect || '16:9')
  if (/9\s*[:：]\s*16/.test(a)) return '720x1280'
  if (/1\s*[:：]\s*1/.test(a)) return '1024x1024'
  return '1280x720'
}

/** 不同模型的入参名不一样；只传代理 schema 里有的，避免上游校验失败 */
function keyframeParams(model, aspect, hasRef) {
  if (/nano-banana/i.test(model)) return { aspect_ratio: aspect, num_images: 1 }
  if (/seedream/i.test(model)) return { size: sizeOf(aspect), num_images: 1 }
  if (/flux/i.test(model)) return { size: sizeOf(aspect), ...(hasRef ? { strength: 0.72 } : {}) }
  return { size: sizeOf(aspect) }
}

function videoParams(model, seconds, negative) {
  const sec = Math.max(3, Math.min(12, Number(seconds) || 5))
  if (/ltx/i.test(model)) {
    return { num_inference_steps: 30, guidance_scale: 3, negative_prompt: negative || '' }
  }
  if (/kling/i.test(model)) {
    return { duration: sec >= 8 ? '10' : '5', negative_prompt: negative || '' }
  }
  if (/seedance/i.test(model)) {
    return { duration: String(Math.round(sec)), resolution: '1080p', aspect_ratio: '16:9' }
  }
  if (/wan/i.test(model)) {
    return { duration: Math.round(sec), resolution: '720p', aspect_ratio: '16:9' }
  }
  if (/veo/i.test(model)) {
    return { duration: sec <= 4 ? '4s' : sec <= 6 ? '6s' : '8s', resolution: '720p', aspect_ratio: '16:9' }
  }
  if (/minimax|hailuo/i.test(model)) {
    return { duration: sec <= 6 ? '6' : '10', resolution: '768P' }
  }
  return {}
}

function scenePrompt(row) {
  return String(row.prompt || row.visual || row.narration || '').trim()
}

export function keyframeSpec({ plan, project, cfg, characters, production, row, takeNo = 1 }) {
  const ch = pickCharacter(plan, characters, production)
  const m = modelCfg(plan, cfg)
  const chSec = (plan?.blueprint?.sections || []).find((s) => s.id === 'characters')
  const style = String(chSec?.content?.style || '写实电影感，柔和自然光，高清细节').trim()
  const palette = String(chSec?.content?.palette || '').trim()
  const refs = ch?.refs?.length ? [ch.refs[0]] : []
  const model = refs.length ? m.i2i : m.t2i
  const custom = production?.keyframes?.[row.shotId]?.prompt
  const base = String(custom || scenePrompt(row) || `第 ${row.n} 镜`).trim()
  const characterLine = ch
    ? `角色「${ch.name || ch.id}」必须与参考图完全一致：${ch.meta?.description || '外形、比例、服装、配色保持不变'}。`
    : ''
  const prompt = [
    characterLine,
    base,
    row.camera ? `镜头：${row.camera}。` : '',
    `画面风格：${style}。`,
    palette ? `配色：${palette}。` : '',
    '16:9 横屏，单张电影感构图，主体清晰；不要文字、水印、拼贴或多格分镜。',
  ].filter(Boolean).join('')
  return {
    kind: 'image',
    mode: refs.length ? 'i2i' : 't2i',
    model,
    prompt,
    refImages: refs,
    params: {
      ...keyframeParams(model, m.aspect, refs.length > 0),
      ...(m.seed ? { seed: Number(m.seed) || m.seed } : {}),
    },
    projectId: project.id,
    shotId: row.shotId,
    phase: 'keyframe',
    takeNo,
    title: `关键帧 ${row.shotId} · ${String(row.visual || row.narration || row.kind).slice(0, 22)}`,
    meta: { shotId: row.shotId, n: row.n, characterId: ch?.id || '' },
  }
}

function videoParamsOld(model, seconds) {
  const sec = Math.max(3, Math.min(12, Number(seconds) || 5))
  if (/ltx/i.test(model)) return { steps: 20, guidance: 3 }
  if (/seedance|kling|wan|veo|minimax|hailuo/i.test(model)) return { duration: sec }
  return {}
}

export function videoSpec({ plan, project, cfg, production, row, keyframe, takeNo = 1 }) {
  const m = modelCfg(plan, cfg)
  const custom = production?.videos?.[row.shotId]?.prompt
  const prompt = String(custom || [
    row.visual,
    row.camera ? `运镜：${row.camera}` : '',
    '人物口型自然开合，动作连贯，镜头稳定，画面连续；不要文字、水印、拼贴。',
  ].filter(Boolean).join('。')).trim()
  const model = m.i2v
  return {
    kind: 'video',
    mode: 'i2v',
    model,
    prompt,
    refImages: [keyframe.path || `generated/images/${keyframe.file}`],
    params: videoParams(model, row.duration, m.negative),
    projectId: project.id,
    shotId: row.shotId,
    phase: 'video',
    takeNo,
    title: `镜头 ${row.shotId} · ${String(row.visual || row.narration || row.kind).slice(0, 22)}`,
    meta: { shotId: row.shotId, n: row.n, keyframeId: keyframe.id || keyframe.file },
  }
}

export function findTake(takes, shotId, assetId) {
  return (takes?.[String(shotId)] || []).find((x) => String(x.id) === String(assetId)) || null
}

/** 组合前检查：每一镜都要选中一条视频 */
export function assemblyCheck(plan, production, takes) {
  const rows = shotRows(plan).filter(active)
  const missing = []
  const ready = []
  for (const row of rows) {
    const sel = production?.videos?.[row.shotId]?.selectedAssetId
    const take = sel ? findTake(takes.videos, row.shotId, sel) : null
    if (take) ready.push({ row, take })
    else missing.push({ shotId: row.shotId, n: row.n, visual: row.visual })
  }
  const seconds = ready.reduce((n, { row }) => n + (Number(row.duration) || 4), 0)
  return { rows, ready, missing, seconds, ok: missing.length === 0 && ready.length > 0 }
}

export function voiceOf(plan, project, cfg) {
  const sec = (plan?.blueprint?.sections || []).find((s) => s.id === 'voice')
  if (sec?.enabled === false) return { enabled: false, voice: '' }
  return {
    enabled: true,
    voice: String(sec?.content?.voiceId || project?.renderVoice || cfg?.voice || 'zh-CN-YunxiNeural'),
  }
}

/** 只允许合并已知字段，避免前端把整份计划写回来 */
export function mergeProduction(project, patch) {
  const p = ensureProduction(project)
  if (!patch || typeof patch !== 'object') return p
  for (const shotId of Object.keys(patch.keyframes || {})) {
    const v = patch.keyframes[shotId] || {}
    p.keyframes[shotId] = {
      ...(p.keyframes[shotId] || {}),
      ...(v.prompt !== undefined ? { prompt: String(v.prompt).slice(0, 2000) } : {}),
      ...(v.selectedAssetId !== undefined ? { selectedAssetId: String(v.selectedAssetId).slice(0, 120) } : {}),
      ...(v.approvedAt !== undefined ? { approvedAt: String(v.approvedAt) } : {}),
    }
  }
  for (const shotId of Object.keys(patch.videos || {})) {
    const v = patch.videos[shotId] || {}
    p.videos[shotId] = {
      ...(p.videos[shotId] || {}),
      ...(v.prompt !== undefined ? { prompt: String(v.prompt).slice(0, 2000) } : {}),
      ...(v.selectedAssetId !== undefined ? { selectedAssetId: String(v.selectedAssetId).slice(0, 120) } : {}),
      ...(v.approvedAt !== undefined ? { approvedAt: String(v.approvedAt) } : {}),
    }
  }
  if (patch.assembly && typeof patch.assembly === 'object') {
    p.assembly = {
      ...p.assembly,
      ...(patch.assembly.voice !== undefined ? { voice: Boolean(patch.assembly.voice) } : {}),
      ...(patch.assembly.bgm !== undefined ? { bgm: String(patch.assembly.bgm).slice(0, 200) } : {}),
    }
  }
  p.updatedAt = new Date().toISOString()
  return p
}
