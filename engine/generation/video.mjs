/**
 * video.mjs —— 标准 OpenAI 风格「视频生成」适配器
 *
 * 只认三件事，不含任何具体服务商的特有路径：
 *   POST <api>/videos/generations        提交，回 { id }
 *   GET  <api>/videos/generations/{id}   轮询，status: queued|running|succeeded|failed
 *   GET  <api>/videos/generations/{id}/content   取成片（支持 Range）
 *
 * 兼容点：
 *   · baseUrl 写成 http://host:port 或 http://host:port/v1 都行（统一补 /v1）
 *   · 成片地址取 content_url（可能是相对路径，按 baseUrl 根拼绝对）
 *     也兼容 video_url / url / data[0].url 等常见字段
 *   · 鉴权可选：配了 apiKey 就带 Authorization: Bearer
 *
 * 只在 worker 子进程里跑，不阻塞宿主事件循环。
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }

/** 根（去掉结尾 /v1） */
export function rootOf(baseUrl) {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '')
}

/** API 前缀：<root>/v1 */
export const apiOf = (baseUrl) => rootOf(baseUrl) + '/v1'

/** 统一拼鉴权头（没配 key 就空） */
function authHeaders(apiKey) {
  const k = String(apiKey || '').trim()
  return k ? { authorization: `Bearer ${k}` } : {}
}

async function jsonFetch(url, opts = {}, timeout = 120_000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 1000) } }
  if (!r.ok) {
    const msg = body?.error?.message || body?.error || body?.detail || body?.raw || ('HTTP ' + r.status)
    throw new Error(String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 1200))
  }
  return body
}

/** 相对 content_url → 绝对；已经是绝对就原样返回 */
export function absolutize(url, baseUrl) {
  const u = String(url || '').trim()
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  if (u.startsWith('/')) return rootOf(baseUrl) + u
  return rootOf(baseUrl) + '/' + u
}

/** 从各种可能的返回结构里抽出任务 id */
function pickTaskId(j) {
  return String(j?.id || j?.task_id || j?.data?.[0]?.id || j?.job_id || '')
}

/** 从各种可能的返回结构里抽出成片地址 */
function pickVideoUrl(j, baseUrl) {
  const raw =
    j?.content_url
    || j?.video_url
    || j?.url
    || j?.data?.[0]?.url
    || j?.data?.[0]?.content_url
    || j?.output?.video_url
    || j?.result?.video_url
    || ''
  return absolutize(raw, baseUrl)
}

const STATUS_OK = new Set(['succeeded', 'success', 'completed', 'done', 'finished'])
const STATUS_BAD = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected'])

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase()
  if (STATUS_OK.has(v)) return 'succeeded'
  if (STATUS_BAD.has(v)) return 'failed'
  if (v === 'queued' || v === 'pending' || v === 'submitted') return 'queued'
  if (v === 'running' || v === 'processing' || v === 'in_progress' || v === 'generating') return 'running'
  return v
}

