/**
 * fal.mjs —— 本地 fal.ai 代理适配器
 *
 * 图片：POST <root>/v1/images/generations（统一用 ref_images，避免 multipart 分叉）
 * 视频：POST <root>/api/generate → 轮询 <root>/api/jobs/<id>（异步队列）
 * 参考图：本地文件先 POST <root>/api/upload 换成 fal CDN URL
 *
 * 这个文件只在 worker 子进程里跑；宿主不直接调生成接口，避免阻塞 dsh 事件循环。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve, extname, basename, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { assetsRoot } from '../store.mjs'

const DEFAULT_MODEL = { t2i: 'fal-flux-schnell', i2i: 'flux-dev-i2i', t2v: 'ltx-video', i2v: 'ltx-video-i2v' }
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }

/** baseUrl 可能带 /v1，也可能只到根；视频的 /api/* 永远在根上 */
export function rootOf(baseUrl) {
  return String(baseUrl || 'http://127.0.0.1:30001/v1').trim().replace(/\/+$/, '').replace(/\/v1$/i, '')
}
const apiOf = (baseUrl) => rootOf(baseUrl) + '/v1'

async function jsonFetch(url, opts = {}, timeout = 120_000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 1000) } }
  if (!r.ok) {
    const msg = body?.error?.message || body?.detail || body?.raw || ('HTTP ' + r.status)
    throw new Error(String(msg).slice(0, 1200))
  }
  return body
}

function safeSlug(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'gen'
}

function resolveLocalRef(ref) {
  const raw = String(ref || '').trim().replace(/\\/g, '/')
  if (!raw) throw new Error('参考图为空')
  if (/^https?:\/\//i.test(raw)) return raw
  if (raw.split('/').some((p) => p === '..' || p === '.')) throw new Error('参考图路径不合法')
  const abs = resolve(assetsRoot(), raw)
  const root = resolve(assetsRoot())
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('参考图不在素材目录内')
  if (!existsSync(abs)) throw new Error('参考图不存在：' + raw)
  return abs
}

async function uploadRef(baseUrl, ref) {
  const local = resolveLocalRef(ref)
  if (/^https?:\/\//i.test(local)) return local
  const buf = readFileSync(local)
  const ext = extname(local).toLowerCase()
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type }), basename(local))
  const j = await jsonFetch(rootOf(baseUrl) + '/api/upload', { method: 'POST', body: fd }, 120_000)
  if (!j?.url) throw new Error('参考图上传失败：代理未返回 url')
  return j.url
}

function extFor(contentType, url, kind) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (IMAGE_EXT[ct]) return IMAGE_EXT[ct]
  if (VIDEO_EXT[ct]) return VIDEO_EXT[ct]
  const u = String(url || '').split('?')[0].toLowerCase()
  for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov']) {
    if (u.endsWith(e)) return e === '.jpeg' ? '.jpg' : e
  }
  return kind === 'video' ? '.mp4' : '.jpg'
}

function probeSeconds(file) {
  try {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    const n = Number(String(r.stdout || '').trim())
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
  } catch { return 0 }
}

function appendIndex(dir, entry) {
  const file = join(dir, 'index.json')
  let arr = []
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(j)) arr = j
  } catch { /* 首次 */ }
  arr.push(entry)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(arr, null, 2))
}

function saveAsset({ job, buf, ext, contentType, billable }) {
  const sub = job.kind === 'video' ? 'videos' : 'images'
  const dir = join(assetsRoot(), 'generated', sub)
  mkdirSync(dir, { recursive: true })
  const base = `${job.id}-${safeSlug(job.title || job.prompt)}`
  let file = `${base}${ext}`
  let i = 1
  while (existsSync(join(dir, file))) { file = `${base}-${i}${ext}`; i++ }
  const abs = join(dir, file)
  writeFileSync(abs, buf)
  const seconds = job.kind === 'video' ? probeSeconds(abs) : 0
  const entry = {
    id: job.id,
    file,
    kind: job.kind,
    origin: 'generated',
    title: job.title || job.prompt.slice(0, 30) || file,
    prompt: job.prompt,
    provider: 'fal',
    model: job.model,
    seed: job.params?.seed ?? null,
    params: job.params || {},
    parentId: job.parentId || '',
    operation: job.mode,
    projectId: job.projectId || '',
    shotId: job.shotId || '',
    phase: job.phase || '',
    takeNo: Number(job.takeNo) || 0,
    keyframeId: job.meta?.keyframeId || '',
    status: 'draft',
    bytes: buf.length,
    seconds,
    contentType: contentType || '',
    billable: billable ?? null,
    createdAt: new Date().toISOString(),
  }
  appendIndex(dir, entry)
  return entry
}