/** 参考图：优先直接发 base64（标准请求体里就有 image_base64 字段），避免依赖上传端点 */
function refAsBase64(job) {
  const refs = Array.isArray(job.refImages) ? job.refImages : []
  if (!refs.length) return ''
  const raw = String(refs[0] || '').trim()
  if (/^https?:\/\//i.test(raw)) return ''
  if (!existsSync(raw)) return ''
  const ext = extname(raw).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(raw).toString('base64')}`
}

async function download(url, apiKey) {
  // 成片常有几十 MB；curl 走系统代理更稳，失败再退回 fetch
  const tmp = join(tmpdir(), `bili-vid-${process.pid}-${Date.now()}.mp4`)
  const args = ['-L', '--fail', '--silent', '--show-error', '--max-time', '600', '-o', tmp]
  if (apiKey) args.push('-H', `Authorization: Bearer ${apiKey}`)
  args.push(url)
  const r = spawnSync('curl', args, { windowsHide: true, timeout: 620_000 })
  if (r.status === 0 && existsSync(tmp)) {
    const buf = readFileSync(tmp)
    try { unlinkSync(tmp) } catch { /* ignore */ }
    if (!buf.length) throw new Error('成片为空')
    return { buf, ext: '.mp4', contentType: 'video/mp4' }
  }
  try { unlinkSync(tmp) } catch { /* ignore */ }
  const res = await fetch(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(600_000) })
  if (!res.ok) throw new Error('下载成片失败 HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('成片为空')
  const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  return { buf, ext: VIDEO_EXT[ct] || '.mp4', contentType: ct || 'video/mp4' }
}

/**
 * 提交 + 轮询 + 下载。返回 { got, upstreamId, billable }
 * hooks.stage(text) 推进度；hooks.upstream(id) 记上游 id 供取消
 */
export async function runOpenAiVideo(job, hooks = {}) {
  const stage = typeof hooks.stage === 'function' ? hooks.stage : () => {}
  const upstream = typeof hooks.upstream === 'function' ? hooks.upstream : () => {}
  const base = job.baseUrl || ''
  if (!base) throw new Error('没有配置生成服务地址（设置 → 模型与生成）')
  const apiKey = job.apiKey || ''

  const model = String(job.model || '').trim()
  if (!model) throw new Error('没有为图生视频/文生视频配模型（设置 → 模型与生成）')

  const params = { ...(job.params || {}) }
  delete params.model; delete params.prompt; delete params.apiKey

  const body = { model, prompt: job.prompt }
  // 参考图：标准字段 image_base64 / image_url
  const b64 = refAsBase64(job)
  if (b64) body.image_base64 = b64
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    body[k] = v
  }

  stage('提交视频任务')
  const created = await jsonFetch(apiOf(base) + '/videos/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify(body),
  }, 180_000)

  const taskId = pickTaskId(created)
  if (!taskId) throw new Error('提交后没有返回任务 id')

  // 有的服务提交即完成（同步返回成片）
  const immediate = pickVideoUrl(created, base)
  if (immediate && normalizeStatus(created?.status) === 'succeeded') {
    stage('下载成片')
    const got = await download(immediate, apiKey)
    return { got, upstreamId: taskId, billable: null, model }
  }

  upstream(taskId)

  const deadline = Date.now() + 30 * 60_000
  let last = null
  let lastStatus = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    last = await jsonFetch(apiOf(base) + '/videos/generations/' + encodeURIComponent(taskId), {
      headers: authHeaders(apiKey),
    }, 60_000)
    lastStatus = normalizeStatus(last?.status)
    if (lastStatus === 'queued') stage('排队中')
    else if (lastStatus === 'running') stage(last?.stage || '生成中')
    if (lastStatus === 'succeeded') break
    if (lastStatus === 'failed') {
      throw new Error(String(last?.error || last?.message || '视频任务失败').slice(0, 1200))
    }
  }
  if (lastStatus !== 'succeeded') throw new Error('视频生成超时（30 分钟）')

  const url = pickVideoUrl(last, base)
  if (!url) throw new Error('任务完成但没有成片地址')

  stage('下载成片')
  const got = await download(url, apiKey)
  return { got, upstreamId: taskId, billable: last?.billable ?? null, model }
}

/** 取消：尽力而为，服务不支持就算了 */
export async function cancelUpstream(baseUrl, apiKey, id) {
  const taskId = String(id || '').trim()
  if (!taskId) return false
  try {
    await jsonFetch(apiOf(baseUrl) + '/videos/generations/' + encodeURIComponent(taskId) + '/cancel', {
      method: 'POST',
      headers: authHeaders(apiKey),
    }, 10_000)
    return true
  } catch { return false }
}

/** 探活：GET <api>/models，回 { ok, models } */
export async function listModels(baseUrl, apiKey) {
  const r = await fetch(apiOf(baseUrl) + '/models', {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`)
  let j = {}
  try { j = JSON.parse(text) } catch { throw new Error('端点返回的不是 JSON') }
  const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
  return rows.map((m) => ({ id: String(m?.id || m?.name || ''), desc: String(m?.description || '') })).filter((m) => m.id)
}