async function download(url, kind) {
  // 视频常有几十 MB；Node fetch 直连 fal CDN 在这台机器上会卡到超时，
  // curl 会走系统 HTTPS_PROXY，稳定得多。curl 不可用时再退回 fetch。
  const tmp = join(tmpdir(), `bili-dl-${process.pid}-${Date.now()}${kind === 'video' ? '.mp4' : '.bin'}`)
  const r = spawnSync('curl', ['-L', '--fail', '--silent', '--show-error', '--max-time', '300', '-o', tmp, url], {
    windowsHide: true, timeout: 320_000,
  })
  if (r.status === 0 && existsSync(tmp)) {
    const buf = readFileSync(tmp)
    try { unlinkSync(tmp) } catch { /* ignore */ }
    if (!buf.length) throw new Error('产物为空')
    const ext = extname(new URL(url).pathname.toLowerCase()) || (kind === 'video' ? '.mp4' : '.jpg')
    const ct = ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime'
      : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { buf, ext: ext === '.jpeg' ? '.jpg' : ext, contentType: ct }
  }
  try { unlinkSync(tmp) } catch { /* ignore */ }
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error('下载产物失败 HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('产物为空')
  return { buf, ext: extFor(res.headers.get('content-type'), url, kind), contentType: res.headers.get('content-type') || '' }
}

function dryRunFile(job) {
  if (job.kind === 'image') {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1kAAAAASUVORK5CYII=',
      'base64',
    )
    return { buf: png, ext: '.png', contentType: 'image/png' }
  }
  const out = join(tmpdir(), `bili-gen-dry-${job.id}.mp4`)
  const r = spawnSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=#101418:s=320x180:d=1',
    '-pix_fmt', 'yuv420p', '-y', out,
  ], { timeout: 30_000, windowsHide: true })
  if (r.status !== 0 || !existsSync(out)) throw new Error('试运行需要 ffmpeg 生成占位视频')
  return { buf: readFileSync(out), ext: '.mp4', contentType: 'video/mp4' }
}

async function runImage(job, hooks) {
  const base = job.baseUrl || process.env.BILI_GENERATION_BASE || 'http://127.0.0.1:30001/v1'
  const model = job.model || DEFAULT_MODEL[job.mode] || DEFAULT_MODEL.t2i
  hooks.stage('准备参考图')
  const refs = []
  for (const r of job.refImages || []) refs.push(await uploadRef(base, r))

  const params = { ...(job.params || {}) }
  delete params.model; delete params.prompt; delete params.ref_images
  const body = { ...params, model, prompt: job.prompt, n: params.n || 1 }
  if (!params.size) body.size = '1024x1024'
  if (refs.length) body.ref_images = refs

  hooks.stage('生成图片')
  const j = await jsonFetch(apiOf(base) + '/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 600_000)
  const list = Array.isArray(j?.data) ? j.data : []
  const first = list[0]
  if (!first?.url) throw new Error('生成接口没有返回图片 URL')
  hooks.stage('下载图片')
  const got = await download(first.url, 'image')
  const asset = saveAsset({ job: { ...job, model }, ...got, billable: j?.fal?.billable_units ?? null })
  return { asset, billable: j?.fal?.billable_units ?? null }
}

async function runVideo(job, hooks) {
  const base = job.baseUrl || process.env.BILI_GENERATION_BASE || 'http://127.0.0.1:30001/v1'
  const model = job.model || DEFAULT_MODEL[job.mode] || DEFAULT_MODEL.t2v
  hooks.stage('准备参考图')
  const refs = []
  for (const r of job.refImages || []) refs.push(await uploadRef(base, r))

  const params = { ...(job.params || {}) }
  delete params.model; delete params.prompt; delete params.ref_images
  const body = { ...params, model, prompt: job.prompt }
  if (refs.length) body.ref_images = refs

  hooks.stage('提交视频任务')
  const created = await jsonFetch(rootOf(base) + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 120_000)
  const upstreamId = String(created?.job_id || '')
  if (!upstreamId) throw new Error('视频任务没有返回 job_id')
  hooks.upstream(upstreamId)

  const deadline = Date.now() + 20 * 60_000
  let last = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    last = await jsonFetch(rootOf(base) + '/api/jobs/' + encodeURIComponent(upstreamId), {}, 60_000)
    const st = String(last?.status || '').toLowerCase()
    hooks.stage(last?.stage || (st === 'queued' ? '排队中' : st === 'running' ? '生成中' : st || '生成中'))
    if (st === 'done') break
    if (st === 'error' || st === 'failed' || st === 'cancelled') {
      throw new Error(String(last?.error || '视频任务失败').slice(0, 1200))
    }
  }
  if (String(last?.status || '').toLowerCase() !== 'done') throw new Error('视频生成超时（20 分钟）')

  const media = Array.isArray(last?.media) ? last.media : []
  const pick = media.find((m) => /video/i.test(String(m?.content_type || '')) || /\.(mp4|webm|mov)(\?|$)/i.test(String(m?.url || '')))
    || media[0]
  if (!pick?.url) throw new Error('视频任务完成但没有产物 URL')
  hooks.stage('下载视频')
  const got = await download(pick.url, 'video')
  const asset = saveAsset({ job: { ...job, model }, ...got, billable: last?.billable ?? null })
  return { asset, billable: last?.billable ?? null }
}

export async function runJob(job, hooks = {}) {
  const stage = typeof hooks.stage === 'function' ? hooks.stage : () => {}
  const upstream = typeof hooks.upstream === 'function' ? hooks.upstream : () => {}
  const h = { stage, upstream }
  if (job.dryRun) {
    stage('试运行：生成本地占位产物')
    const got = dryRunFile(job)
    const asset = saveAsset({ job: { ...job, model: 'dry-run', title: job.title || '试运行产物' }, ...got, billable: 0 })
    return { asset, billable: 0 }
  }
  return job.kind === 'video' ? runVideo(job, h) : runImage(job, h)
}

export async function cancelUpstream(baseUrl, upstreamJobId) {
  const id = String(upstreamJobId || '').trim()
  if (!id) return false
  try {
    await jsonFetch(rootOf(baseUrl) + '/api/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }, 10_000)
    return true
  } catch { return false }
}
