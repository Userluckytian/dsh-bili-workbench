/**
 * dsh-bili-workbench —— 宿主半端
 * ============================================================================
 * 一个插件 = 素材库 + 刷B站 + 出片 + 审核发布 + 互动。
 * 这一层只做三件事：调 bili 命令、读写素材库、把采集/判定/日报/出片当成子进程编排。
 *
 * 为什么子进程：采集要跑几条 bili 命令、判定要调模型、出片要几分钟 CPU —— 都在
 * 独立进程里做，卡住/崩了都不会带走 dsh 宿主。
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync,
  createReadStream, createWriteStream, unlinkSync, cpSync,
} from 'node:fs'
import { join, dirname, resolve, sep, isAbsolute, extname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runBiliAsync, fetchCover, biliBin } from './engine/bili.mjs'
import {
  list as storeList, get as storeGet, stats as storeStats, STORE, paths as storePaths,
  setStoreRoot, defaultStorePath, locationFile, assetsRoot, todayCount as storeTodayCount,
} from './engine/store.mjs'
import * as plans from './engine/planstore.mjs'
import * as renders from './engine/render.mjs'
import * as interact from './engine/interact.mjs'
import * as tasks from './engine/taskstore.mjs'
import { answerOwnerCommandDetailed, auditMessage, refusalText, mentionTargets, callNames } from './engine/owner.mjs'
import { voiceOwnerStats } from './engine/owner-voice.mjs'
import * as canon from './engine/canon.mjs'
import * as memory from './engine/memory.mjs'
import * as genStore from './engine/generation/jobstore.mjs'
import { cancelUpstream as cancelGenUpstream } from './engine/generation/fal.mjs'
import { deriveBlueprint, applyBlueprint } from './engine/blueprint.mjs'
import * as prod from './engine/production.mjs'
import { runReflect } from './engine/reflect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(HERE, 'engine')
const BILI_OP = process.env.BILI_OP_DIR
  || (existsSync(join(HERE, 'bili-op', 'build.mjs')) ? join(HERE, 'bili-op') : join(HERE, '..', 'bili-op'))
const configFile = () => join(STORE, 'config.json')

/** 路径安全：文件名/runId 禁止含路径分隔符、.. 或为空（防路径穿越） */
function safeName(s) {
  const v = String(s ?? '').trim()
  if (!v || /[\\/]|\.\./.test(v)) return ''
  return v
}
const scheduleFile = () => join(STORE, 'schedule.json')
const logFile = () => join(STORE, 'duty.log')

export const name = 'bili-workbench'
export const inject = ['webServer']

const BV_RE = /^BV[0-9A-Za-z]{10}$/
const ZONES = new Set(['all', 'anime', 'music', 'dance', 'game', 'knowledge', 'tech', 'sports', 'car',
  'life', 'food', 'animal', 'kichiku', 'fashion', 'ent', 'film', 'original', 'rookie'])
const TIERS = new Set(['值得看', '可以看', '跳过'])
const VOICES = new Set(['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural',
  'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural'])

// 2026-11-05：按 40080 当前 /v1/models 重拉。旧链路里的 qw2api/*、mmxproxy/*、
// loomy/* 已不在上游目录（model_not_found），全部移除。
// 顺序按实测可用性排：pulse / deepseek / glm 优先；beam-free 有地区限制放最后。
const DEFAULT_CHAIN = [
  'pulse-alpha-free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free',
  'mimo-v2.6-flash-free', 'big-pickle', 'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free', 'crouton-alpha-free', 'flint-40b-free',
  'beam-free',
]

// 识图子智能体的链：2026-11-05 实测真能吃图且本机可用的 5 个。
// crouton-alpha-free 虽然声明支持图，但本机 403（地区限制），不进默认。
const DEFAULT_VISION_CHAIN = [
  'pulse-alpha-free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free',
  'mimo-v2.6-flash-free', 'nemotron-3.5-super-vl-free',
]

const DEFAULT_PERSONA = '用自然、友好的口吻说话，像个懂视频的热心观众；夸要具体，批评讲道理。'

const DEFAULTS = {
  enabled: false,
  keywords: [],
  llmKey: '',                    // 模型密钥（留空则读环境变量 OC_API_KEY）
  /* 日常：只按时段 + 每天上限平均分配 */
  scheduleRanges: '00:00-24:00', // 多段：09:00-12:00, 20:00-23:30
  perDay: 48,                    // 每天最多采几条（同时是自动评论的每日上限）
  frameCount: 10,                // 每条最多抽 10 帧（AI 挑）
  /* 偏好 */
  personaPrompt: DEFAULT_PERSONA,
  /* 自己的视频：从 B站 合集缓存「日常短片」，注入评论/回复/方案 */
  selfVideosEnabled: true,
  selfVideosUrl: '',             // 合集链接，如 https://space.bilibili.com/<mid>/lists/<seasonId>
  selfVideosRefreshHours: 24,
  reportLevel: 'full',           // full | brief | off
  /* 记忆（策展式长期记忆）：USER.md 主人偏好 / MEMORY.md 工作台事实 */
  memoryEnabled: true,
  userCharLimit: 1375,
  memoryCharLimit: 2200,
  reflectEnabled: true,          // 任务后自动复盘：从经历里提炼主人习惯写进记忆
  memoryEventsMax: 800,          // 经验事件流保留条数（90 天过期）
  favFolderId: '',               // 判定为「值得看」时自动收藏到哪个收藏夹（留空不收藏）
  /* 互动：默认关；打开后按配置自动执行（本机实例已单独打开） */
  autoComment: false,
  autoReply: false,
  ownerUid: '',                  // 主人 B站 UID；只有这个 UID 的指令会被特殊处理
  ownerUids: [],                 // 额外主人 UID（数组；ownerUid 永远算），用于多账号
  ownerCall: '老弟',              // 评论/回复里怎么称呼主人
  mentionName: '',               // 额外 @ 谁；留空=主人 UID / 当前登录账号
  mentions: [],                  // [{ target: UID/昵称, call: 称呼 }]，可多人
  replyPerDay: 20,
  commentImageEvery: 5,          // 自动评论每 N 条带 1 张表情包（0=关）
  /* 主人 @ 任务：看视频 / 看评论 / 要总结 */
  ownerTasksEnabled: true,
  ownerTaskPollMinutes: 3,       // 每几分钟看一次 @
  ownerTaskPerDay: 10,           // 每天最多处理几个
  ownerTaskAllowDm: true,        // 长总结用私信交付
  ownerTaskMaxAgeHours: 72,      // 只处理 72 小时内的 @，避免首次启动把旧消息全跑一遍
  // 公开版默认关：陌生人 @ 会真的在评论区回话，属于对外可见行为，
  // 新装用户应当自己判断要不要开（设置 → 互动 → 别人 @ 它）。
  publicMentionsEnabled: false,  // 非主人 @ 也先看视频再回答（评论区短答，不私信）
  publicMentionPerDay: 20,       // 非主人 @ 每日上限（0=关）
  mentionVision: true,           // @ 任务抽帧看画面（视觉模型）
  dmWatch: false,
  dmWatchMinutes: 5,
  dmReplyPerDay: 0,              // 0 = 不限条数（仍只回主人/互关）
  dmOwnerUid: '',
  /* 出片 */
  voice: 'zh-CN-YunxiNeural',
  /* 生成服务（本地 fal.ai 代理 / 任意 OpenAI 兼容端点） */
  generation: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:30001/v1',
    t2i: 'fal-flux-schnell',
    i2i: 'flux-dev-i2i',
    t2v: 'ltx-video',
    i2v: 'ltx-video-i2v',
  },
  modelChain: DEFAULT_CHAIN,
  // 识图子智能体的模型链（独立于主链）：只有声明支持图片的模型才有意义
  visionChain: [...DEFAULT_VISION_CHAIN],
  concurrency: 4,
  /* 发布 */
  publishEnabled: false,
  defaultTags: ['资讯', '盘点'],
  defaultZone: 0,
}

/* ───────────── 小工具 ───────────── */
const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}\n`
  try { mkdirSync(STORE, { recursive: true }); writeFileSync(logFile(), line, { flag: 'a' }) } catch { /* 写不进就算了 */ }
}

const readJson = (f, dflt) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
const writeJson = (f, obj) => {
  try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8') } catch { /* ignore */ }
}
const localDay = (iso) => {
  try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
}
const today = () => new Date().toLocaleDateString('sv-SE')
const clampNum = (v, min, max, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : dflt
}

/** 时段解析：'00:00-24:00'，可多段、可跨零点 */
export function parseRanges(str) {
  return String(str || '').split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s)
      if (!m) return null
      const toMin = (h, mm) => Math.max(0, Math.min(Number(h) * 60 + Number(mm), 1440))
      return { start: toMin(m[1], m[2]), end: toMin(m[3], m[4]) }
    })
    .filter(Boolean)
}

export function inRanges(str, d = new Date()) {
  const ranges = parseRanges(str)
  if (!ranges.length) return true
  const cur = d.getHours() * 60 + d.getMinutes()
  return ranges.some((r) => (r.start <= r.end ? cur >= r.start && cur < r.end : cur >= r.start || cur < r.end))
}

/** 把跨零点时段拆成两段，方便算"今天已经过多少" */
function rangeSegments(str) {
  const out = []
  for (const r of parseRanges(str)) {
    if (r.start <= r.end) out.push({ start: r.start, end: r.end })
    else { out.push({ start: r.start, end: 1440 }); out.push({ start: 0, end: r.end }) }
  }
  return out
}

/** 当前时段里：总分钟 / 已过分钟 / 是否在时段内 */
export function rangeProgress(str, d = new Date()) {
  const segs = rangeSegments(str)
  const cur = d.getHours() * 60 + d.getMinutes()
  let total = 0, elapsed = 0, inWindow = false
  for (const s of segs) {
    total += Math.max(0, s.end - s.start)
    if (cur < s.start) continue // 没到的段（含跨零点拆出的次日段）不算已过
    elapsed += cur >= s.end ? s.end - s.start : cur - s.start
    if (cur >= s.start && cur < s.end) inWindow = true
  }
  return { total, elapsed, inWindow }
}

/** 按当前时段和每日上限，算出今天"此刻应该已经采了几条" */
function targetToday(cfg, d = new Date()) {
  const p = rangeProgress(cfg.scheduleRanges, d)
  if (!p.inWindow || p.total <= 0) return 0
  return Math.min(cfg.perDay, Math.round(cfg.perDay * p.elapsed / p.total))
}

// 走 store.mjs 的 30 秒按日缓存：/config 高频轮询不再每次全量扫盘
const collectedToday = () => storeTodayCount()

function normalizeCfg(c) {
  const out = { ...DEFAULTS, ...(c || {}) }
  // 旧字段不再使用，落盘时顺手清掉
  for (const k of ['intervalMinutes', 'perRound', 'mode', 'autoJudge', 'autoDaily',
    'commentPerRound', 'commentPerDay', 'replyToComments', 'replyPerRound',
    'dmMode', 'dmUid', 'interactDryRun']) delete out[k]

  out.enabled = Boolean(out.enabled)
  out.perDay = clampNum(out.perDay, 1, 500, 48)
  out.frameCount = clampNum(out.frameCount, 1, 10, 10)
  out.keywords = (Array.isArray(out.keywords) ? out.keywords : []).map(String).filter(Boolean).slice(0, 20)
  out.llmKey = String(out.llmKey || '').slice(0, 300)
  out.scheduleRanges = parseRanges(out.scheduleRanges).length ? String(out.scheduleRanges) : '00:00-24:00'
  out.personaPrompt = String(out.personaPrompt ?? DEFAULT_PERSONA).slice(0, 1200)
  out.selfVideosEnabled = out.selfVideosEnabled !== false
  out.selfVideosUrl = String(out.selfVideosUrl || '').trim().slice(0, 300)
  out.selfVideosRefreshHours = clampNum(out.selfVideosRefreshHours, 1, 720, 24)
  out.reportLevel = ['full', 'brief', 'off'].includes(out.reportLevel) ? out.reportLevel : 'full'
  out.memoryEnabled = out.memoryEnabled !== false
  out.userCharLimit = clampNum(out.userCharLimit, 200, 6000, 1375)
  out.memoryCharLimit = clampNum(out.memoryCharLimit, 200, 10000, 2200)
  out.reflectEnabled = out.reflectEnabled !== false
  out.memoryEventsMax = clampNum(out.memoryEventsMax, 100, 5000, 800)
  out.favFolderId = String(out.favFolderId || '').slice(0, 60)
  out.autoComment = out.autoComment !== false
  out.autoReply = out.autoReply !== false
  out.ownerUid = String(out.ownerUid || '').trim().slice(0, 20)
  out.ownerUids = (Array.isArray(out.ownerUids) ? out.ownerUids : String(out.ownerUids || '').split(/[\s,，]+/))
    .map((x) => String(x?.uid || x || '').trim().slice(0, 20))
    .filter(Boolean)
    .slice(0, 5)
  out.ownerCall = String(out.ownerCall || '老弟').trim().slice(0, 10) || '老弟'
  out.mentionName = String(out.mentionName || '').slice(0, 40)
  out.mentions = (Array.isArray(out.mentions) ? out.mentions : [])
    .map((m) => ({ target: String(m?.target || '').trim().slice(0, 60), call: String(m?.call || '').trim().slice(0, 10) }))
    .filter((m) => m.target)
    .slice(0, out.ownerUid ? 2 : 3)
  out.replyPerDay = clampNum(out.replyPerDay, 0, 200, 20)
  out.commentImageEvery = clampNum(out.commentImageEvery, 0, 50, 5)
  out.ownerTasksEnabled = out.ownerTasksEnabled !== false
  out.ownerTaskPollMinutes = clampNum(out.ownerTaskPollMinutes, 1, 60, 3)
  out.ownerTaskPerDay = clampNum(out.ownerTaskPerDay, 1, 50, 10)
  out.ownerTaskAllowDm = out.ownerTaskAllowDm !== false
  out.ownerTaskMaxAgeHours = clampNum(out.ownerTaskMaxAgeHours, 1, 720, 72)
  out.publicMentionsEnabled = out.publicMentionsEnabled !== false
  out.publicMentionPerDay = clampNum(out.publicMentionPerDay, 0, 100, 20)
  out.mentionVision = out.mentionVision !== false
  out.dmWatch = Boolean(out.dmWatch)
  out.dmWatchMinutes = clampNum(out.dmWatchMinutes, 3, 240, 5)
  out.dmReplyPerDay = clampNum(out.dmReplyPerDay, 0, 100, 0)
  out.dmOwnerUid = String(out.dmOwnerUid || '').slice(0, 30)
  const voice = String(out.voice || '').trim()
  out.voice = (VOICES.has(voice) || /^[a-zA-Z0-9][a-zA-Z0-9-]{1,39}$/.test(voice)) ? voice : 'zh-CN-YunxiNeural'
  out.modelChain = (Array.isArray(out.modelChain) ? out.modelChain : String(out.modelChain || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
  if (!out.modelChain.length) out.modelChain = [...DEFAULT_CHAIN]
  out.visionChain = (Array.isArray(out.visionChain) ? out.visionChain : String(out.visionChain || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
  if (!out.visionChain.length) out.visionChain = [...DEFAULT_VISION_CHAIN]
  out.concurrency = clampNum(out.concurrency, 1, 8, 4)
  const gen = out.generation && typeof out.generation === 'object' ? out.generation : {}
  out.generation = {
    enabled: gen.enabled !== false,
    baseUrl: String(gen.baseUrl || 'http://127.0.0.1:30001/v1').trim().replace(/\/+$/, '') || 'http://127.0.0.1:30001/v1',
    t2i: String(gen.t2i || 'fal-flux-schnell').slice(0, 80),
    i2i: String(gen.i2i || 'flux-dev-i2i').slice(0, 80),
    t2v: String(gen.t2v || 'ltx-video').slice(0, 80),
    i2v: String(gen.i2v || 'ltx-video-i2v').slice(0, 80),
  }
  out.publishEnabled = Boolean(out.publishEnabled)
  out.defaultTags = (Array.isArray(out.defaultTags) ? out.defaultTags : String(out.defaultTags || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 10)
  if (!out.defaultTags.length) out.defaultTags = ['资讯', '盘点']
  out.defaultZone = clampNum(out.defaultZone, 0, 9999, 0)
  return out
}

const loadCfg = () => normalizeCfg(readJson(configFile(), {}))
/** 任何回传前端的配置都必须过这层：密钥用占位符代替，不回传明文 */
const publicCfg = (cfg) => ({ ...cfg, llmKey: cfg.llmKey ? '__SAVED__' : '' })
const saveCfg = (patch) => {
  const before = loadCfg()
  const cfg = normalizeCfg({ ...before, ...patch })
  writeJson(configFile(), cfg)
  // 换了模型链/密钥 = 用户主动改了上游配置，解除「永久熔断」，允许重新试一次
  const chainChanged = JSON.stringify(before.modelChain) !== JSON.stringify(cfg.modelChain)
  if (chainChanged || before.llmKey !== cfg.llmKey) resetLlmBreaker()
  return cfg
}
const loadSched = () => readJson(scheduleFile(), { lastRunAt: '', lastResult: '' })

/* ───────────── 文本模型端点（40080）───────────── */
const llmBase = () => String(process.env.BILI_OP_LLM_BASE || 'http://127.0.0.1:40080/v1').replace(/\/+$/, '')
const llmKeyValue = () => String(process.env.OC_API_KEY || process.env.BILI_OP_LLM_KEY || loadCfg().llmKey || '')
const llmBreakerFile = () => join(STORE, 'llm_breaker.json')
function resetLlmBreaker() {
  try { if (existsSync(llmBreakerFile())) unlinkSync(llmBreakerFile()) } catch { /* 删不掉不影响主流程 */ }
}
function readLlmBreaker() {
  try { return JSON.parse(readFileSync(llmBreakerFile(), 'utf8')) } catch { return {} }
}

/** 跑引擎脚本（子进程），返回输出尾巴 */
function runEngine(script, args = [], timeoutMs = 20 * 60_000, extraEnv = null) {
  return new Promise((resolvePromise) => {
    const cfg = loadCfg()
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      BILI_OP_MODELS: cfg.modelChain.join(','),
      BILI_OP_VISION_MODELS: cfg.visionChain.join(','),
    }
    if (extraEnv) Object.assign(env, extraEnv)
    if (cfg.personaPrompt) env.BILI_OP_PERSONA = cfg.personaPrompt
    if (!env.BILI_OP_SELF_VIDEOS) env.BILI_OP_SELF_VIDEOS = canon.renderBlock()
    if (cfg.ownerUid) env.BILI_OWNER_UID = cfg.ownerUid
    if (cfg.ownerCall) env.BILI_OWNER_CALL = cfg.ownerCall
    if (!env.OC_API_KEY && cfg.llmKey) env.OC_API_KEY = cfg.llmKey
    let out = ''
    let done = false
    const finish = (r) => { if (!done) { done = true; resolvePromise(r) } }
    let child
    try {
      child = spawn(process.execPath, [join(ENGINE, script), ...args], { cwd: ENGINE, env, windowsHide: true })
    } catch (e) {
      return finish({ ok: false, code: null, text: String(e?.message ?? e) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish({ ok: false, code: null, text: out.slice(-3000) + '\n[超时]' }) }, timeoutMs)
    child.stdout?.on('data', (b) => { out += b.toString('utf8') })
    child.stderr?.on('data', (b) => { out += b.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: null, text: String(e?.message ?? e) }) })
    child.on('exit', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, text: out }) })
  })
}

/** 跑 bili-op 里的脚本（目前只用于 --health） */
function runOp(script, args = [], timeoutMs = 60_000) {
  const cfg = loadCfg()
  const env = {
    ...process.env,
    BILI_OP_MODELS: cfg.modelChain.join(','),
    BILI_OP_VISION_MODELS: cfg.visionChain.join(','),
  }
  if (!env.OC_API_KEY && cfg.llmKey) env.OC_API_KEY = cfg.llmKey
  return new Promise((resolvePromise) => {
    const r = spawnSync(process.execPath, [join(BILI_OP, script), ...args], { cwd: BILI_OP, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    resolvePromise({ ok: r.status === 0, text: `${r.stdout || ''}${r.stderr || ''}`, error: r.error ? String(r.error.message) : '' })
  })
}

let roundRunning = false
let taskRunning = false

/* ════ 采音色后台任务（⑦）：spawn 子进程跑 yt-dlp + demucs，不阻塞宿主 ════ */
const HARVEST_MAX_CONCURRENT = 2
const HARVEST_RETAIN_MS = 30 * 60_000 // 任务完成 30 分钟后从表里清掉
const harvestJobs = new Map() // taskId → { state, error, file, promptText, name, bv, startedAt, finishedAt, child }
let harvestTaskSeq = 0

/** 任务结束 30 分钟后从表里清掉，防止 Map 无限涨 */
function scheduleHarvestCleanup(taskId) {
  setTimeout(() => harvestJobs.delete(taskId), HARVEST_RETAIN_MS).unref()
}

function harvestRunningCount() {
  let n = 0
  for (const j of harvestJobs.values()) if (j.state === 'running') n++
  return n
}

/** 启动前环境预检：缺了直接 failed，秒回不白等。返回 null 或错误提示 */
function harvestEnvCheck() {
  const sovitsPy = process.platform === 'win32'
    ? join(HERE, '..', 'refs', 'GPT-SoVITS', '.venv', 'Scripts', 'python.exe')
    : join(HERE, '..', 'refs', 'GPT-SoVITS', '.venv', 'bin', 'python')
  if (!existsSync(sovitsPy)) return 'GPT-SoVITS 环境未安装（缺少 refs/GPT-SoVITS/.venv），请先安装 demucs 所需环境'
  const yd = spawnSync('yt-dlp', ['--version'], { timeout: 15_000, windowsHide: true, encoding: 'utf8' })
  if (yd.error || yd.status !== 0) return 'yt-dlp 不可用（未安装或不在 PATH）：pip install -U yt-dlp'
  const bili = spawnSync(biliBin(), ['--version'], { timeout: 15_000, windowsHide: true, encoding: 'utf8' })
  if (bili.error) return '未找到 bili 命令（bili CLI）：pip install bili-agent 或 uv tool install bili-agent'
  return null
}

/** 后台跑一个长任务（不阻塞 HTTP / 定时器） */
function kickTask(id = '') {
  if (taskRunning || roundRunning) return false
  taskRunning = true
  ;(async () => {
    try {
      const args = ['--tick']
      if (id) args.push('--id', id)
      const r = await runEngine('task.mjs', args, 45 * 60_000)
      if (r.text) log('任务：' + r.text.slice(-1500))
      // 任务自己逛 B站 采到的新视频，也按设置自动评论（额度跟日常采集共用）
      const cfg = loadCfg()
      if (cfg.autoComment && /新采 [1-9]/.test(r.text || '')) {
        const done = interact.dayCounts().comments
        const remain = Math.max(0, cfg.perDay - done)
        if (remain > 0) {
          const aArgs = ['--limit', String(Math.min(remain, 5))]
          aArgs.push('--image-every', String(cfg.commentImageEvery > 0 ? cfg.commentImageEvery : 0))
          const ac = await runEngine('auto-comment.mjs', aArgs, 10 * 60_000)
          if (ac.text) log('任务采集后自动评论：' + ac.text.slice(-400))
        }
      }
    } catch (e) {
      log('任务异常：' + (e?.message ?? e))
    } finally {
      taskRunning = false
    }
  })()
  return true
}

/** 一轮：采集（热门 + 关键词混合）→ 判定/热梗 → 自动评论 → 日报 */
async function runRound(why = 'manual', { count = 1 } = {}) {
  if (roundRunning) return { ok: false, error: '上一轮还在跑' }
  roundRunning = true
  const cfg = loadCfg()
  const n = Math.max(1, Math.min(Number(count) || 1, 5))
  const t0 = Date.now()
  try {
    const before = collectedToday()
    const outs = []
    if (cfg.keywords.length) {
      const sched = loadSched()
      const idx = (Number(sched.kwIdx) || 0) % cfg.keywords.length
      const kw = cfg.keywords[idx]
      // 1 条时轮流用热门/关键词；≥2 条时两边各分一半
      const kwN = n >= 2 ? Math.max(1, Math.floor(n / 2)) : (idx % 2 === 0 ? 1 : 0)
      const hotN = Math.max(0, n - kwN)
      if (hotN > 0) {
        const hot = await runEngine('collect.mjs', [
          '--hot', String(Math.max(hotN * 4, 8)), '--max-new', String(hotN), '--frames', String(cfg.frameCount),
        ])
        outs.push(hot.text)
        if (!hot.ok) log('热门采集失败：' + hot.text.slice(-500))
      }
      if (kwN > 0) {
        const search = await runEngine('collect.mjs', [
          '--search', kw, '--size', String(Math.max(kwN * 4, 6)), '--max-new', String(kwN), '--frames', String(cfg.frameCount),
        ])
        outs.push(search.text)
        if (!search.ok) log('关键词采集失败：' + search.text.slice(-500))
      }
      writeJson(scheduleFile(), { ...sched, kwIdx: (idx + 1) % cfg.keywords.length })
      log(`轮次(${why})：热门 ${hotN} + 关键词「${kw}」${kwN} 条`)
    } else {
      const hot = await runEngine('collect.mjs', [
        '--hot', String(Math.max(n * 5, 12)), '--max-new', String(n), '--frames', String(cfg.frameCount),
      ])
      outs.push(hot.text)
      if (!hot.ok) log('采集失败：' + hot.text.slice(-500))
      log(`轮次(${why})：综合热门 ${n} 条`)
    }
    const collect = { ok: outs.length > 0, text: outs.join('\n') }
    const added = Math.max(0, collectedToday() - before)

    const judge = await runEngine('judge.mjs', [])
    if (!judge.ok) log('判定失败：' + judge.text.slice(-500))

    // 每条采到的视频都留一条评论（带 @，不逐条确认）
    let autoComment = null
    if (collect.ok && cfg.autoComment) {
      const done = interact.dayCounts().comments
      const remain = Math.max(0, cfg.perDay - done)
      if (remain > 0) {
        const aArgs = ['--limit', String(Math.min(remain, 5))]
        aArgs.push('--image-every', String(cfg.commentImageEvery > 0 ? cfg.commentImageEvery : 0))
        // @ 谁和称呼由 auto-comment.mjs 直接读配置（支持多人）
        autoComment = await runEngine('auto-comment.mjs', aArgs, 10 * 60_000)
        log('自动评论：' + autoComment.text.slice(-400))
      } else {
        log('今天的自动评论额度已用完（按 perDay 计算）')
      }
    }

    const daily = await runEngine('daily.mjs', ['--level', cfg.reportLevel])
    if (!daily.ok) log('日报失败：' + daily.text.slice(-300))

    await applyAutoFavorite(cfg)

    const sec = Math.round((Date.now() - t0) / 1000)
    writeJson(scheduleFile(), {
      ...loadSched(),
      lastRunAt: new Date().toISOString(),
      lastWhy: why,
      lastResult: `完成（${sec}s）`,
      lastAdded: added,
    })
    log(`轮次(${why})完成，${sec}s，新采 ${added} 条`)
    return {
      ok: true, seconds: sec, added,
      collect: collect.text.slice(-1200),
      judge: judge.text.slice(-1200),
      autoComment: (autoComment?.text || '').slice(-1200),
      stats: storeStats(),
      counts: interact.dayCounts(),
      todayCount: collectedToday(),
    }
  } catch (e) {
    log('轮次异常：' + (e?.message ?? e))
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    roundRunning = false
  }
}

/** 偏好里的「自动收藏到收藏夹」：只收藏最新判定为值得看、且还没记过的 */
async function applyAutoFavorite(cfg) {
  if (!cfg.favFolderId) return
  const marked = loadCfg().favMarked || {}
  const targets = storeList({ limit: 30 }).filter((r) =>
    r.judge?.tier === '值得看' && !marked[r.bvid] && localDay(r.judge?.at) === today())
  for (const r of targets.slice(0, 5)) {
    const res = await runBiliAsync(['video', 'fav', r.bvid, '--folder', cfg.favFolderId], { timeoutMs: 30000 })
    if (res.ok) {
      marked[r.bvid] = new Date().toISOString()
      writeJson(configFile(), { ...loadCfg(), favMarked: marked })
      log(`已收藏 ${r.bvid} → ${cfg.favFolderId}`)
    } else {
      log(`收藏失败 ${r.bvid}：${res.error?.message || res.error?.code || ''}`)
      break
    }
  }
}

/* ───────────── 渲染任务（内存） ───────────── */
const jobs = new Map()
let ownerTaskRunning = false
let ownerTaskLast = 0

function pctFromLine(line, job) {
  if (/①/.test(line)) return 6
  if (/②\s*配音/.test(line)) return 14
  const tts = /^\s*(\d+)\s+\[(title|item|data|outro|scene|broll)/.exec(line)
  if (tts) {
    const n = Number(tts[1]) || 1
    return Math.min(44, 14 + Math.round((n / Math.max(1, job.totalShots || 8)) * 30))
  }
  if (/③\s*渲染画面/.test(line)) return 48
  // Remotion 用 \r 刷进度；有百分比或 已渲/总数 时映射到 48–73%
  if (/render|frame|encoded/i.test(line)) {
    const pct = /(\d{1,3})\s*%/.exec(line)
    if (pct) return Math.min(73, 48 + Math.round((Number(pct[1]) / 100) * 25))
    const frac = /(\d+)\s*\/\s*(\d+)/.exec(line)
    if (frac) return Math.min(73, 48 + Math.round((Number(frac[1]) / Math.max(1, Number(frac[2]))) * 25))
  }
  if (/渲染耗时/.test(line)) return 74
  if (/④\s*合入旁白/.test(line)) return 82
  if (/⑤\s*烧字幕/.test(line)) return 89
  if (/⑥\s*封面/.test(line)) return 95
  if (/✅\s*出片完成/.test(line)) return 100
  return null
}

function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
  } catch {
    try { child.kill() } catch { /* ignore */ }
  }
}

/* ───────────── 生成任务调度（worker 子进程） ───────────── */
const genRunning = new Map() // jobId -> { child, kind }
const GEN_LIMITS = { image: 4, video: 1 }
const GEN_WORKER = join(ENGINE, 'generation', 'worker.mjs')
const ASSEMBLY_WORKER = join(ENGINE, 'production', 'assemble.mjs')
const assemblyRunning = new Map() // runId -> child

function genEnv() {
  localNoProxy()
  return {
    ...process.env,
    PYTHONUTF8: '1',
    BILI_STORE: STORE,
    BILI_ASSETS: assetsRoot(),
    NO_PROXY: process.env.NO_PROXY || '',
    no_proxy: process.env.no_proxy || '',
  }
}

function startGenJob(job) {
  if (!existsSync(GEN_WORKER)) {
    genStore.updateJob(job.id, { status: 'failed', stage: '失败', error: '缺少 generation/worker.mjs' })
    return
  }
  let child
  try {
    child = spawn(process.execPath, [GEN_WORKER, '--job', job.id], {
      cwd: HERE,
      env: genEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    genStore.updateJob(job.id, { status: 'failed', stage: '失败', error: String(e?.message ?? e) })
    return
  }
  genRunning.set(job.id, { child, kind: job.kind })
  genStore.updateJob(job.id, { status: 'running', stage: '启动中', childPid: child.pid })
  let tail = ''
  const take = (buf) => { tail = (tail + String(buf)).slice(-4000) }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  const done = () => {
    genRunning.delete(job.id)
    const cur = genStore.readJob(job.id)
    if (cur && ['queued', 'running'].includes(cur.status)) {
      genStore.updateJob(job.id, {
        status: 'failed',
        stage: '失败',
        error: (tail.trim() || 'worker 提前退出').slice(-2000),
        endedAt: new Date().toISOString(),
      })
    }
    pumpGen()
  }
  child.once('error', (e) => {
    tail = (tail + '\n' + String(e?.message ?? e)).slice(-4000)
    done()
  })
  child.once('exit', done)
}

function pumpGen() {
  let rows = []
  try { rows = genStore.listJobs(500) } catch { return }
  const live = new Set(genRunning.keys())
  for (const j of rows) {
    if (j.status === 'running' && !live.has(j.id)) {
      genStore.updateJob(j.id, {
        status: 'interrupted', stage: '已中断', error: '任务进程已退出；可重试',
        endedAt: new Date().toISOString(),
      })
    }
  }
  const counts = { image: 0, video: 0 }
  for (const v of genRunning.values()) counts[v.kind] = (counts[v.kind] || 0) + 1
  const queued = rows
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))
  for (const j of queued) {
    const limit = GEN_LIMITS[j.kind] || 1
    if ((counts[j.kind] || 0) >= limit) continue
    startGenJob(j)
    counts[j.kind] = (counts[j.kind] || 0) + 1
  }
}

async function cancelGenJob(id) {
  const cur = genStore.readJob(id)
  if (!cur) return null
  if (cur.upstreamJobId) {
    try { await cancelGenUpstream(cur.baseUrl || generationBase(), cur.upstreamJobId) } catch { /* best effort */ }
  }
  const running = genRunning.get(id)
  if (running) {
    genStore.updateJob(id, {
      status: 'cancelled', stage: '已取消', error: '已手动取消',
      endedAt: new Date().toISOString(),
    })
    killTree(running.child)
    genRunning.delete(id)
    pumpGen()
  } else {
    genStore.cancelJob(id)
  }
  return genStore.readJob(id)
}


function startRender(project, plan, version, voice) {
  const { runId, runDir, frameCount } = renders.prepareRun(project, plan, version)
  const cfg = loadCfg()
  const usedVoice = String(voice || cfg.voice || '').trim() || cfg.voice
  const job = {
    runId, runDir, projectId: project.id, version: Number(version) || project.currentVersion,
    stage: 'running', pct: 3, log: '', error: '', startedAt: new Date().toISOString(), endedAt: '',
    cancelled: false, child: null,
    totalShots: (plan.shots || []).length, frameCount,
  }
  jobs.set(runId, job)

  project.stage = 'rendering'
  project.runDir = runDir
  project.renderVersion = Number(version) || project.currentVersion
  project.renderVoice = usedVoice
  plans.saveProject(project)

  const env = {
    ...process.env,
    PYTHONUTF8: '1',
    BILI_OP_MODELS: cfg.modelChain.join(','),
    BILI_OP_VISION_MODELS: cfg.visionChain.join(','),
  }
  if (!env.OC_API_KEY && cfg.llmKey) env.OC_API_KEY = cfg.llmKey

  const child = spawn(process.execPath, [
    join(BILI_OP, 'build.mjs'), '--run', runDir, '--burn', '--voice', usedVoice,
  ], { cwd: BILI_OP, env, windowsHide: true })
  job.child = child

  let buf = ''
  const onData = (b) => {
    buf += b.toString('utf8')
    const lines = buf.split(/[\r\n]+/)
    buf = lines.pop() || ''
    for (const line of lines) {
      job.log = (job.log + line + '\n').slice(-12000)
      const p = pctFromLine(line, job)
      if (p !== null) job.pct = Math.max(job.pct, p)
    }
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', (e) => {
    job.child = null
    if (job.cancelled) return
    job.stage = 'failed'
    job.error = String(e?.message ?? e)
    job.endedAt = new Date().toISOString()
    log(`出片失败 ${runId}：${job.error}`)
  })
  child.on('close', (code) => {
    job.child = null
    job.endedAt = new Date().toISOString()
    const purge = () => { const t = setTimeout(() => jobs.delete(runId), 10 * 60_000); t.unref?.() }
    if (job.cancelled) {
      job.stage = 'cancelled'
      job.error = '已手动取消'
      purge()
      log(`渲染已取消 ${runId}`)
      return
    }
    if (code === 0) {
      job.stage = 'done'
      job.pct = 100
      const st = renders.readStatus(runId)
      // 取最新项目再 patch：渲染期间主人可能改过版，不能用闭包里的旧 project 整体覆盖
      const fresh = plans.getProject(project.id) || project
      fresh.stage = 'rendered'
      fresh.runDir = runDir
      fresh.renderVersion = job.version
      fresh.review = null
      plans.saveProject(fresh)
      memory.addEvent('render', { runId, projectId: project.id, text: `渲染《${plan.title || project.id}》成功，${st?.seconds || '?'} 秒成片已出` })
      log(`出片完成 ${runId}（${st?.seconds || '?'} 秒，真实帧 ${frameCount}）`)
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
    } else {
      job.stage = 'failed'
      job.error = job.log.slice(-1200) || ('退出码 ' + code)
      const fresh = plans.getProject(project.id) || project
      fresh.stage = 'draft'
      plans.saveProject(fresh)
      memory.addEvent('render', { runId, projectId: project.id, ok: false, text: `渲染《${plan.title || project.id}》失败：${job.error.slice(0, 60)}` })
      log(`出片失败 ${runId}（退出码 ${code}）`)
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
    }
  })
  return job
}

const jobView = (j) => j ? ({
  runId: j.runId, runDir: j.runDir, projectId: j.projectId, version: j.version, stage: j.stage, pct: j.pct,
  error: j.error, startedAt: j.startedAt, endedAt: j.endedAt, totalShots: j.totalShots,
  frameCount: j.frameCount, log: j.log.slice(-3000),
}) : null

const activeJob = (projectId) => {
  for (const j of jobs.values()) {
    if (j.projectId === projectId && j.stage === 'running') return j
  }
  return null
}

/* ───────────── 生成服务（本地 fal.ai 代理 / OpenAI 兼容） ───────────── */
function localNoProxy() {
  const add = ['127.0.0.1', 'localhost', '::1']
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const cur = String(process.env[key] || '')
    const parts = cur.split(',').map((s) => s.trim()).filter(Boolean)
    for (const a of add) if (!parts.includes(a)) parts.push(a)
    process.env[key] = parts.join(',')
  }
}
function generationBase() {
  const g = loadCfg().generation || {}
  return String(g.baseUrl || 'http://127.0.0.1:30001/v1').replace(/\/+$/, '')
}

/* ───────────── HTTP ───────────── */
export function apply(ctx) {
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolvePromise) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolvePromise(v) } }
    req.on('data', (c) => { data += c; if (data.length > 2_000_000) { finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  let lastQrImage = ''

  const coverFor = async (bv) => {
    const buf = await fetchCover(bv)
    return buf ? { buf, type: 'image/jpeg' } : null
  }

  const handle = async (req, res, url) => {
    const path = url.pathname.replace(/^\/api\/bili-wb/, '') || '/'
    const q = url.searchParams

    /* ══════════ 账号：登录 / 状态 ══════════ */
    if (req.method === 'GET' && path === '/status') {
      const r = await runBiliAsync(['auth', 'status'], { timeoutMs: 20000 })
      const d = r.data || {}
      return sendJson(res, 200, {
        ok: true, loggedIn: Boolean(d.logged_in), user: d.user || null,
        status: d.status || '', code: r.error?.code || '', hint: r.error?.hint || '',
      })
    }
    if (req.method === 'POST' && path === '/login/start') {
      const r = await runBiliAsync(['auth', 'login'], { timeoutMs: 40000 })
      const d = r.data || {}
      if (d.qr_image) lastQrImage = String(d.qr_image)
      return sendJson(res, 200, {
        ok: r.ok && Boolean(d.qr_url || d.qr_image), status: d.status || '',
        qrUrl: d.qr_url || '', hasImage: Boolean(d.qr_image), expiresIn: Number(d.expires_in) || 180,
        error: r.error || null,
      })
    }
    if (req.method === 'GET' && path === '/qr.png') {
      if (!lastQrImage || !existsSync(lastQrImage)) { res.writeHead(404); return res.end('no qr') }
      try {
        const buf = readFileSync(lastQrImage)
        const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8
        const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50
        res.writeHead(200, { 'content-type': isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'application/octet-stream', 'cache-control': 'no-store' })
        return res.end(buf)
      } catch (e) { res.writeHead(500); return res.end(String(e?.message ?? e)) }
    }
    if (req.method === 'POST' && path === '/logout') {
      const r = await runBiliAsync(['auth', 'logout'], { timeoutMs: 20000 })
      lastQrImage = ''
      return sendJson(res, 200, { ok: r.ok, error: r.error || null })
    }

    /* ══════════ 刷B站：热门 / 搜索 / 看懂 / 消息 / 数据 ══════════ */
    if (req.method === 'GET' && path === '/hot') {
      const kind = q.get('kind') === 'rank' ? 'rank' : 'popular'
      const size = Math.max(1, Math.min(Number(q.get('size')) || 20, 50))
      const zoneRaw = String(q.get('zone') || 'all')
      const zone = ZONES.has(zoneRaw) ? zoneRaw : 'all'
      const args = kind === 'rank'
        ? ['hot', 'rank', '--zone', zone, '--limit', String(size)]
        : ['hot', 'popular', '--size', String(size)]
      const r = await runBiliAsync(args, { timeoutMs: 40000 })
      return sendJson(res, 200, { ok: r.ok, kind, zone, items: r.data?.items || [], error: r.error || null })
    }
    if (req.method === 'GET' && path === '/search') {
      const kw = String(q.get('q') || '').trim().slice(0, 60)
      if (!kw) return sendJson(res, 200, { ok: true, items: [], keyword: '' })
      const size = Math.max(1, Math.min(Number(q.get('size')) || 20, 50))
      const order = ['default', 'views', 'new', 'danmaku', 'favorites', 'comments'].includes(String(q.get('order'))) ? String(q.get('order')) : 'default'
      const r = await runBiliAsync(['search', 'video', kw, '--order', order, '--size', String(size)], { timeoutMs: 45000 })
      return sendJson(res, 200, { ok: r.ok, keyword: kw, total: r.data?.total || 0, items: r.data?.items || [], error: r.error || null })
    }
    if (req.method === 'GET' && path === '/video') {
      const bv = String(q.get('bv') || '').trim()
      if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, hint: 'BV 号不对' })
      const chars = Math.max(300, Math.min(Number(q.get('chars')) || 3000, 20000))
      const r = await runBiliAsync(['video', 'watch', bv, '--max-chars', String(chars)], { timeoutMs: 120000 })
      if (r.ok) {
        runEngine('collect.mjs', [bv, '--frames', '10']).then((x) => { if (!x.ok) log('顺手落库失败：' + x.text.slice(-200)) })
      }
      return sendJson(res, 200, { ok: r.ok, data: r.data || null, error: r.error || null })
    }
    if (req.method === 'GET' && path === '/stats') {
      const r = await runBiliAsync(['me', 'stats'], { timeoutMs: 40000 })
      return sendJson(res, 200, { ok: r.ok, data: r.data || null, error: r.error || null })
    }

    /* 环境自检：bili / ffmpeg / yt-dlp / 模型 / 素材库 / 声音克隆环境 */
    if (req.method === 'GET' && path === '/doctor') {
      const checks = {}
      const probe = (bin, args) => {
        const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000, windowsHide: true })
        if (r.error) return { ok: false, detail: `未找到 ${bin} 命令` }
        return { ok: r.status === 0, detail: String(r.stdout || r.stderr || '').split(/\r?\n/)[0].slice(0, 120) }
      }
      // bili CLI：用 auth status 探测；bili-missing 说明命令本身不在
      const rb = await runBiliAsync(['auth', 'status'], { timeoutMs: 20000 })
      checks.bili = rb.error?.code === 'bili-missing'
        ? { ok: false, detail: rb.error.message }
        : { ok: rb.ok, detail: rb.ok ? 'bili 命令可用' : (rb.error?.message || rb.error?.code || 'auth status 失败（可能只是未登录）') }
      checks.ffmpeg = probe('ffmpeg', ['-version'])
      checks.ytdlp = probe('yt-dlp', ['--version'])
      const rl = await runOp('gen.mjs', ['--health'], 30000)
      checks.llm = { ok: rl.ok, detail: rl.ok ? '模型服务可达' : (rl.text || rl.error || '健康检查失败').slice(-200) }
      const root = assetsRoot()
      checks.assets = {}
      for (const k of ['bgm', 'voices', 'memes', 'stickers', 'clips']) {
        const d = join(root, k === 'memes' ? join('memes', 'bili-emotes') : k === 'stickers' ? join('stickers', 'openmoji', 'png-618x618-color') : k)
        checks.assets[k] = existsSync(d)
      }
      const sovits = resolve(HERE, '..', 'refs', 'GPT-SoVITS', '.venv')
      checks.sovits = { ok: existsSync(sovits), detail: sovits }
      return sendJson(res, 200, { ok: true, checks })
    }

    /* 封面代理：热门/搜索卡片用 */
    if (req.method === 'GET' && path === '/cover') {
      const bv = String(q.get('bv') || '').trim()
      if (!BV_RE.test(bv)) { res.writeHead(400); return res.end('bad bv') }
      const got = await coverFor(bv)
      if (!got) { res.writeHead(404); return res.end('no cover') }
      res.writeHead(200, { 'content-type': got.type, 'cache-control': 'max-age=1800' })
      return res.end(got.buf)
    }
    if (req.method === 'GET' && path === '/inbox') {
      const [inbox, replies] = await Promise.all([
        runBiliAsync(['feed', 'inbox'], { timeoutMs: 30000 }),
        runBiliAsync(['feed', 'replies', '--limit', '12'], { timeoutMs: 30000 }),
      ])
      return sendJson(res, 200, {
        ok: true, counts: inbox.data?.unread || null, note: inbox.data?.note || '',
        items: replies.data?.items || [], error: inbox.error || replies.error || null,
      })
    }

    /* ══════════ 素材库 ══════════ */
    if (req.method === 'GET' && path === '/store/list') {
      const tier = String(q.get('tier') || '')
      const kw = String(q.get('q') || '').trim()
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 100, 500))
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '50', 10) || 50))
      const rows = storeList({ limit: 2000 })
      let filtered = rows
      if (TIERS.has(tier)) filtered = filtered.filter((r) => (r.judge?.tier || '未判定') === tier)
      if (kw) {
        const k = kw.toLowerCase()
        filtered = filtered.filter((r) => String(r.title || '').toLowerCase().includes(k)
          || String(r.up?.name || '').toLowerCase().includes(k)
          || String(r.judge?.why || '').toLowerCase().includes(k)
          || (r.quotes || []).some((x) => String(x.text || '').toLowerCase().includes(k)))
      }
      const total = filtered.length
      // 先排序切片再 slim：只对当前页做重活；互动状态用一次快照批量标注，不逐条全量 parse
      const commented = interact.commentedMap()
      const pageRows = filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
      const legacyLimitRows = (q.get('page') === null && q.get('pageSize') === null)
        ? filtered.slice(0, limit) : pageRows
      const slim = legacyLimitRows.map(({ subtitle, quotes, ...rest }) => ({
        ...rest,
        commented: Boolean(commented[String(rest.bvid || '')]),
        quotes: (quotes || []).slice(0, 3),
        subtitle: subtitle ? { lang: subtitle.lang, chars: subtitle.chars, missing: subtitle.missing || '' } : null,
      }))
      return sendJson(res, 200, { ok: true, rows: slim, total, page, pageSize, stats: storeStats(), ranges: parseRanges(loadCfg().scheduleRanges).length })
    }
    if (req.method === 'GET' && path === '/store/item') {
      const bv = String(q.get('bv') || '')
      if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, error: 'bad bv' })
      const rec = storeGet(bv)
      if (!rec) return sendJson(res, 200, { ok: false, error: '库里没有这条' })
      const { subtitle, ...rest } = rec
      let sub = null
      try {
        const f = storePaths(bv).subs
        if (existsSync(f)) {
          const j = JSON.parse(readFileSync(f, 'utf8'))
          sub = { lang: j.lang, items: (j.items || []).slice(0, 200), total: (j.items || []).length }
        }
      } catch { /* 没字幕就算了 */ }
      return sendJson(res, 200, {
        ok: true,
        record: { ...rest, commented: interact.isCommented(bv), subtitle: subtitle ? { lang: subtitle.lang, chars: subtitle.chars, items: subtitle.items, missing: subtitle.missing || '' } : null },
        subtitles: sub,
      })
    }
    if (req.method === 'GET' && path === '/store/media') {
      const bv = String(q.get('bv') || '')
      const kind = String(q.get('kind') || 'cover')
      if (!BV_RE.test(bv)) { res.writeHead(400); return res.end('bad bv') }
      const p = storePaths(bv)
      if (kind === 'cover') {
        if (!existsSync(p.cover)) { res.writeHead(404); return res.end('no cover') }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' })
        return res.end(readFileSync(p.cover))
      }
      const name = String(q.get('name') || '')
      if (!/^[\w.\-]+\.jpg$/.test(name)) { res.writeHead(400); return res.end('bad name') }
      const file = join(p.framesDir, name)
      if (!existsSync(file)) { res.writeHead(404); return res.end('no frame') }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' })
      return res.end(readFileSync(file))
    }
    if (req.method === 'GET' && path === '/store/report') {
      const day = String(q.get('day') || new Date().toLocaleDateString('sv-SE')).replace(/[^0-9-]/g, '')
      const file = join(STORE, 'reports', `${day}.md`)
      if (!existsSync(file)) return sendJson(res, 200, { ok: true, day, exists: false, text: '' })
      return sendJson(res, 200, { ok: true, day, exists: true, text: readFileSync(file, 'utf8') })
    }
    if (req.method === 'POST' && path === '/store/collect') {
      const body = await readBody(req)
      const args = []
      const bvs = Array.isArray(body.bvs) ? body.bvs.filter((x) => BV_RE.test(String(x))) : []
      if (bvs.length) args.push(...bvs)
      else if (body.mode === 'search' && body.q) args.push('--search', String(body.q).slice(0, 60), '--size', String(Math.min(Number(body.size) || 5, 20)))
      else args.push('--hot', String(Math.min(Number(body.size) || 6, 50)))
      if (body.refresh) args.push('--refresh')
      args.push('--frames', String(Math.min(Number(body.frames) || 10, 10)))
      const r = await runEngine('collect.mjs', args)
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000), stats: storeStats() })
    }
    if (req.method === 'POST' && path === '/store/judge') {
      const body = await readBody(req)
      const r = await runEngine('judge.mjs', body.refresh ? ['--refresh'] : [])
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000) })
    }
    if (req.method === 'POST' && path === '/store/daily') {
      const r = await runEngine('daily.mjs', ['--level', loadCfg().reportLevel])
      return sendJson(res, 200, { ok: r.ok, text: r.text.slice(-2000) })
    }
    if (req.method === 'POST' && path === '/store/relocate') {
      if (roundRunning) return sendJson(res, 200, { ok: false, error: '采集轮次正在跑，等它结束再切' })
      if ([...jobs.values()].some((j) => j.stage === 'running')) {
        return sendJson(res, 200, { ok: false, error: '有渲染任务正在跑，等它结束再切' })
      }
      const body = await readBody(req)
      const raw = String(body.path || '').trim()
      if (!raw) return sendJson(res, 200, { ok: false, error: '先填一个素材库目录' })
      const target = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()))
      const old = STORE
      const lc = (s) => s.replace(/[\\/]+$/, '').toLowerCase()
      if (lc(target) === lc(old)) {
        return sendJson(res, 200, { ok: true, path: old, copied: false, store: storeStats() })
      }
      if (lc(target).startsWith(lc(old) + sep) || lc(old).startsWith(lc(target) + sep)) {
        return sendJson(res, 200, { ok: false, error: '不能选当前素材库的子目录或上级目录' })
      }
      try {
        if (existsSync(target) && !statSync(target).isDirectory()) {
          return sendJson(res, 200, { ok: false, error: '这个路径是一个文件，不是目录' })
        }
        mkdirSync(target, { recursive: true })
        const videosDir = join(target, 'videos')
        const hasData = existsSync(join(target, 'config.json'))
          || (existsSync(videosDir) && readdirSync(videosDir).some((f) => f.endsWith('.json')))
        let copied = false
        if (body.copy !== false && !hasData) {
          cpSync(old, target, { recursive: true, force: false, errorOnExist: false })
          copied = true
        }
        const p = setStoreRoot(target)
        log(`素材库位置切换：${old} → ${p}${copied ? '（已复制现有素材）' : ''}`)
        return sendJson(res, 200, {
          ok: true, path: p, copied, store: storeStats(),
          defaultPath: defaultStorePath(), locationFile: locationFile(),
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    /* ══════════ 创作：方案（项目 + 版本） ══════════ */
    if (req.method === 'GET' && path === '/create/plans') {
      const list = plans.listProjects().slice(0, 40).map((p) => {
        const plan = plans.getVersion(p.id, p.currentVersion)
        const job = activeJob(p.id)
        return {
          ...p,
          plan: plan ? {
            title: plan.title, subtitle: plan.subtitle, angle: plan.angle, brief: plan.brief,
            picks: plan.picks || [], shots: plan.shots || [], stats: plan.stats || {}, model: plan.model,
            blueprint: plan.blueprint ? { approvedAt: plan.blueprint.approvedAt || '' } : null,
          } : null,
          job: jobView(job),
        }
      })
      return sendJson(res, 200, { ok: true, projects: list })
    }
    if (req.method === 'GET' && path === '/create/plan') {
      const id = String(q.get('id') || '')
      const v = Number(q.get('v')) || 0
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, v || project.currentVersion)
      return sendJson(res, 200, { ok: true, project, plan })
    }
    if (req.method === 'POST' && path === '/create/plan') {
      const body = await readBody(req)
      const brief = String(body.brief || '').trim().slice(0, 300)
      if (!brief) return sendJson(res, 200, { ok: false, error: '先写一句你想做什么样的片子' })
      let tmp = join(STORE, 'tmp', `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      mkdirSync(join(STORE, 'tmp'), { recursive: true })
      const args = [brief, '--out', tmp]
      if (body.limit) args.push('--limit', String(Math.min(Number(body.limit) || 40, 120)))
      const r = await runEngine('plan.mjs', args, 10 * 60_000, {
        BILI_OP_SELF_VIDEOS: canon.renderBlock(brief),
        BILI_OP_MEMORY_QUERY: brief,
      })
      let plan = null
      try { plan = JSON.parse(readFileSync(tmp, 'utf8')) } catch { plan = null }
      try { unlinkSync(tmp) } catch { /* 已删 */ }
      if (!r.ok || !plan) {
        return sendJson(res, 200, { ok: false, error: r.ok ? '没拿到方案（看日志）' : '生成失败（看日志）', log: (r.text || '').slice(-2500) })
      }
      const project = plans.createProject(plan, { brief })
      log(`新方案 ${project.id}：${plan.title}`)
      // 方案完成后复盘一次（节流在 reflect.mjs 里）：主人的指令是提炼习惯的重要来源
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
      return sendJson(res, 200, { ok: true, project, plan, log: (r.text || '').slice(-2500) })
    }
    if (req.method === 'POST' && path === '/create/revise') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const instruction = String(body.instruction || '').trim().slice(0, 300)
      if (!instruction) return sendJson(res, 200, { ok: false, error: '先说一句要改什么' })
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      if (activeJob(id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染，等渲染完再改版' })
      const prevPlan = plans.getVersion(id, project.currentVersion)
      if (!prevPlan) return sendJson(res, 200, { ok: false, error: '当前版本读不到' })
      // 旧格式（plans/<时间>.json）没有项目目录：先复制成一个新项目再改版
      let workProject = project
      let prevFile = plans.planFile(id, project.currentVersion)
      if (project.legacy) {
        workProject = plans.createProject(prevPlan, { brief: prevPlan.brief || '' })
        prevFile = plans.planFile(workProject.id, 1)
      } else if (!existsSync(prevFile)) {
        writeJson(prevFile, prevPlan)
      }
      const tmp = join(STORE, 'tmp', `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
      mkdirSync(join(STORE, 'tmp'), { recursive: true })
      const r = await runEngine('plan.mjs', ['--revise', prevFile, '--instruction', instruction, '--out', tmp], 10 * 60_000, {
        BILI_OP_SELF_VIDEOS: canon.renderBlock(instruction),
        BILI_OP_MEMORY_QUERY: instruction,
      })
      let plan = null
      try { plan = JSON.parse(readFileSync(tmp, 'utf8')) } catch { plan = null }
      try { unlinkSync(tmp) } catch { /* 已删 */ }
      if (!r.ok || !plan) {
        return sendJson(res, 200, { ok: false, error: r.ok ? '没拿到改版方案（看日志）' : '改版失败（看日志）', log: (r.text || '').slice(-2500) })
      }
      const next = plans.addVersion(workProject.id, plan, { instruction })
      log(`改一版 ${workProject.id} → v${next.currentVersion}：${plan.title}`)
      return sendJson(res, 200, { ok: true, project: next, plan, log: (r.text || '').slice(-2500) })
    }
    if (req.method === 'GET' && path === '/create/prompt') {
      const id = String(q.get('id') || '')
      const v = Number(q.get('v')) || 0
      try { return sendJson(res, 200, { ok: true, prompt: plans.promptFor(id, v) }) } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'POST' && path === '/create/delete') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const p = plans.getProject(id)
      if (!p) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      if (activeJob(p.id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染，等渲染完再删' })
      const ok = plans.deleteProject(id)
      if (ok) {
        for (const t of tasks.list()) {
          if (t.projectId !== id) continue
          tasks.update(t.id, { projectId: '', planTitle: '', status: 'paused' })
          tasks.addLog(t.id, '关联方案已删除，任务暂停')
        }
      }
      // 成片是独立产物：留在「审核/发布」，要删请在那里单独删
      log(`删除方案 ${id}（成片保留在审核/发布）`)
      return sendJson(res, 200, { ok })
    }

    /* ══════════ 长任务：素材不够就自己去 B站 找 ══════════ */
    if (req.method === 'GET' && path === '/task/list') {
      const rows = tasks.list()
      return sendJson(res, 200, {
        ok: true,
        tasks: rows,
        active: rows.filter((t) => !['ready', 'failed'].includes(t.status)).length,
        running: taskRunning,
      })
    }
    if (req.method === 'POST' && path === '/task/create') {
      const body = await readBody(req)
      const brief = String(body.brief || '').trim().slice(0, 300)
      if (!brief) return sendJson(res, 200, { ok: false, error: '先写一句你想做什么样的片子' })
      const task = tasks.create({
        brief,
        maxDays: Number(body.maxDays) || 5,
        intervalMinutes: Number(body.intervalMinutes) || 180,
        needed: Number(body.needed) || 3,
      })
      memory.addEvent('task', { id: task.id, text: `接到创作指令「${brief.slice(0, 40)}」` })
      log(`新任务 ${task.id}：${brief}`)
      const t = setTimeout(() => { kickTask(task.id) }, 800)
      t.unref?.()
      return sendJson(res, 200, { ok: true, task })
    }
    if (req.method === 'POST' && path === '/task/tick') {
      const body = await readBody(req)
      const id = String(body.id || '')
      if (id && !tasks.get(id)) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      if (taskRunning) return sendJson(res, 200, { ok: false, error: '已经有一个任务在跑，等它跑完' })
      if (roundRunning) return sendJson(res, 200, { ok: false, error: '日常采集正在跑，稍后再试' })
      const started = kickTask(id)
      return sendJson(res, 200, { ok: started, started, error: started ? '' : '任务已在跑' })
    }
    if (req.method === 'POST' && path === '/task/pause') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const t = tasks.update(id, { status: 'paused' })
      if (!t) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      tasks.addLog(id, '已暂停')
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/resume') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const t = tasks.update(id, { status: 'queued', nextRunAt: new Date().toISOString(), lastError: '' })
      if (!t) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      tasks.addLog(id, '已继续')
      const tm = setTimeout(() => { kickTask(id) }, 800)
      tm.unref?.()
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/retry') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const cur = tasks.get(id)
      if (!cur) return sendJson(res, 200, { ok: false, error: '任务不存在' })
      // 已经过期的任务，手动重试就从现在起再给一个完整期限
      const expired = Date.parse(cur.deadline || '') < Date.now()
      const deadline = expired ? new Date(Date.now() + (cur.maxDays || 5) * 86400_000).toISOString() : cur.deadline
      const t = tasks.update(id, {
        status: 'queued', nextRunAt: new Date().toISOString(), lastError: '', deadline,
      })
      tasks.addLog(id, expired ? `手动重试，期限顺延到 ${String(deadline).slice(0, 10)}` : '手动重试')
      const tm = setTimeout(() => { kickTask(id) }, 500)
      tm.unref?.()
      return sendJson(res, 200, { ok: true, task: t })
    }
    if (req.method === 'POST' && path === '/task/delete') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const ok = tasks.remove(id)
      return sendJson(res, 200, ok ? { ok: true } : { ok: false, error: '任务不存在' })
    }

    /* ══════════ 出片：方案 → 真实素材渲染 ══════════ */
    if (req.method === 'POST' && path === '/render/start') {
      const body = await readBody(req)
      const id = String(body.id || '')
      let project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      let v = Number(body.version) || project.currentVersion
      let plan = plans.getVersion(id, v)
      if (!plan) return sendJson(res, 200, { ok: false, error: '这一版方案读不到' })
      // 旧格式：复制成一个新项目再渲染（不破坏原来的只读方案）
      if (project.legacy) {
        const copied = plans.createProject(plan, { brief: plan.brief || '' })
        project = copied
        v = 1
        plan = plans.getVersion(project.id, 1)
      }
      if (activeJob(project.id)) return sendJson(res, 200, { ok: false, error: '这个项目正在渲染' })
      if (plan.blueprint && !plan.blueprint.approvedAt) {
        return sendJson(res, 200, { ok: false, error: '先在「方案蓝图」里点确认，再开始渲染' })
      }
      if (!Array.isArray(plan.shots) || !plan.shots.length) {
        return sendJson(res, 200, { ok: false, error: '分镜没有参与渲染的镜头：到「方案蓝图 → 分镜与镜头表」把镜头标回「参与」' })
      }
      try {
        const job = startRender(project, plan, v, body.voice || project.renderVoice)
        return sendJson(res, 200, { ok: true, job: jobView(job) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'POST' && path === '/render/cancel') {
      const body = await readBody(req)
      const runId = String(body.runId || '')
      const job = jobs.get(runId)
      if (!job) return sendJson(res, 200, { ok: false, error: '没有这个渲染任务' })
      if (job.stage !== 'running') return sendJson(res, 200, { ok: false, error: '任务已经结束' })
      job.cancelled = true
      killTree(job.child)
      job.stage = 'cancelled'
      job.error = '已手动取消'
      job.endedAt = new Date().toISOString()
      const fresh = plans.getProject(job.projectId)
      if (fresh) { fresh.stage = 'draft'; plans.saveProject(fresh) }
      log(`渲染已取消 ${runId}`)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && path === '/render/status') {
      const runId = String(q.get('runId') || '')
      const job = jobs.get(runId)
      return sendJson(res, 200, { ok: true, job: jobView(job), status: runId ? renders.readStatus(runId) : null })
    }
    if (req.method === 'GET' && path === '/render/runs') {
      return sendJson(res, 200, { ok: true, runs: renders.listRuns() })
    }

    /* ══════════ 生成服务（本地 fal.ai 代理 / OpenAI 兼容） ══════════ */
    if (req.method === 'GET' && path === '/generate/models') {
      localNoProxy()
      const base = generationBase()
      try {
        const r = await fetch(base + '/models', { signal: AbortSignal.timeout(5000) })
        if (!r.ok) throw new Error('HTTP ' + r.status)
        const j = await r.json()
        return sendJson(res, 200, { ok: true, baseUrl: base, models: Array.isArray(j.data) ? j.data : [] })
      } catch (e) {
        return sendJson(res, 200, { ok: false, baseUrl: base, models: [], error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'POST' && path === '/generate/test') {
      const body = await readBody(req)
      if (body.confirm !== true) return sendJson(res, 200, { ok: false, error: '测试会真实计费，需要 confirm:true' })
      const g = loadCfg().generation || {}
      if (g.enabled === false) return sendJson(res, 200, { ok: false, error: '生成服务未启用' })
      const base = generationBase()
      const model = String(body.model || g.t2i || 'fal-flux-schnell')
      const prompt = String(body.prompt || 'a simple red apple on a wooden table, studio product photo').slice(0, 500)
      localNoProxy()
      try {
        const r = await fetch(base + '/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt, size: '512x512', n: 1 }),
          signal: AbortSignal.timeout(180_000),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) return sendJson(res, 200, { ok: false, error: j?.error?.message || ('HTTP ' + r.status) })
        return sendJson(res, 200, { ok: true, model, url: j?.data?.[0]?.url || '', billable: j?.fal?.billable_units || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    /* ── 生成任务：持久化队列 + 独立 worker ── */
    if (req.method === 'GET' && path === '/generate/jobs') {
      const limit = clampNum(q.get('limit'), 1, 100, 30)
      const kind = String(q.get('kind') || '').trim()
      let rows = genStore.listJobs(limit)
      if (kind === 'image' || kind === 'video') rows = rows.filter((j) => j.kind === kind)
      return sendJson(res, 200, {
        ok: true,
        jobs: rows,
        active: rows.filter((j) => ['queued', 'running'].includes(j.status)).length,
      })
    }
    if (req.method === 'POST' && path === '/generate/jobs') {
      const body = await readBody(req)
      const g = loadCfg().generation || {}
      if (g.enabled === false) return sendJson(res, 200, { ok: false, error: '生成服务未启用' })
      const mode = String(body.mode || 't2i').trim()
      if (!['t2i', 'i2i', 't2v', 'i2v'].includes(mode)) return sendJson(res, 200, { ok: false, error: 'mode 只能是 t2i/i2i/t2v/i2v' })
      const kind = mode === 't2v' || mode === 'i2v' ? 'video' : 'image'
      const prompt = String(body.prompt || '').trim()
      if (!prompt) return sendJson(res, 200, { ok: false, error: '先写一句你想要什么' })
      const refImages = (Array.isArray(body.refImages) ? body.refImages : []).map((s) => String(s || '').trim()).filter(Boolean)
      if ((mode === 'i2i' || mode === 'i2v') && !refImages.length) {
        return sendJson(res, 200, { ok: false, error: '图生图/图生视频需要一张参考图' })
      }
      const model = String(body.model || g[mode] || '').trim()
      if (!model) return sendJson(res, 200, { ok: false, error: '设置里没有为 ' + mode + ' 配模型' })
      const job = genStore.createJob({
        kind,
        mode,
        model,
        baseUrl: generationBase(),
        prompt,
        refImages,
        params: body.params && typeof body.params === 'object' ? body.params : {},
        parentId: body.parentId,
        title: body.title,
        priority: body.priority,
        dryRun: body.dryRun === true,
      })
      pumpGen()
      return sendJson(res, 200, { ok: true, job })
    }
    const genMatch = /^\/generate\/jobs\/([a-f0-9]{16})(?:\/(cancel|retry))?$/.exec(path)
    if (genMatch) {
      const id = genMatch[1]
      const action = genMatch[2] || ''
      if (action === 'cancel' && req.method === 'POST') {
        const job = await cancelGenJob(id)
        return sendJson(res, 200, job ? { ok: true, job } : { ok: false, error: '没有这个任务' })
      }
      if (action === 'retry' && req.method === 'POST') {
        const job = genStore.retryJob(id)
        if (!job) return sendJson(res, 200, { ok: false, error: '任务不存在，或还在排队/生成中' })
        pumpGen()
        return sendJson(res, 200, { ok: true, job })
      }
      if (req.method === 'GET') {
        const job = genStore.readJob(id)
        return sendJson(res, 200, job ? { ok: true, job } : { ok: false, error: '没有这个任务' })
      }
    }


    /* ══════════ 素材库 · 音色 / 片段 ══════════ */
    // 素材根目录：BILI_ASSETS 环境变量 > 素材库兄弟目录 assets-src
    const ASSETS_DIR = assetsRoot
    const ASSETS_MEDIA_TYPES = {
      '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
      '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
      '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    }
    const UPLOAD_KINDS = {
      font: { dir: 'fonts', exts: ['.ttf', '.otf', '.woff', '.woff2'], max: 30 * 1024 * 1024 },
      video: { dir: 'clips', exts: ['.mp4', '.mov', '.webm', '.mkv'], max: 1024 * 1024 * 1024 },
      audio: { dir: 'bgm', exts: ['.mp3', '.wav', '.m4a', '.flac', '.ogg'], max: 200 * 1024 * 1024 },
      image: { dir: 'images', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], max: 30 * 1024 * 1024 },
    }
    function readJsonArray(file) {
      try { const a = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] }
    }
    function appendJsonArray(file, entry) {
      const a = readJsonArray(file)
      a.push(entry)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(a, null, 2))
    }
    function probeSeconds(file) {
      try {
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', timeout: 15000, windowsHide: true })
        const n = Number(String(r.stdout || '').trim())
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
      } catch { return 0 }
    }
    function uploadName(raw) {
      let s = String(raw || '')
      try { s = decodeURIComponent(s) } catch { /* 原样 */ }
      if (!s || /[\/]|\.\./.test(s)) return ''
      return safeName(s)
    }
    function uniqueName(dir, name) {
      const ext = extname(name)
      const base = name.slice(0, name.length - ext.length)
      let out = name
      let i = 1
      while (existsSync(join(dir, out))) { out = `${base}-${i}${ext}`; i++; if (i > 999) break }
      return out
    }
    function assetsAbs(rel) {
      const parts = String(rel || '').split(/[\/]/)
      if (!parts.length || !['voices', 'clips', 'memes', 'bgm', 'stickers', 'fonts', 'images', 'generated', 'characters'].includes(parts[0])) return null
      if (parts.some((p) => !p || p === '..' || p === '.')) return null
      const abs = resolve(ASSETS_DIR(), ...parts)
      if (abs !== ASSETS_DIR() && !abs.startsWith(ASSETS_DIR() + sep)) return null
      return abs
    }

    /** 角色参考图：assets-src/characters/ 下的图片；有 character.json 的目录聚合成一组 */
    function characterItems() {
      const root = join(ASSETS_DIR(), 'characters')
      if (!existsSync(root)) return []
      const out = []
      const walk = (abs, rel, depth) => {
        if (depth > 3) return
        let ents = []
        try { ents = readdirSync(abs, { withFileTypes: true }) } catch { return }
        const cj = ents.find((e) => e.isFile() && e.name === 'character.json')
        if (cj && rel) {
          try {
            const meta = JSON.parse(readFileSync(join(abs, 'character.json'), 'utf8'))
            const refs = []
            const add = (v) => {
              if (typeof v === 'string') refs.push('characters/' + rel + '/' + v.replace(/^\/+/, ''))
              else if (v && typeof v === 'object') Object.values(v).forEach(add)
            }
            add(meta.refs)
            out.push({
              id: String(meta.id || rel.split(/[\\/]/).pop()),
              name: String(meta.name || meta.id || rel),
              file: refs[0] || '',
              refs,
              meta,
            })
            return
          } catch { /* 坏 json 继续按图片列 */ }
        }
        for (const ent of ents) {
          if (ent.isDirectory()) { walk(join(abs, ent.name), rel ? rel + '/' + ent.name : ent.name, depth + 1); continue }
          if (!/\.(png|jpe?g|webp|gif)$/i.test(ent.name)) continue
          const relFile = 'characters/' + (rel ? rel + '/' : '') + ent.name
          out.push({
            id: relFile.replace(/^characters\//, '').replace(/\.[^.]+$/, ''),
            name: ent.name.replace(/\.[^.]+$/, ''),
            file: relFile,
            refs: [relFile],
          })
        }
      }
      walk(root, '', 0)
      return out
    }

    if (req.method === 'GET' && path === '/assets/characters') {
      return sendJson(res, 200, { ok: true, items: characterItems() })
    }

    /** 音色试听：克隆音返回已有样本；Edge 音色现场生成短 mp3（异步，不阻塞宿主） */
    if (req.method === 'POST' && path === '/tts/preview') {
      const body = await readBody(req)
      const voice = String(body.voice || '').trim()
      const text = String(body.text || '大家好，这是当前音色的试听。').trim().slice(0, 120)
      if (!voice) return sendJson(res, 200, { ok: false, error: '音色为空' })
      const dir = join(ASSETS_DIR(), 'voices')
      mkdirSync(dir, { recursive: true })
      const clone = join(dir, '_clone-' + voice + '.wav')
      const ref = join(dir, voice + '.wav')
      if (!VOICES.has(voice)) {
        if (existsSync(clone)) return sendJson(res, 200, { ok: true, path: 'voices/' + '_clone-' + voice + '.wav', kind: 'clone', note: '克隆音样本' })
        if (existsSync(ref)) return sendJson(res, 200, { ok: true, path: 'voices/' + voice + '.wav', kind: 'reference', note: '参考音样本' })
        return sendJson(res, 200, { ok: false, error: '没有这个克隆音的样本' })
      }
      const safe = voice.replace(/[^a-zA-Z0-9-]/g, '')
      const out = join(dir, '_preview-' + safe + '.mp3')
      const args = ['--voice', voice, '--text', text, '--write-media', out]
      const runEdge = (bin) => new Promise((resolvePromise) => {
        let child
        try {
          child = spawn(bin, args, { windowsHide: true, stdio: 'ignore' })
        } catch (e) { return resolvePromise({ ok: false, error: String(e?.message ?? e) }) }
        const timer = setTimeout(() => { try { killTree(child) } catch { /* ignore */ } resolvePromise({ ok: false, error: '试听生成超时' }) }, 30_000)
        child.once('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, error: String(e?.message ?? e) }) })
        child.once('exit', (code) => { clearTimeout(timer); resolvePromise(code === 0 && existsSync(out) ? { ok: true } : { ok: false, error: 'edge-tts 退出码 ' + code }) })
      })
      let r = await runEdge(process.env.EDGE_TTS_BIN || 'edge-tts')
      if (!r.ok && /ENOENT|not found/i.test(String(r.error || ''))) {
        const fallback = join(process.env.USERPROFILE || homedir(), '.local', 'bin', process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts')
        r = await runEdge(fallback)
      }
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error })
      return sendJson(res, 200, { ok: true, path: 'voices/_preview-' + safe + '.mp3', kind: 'edge', note: '临时试听' })
    }

    /* ══════════ 创作蓝图：确认/编辑/预览 ══════════ */
    if (req.method === 'GET' && path === '/create/blueprint') {
      const id = String(q.get('id') || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      const blueprint = deriveBlueprint({ plan, project, cfg: loadCfg(), characters: characterItems() })
      if (!plan.blueprint && !project.legacy) {
        plan.blueprint = blueprint
        writeJson(plans.planFile(id, project.currentVersion), plan)
      }
      return sendJson(res, 200, { ok: true, project, plan, blueprint })
    }
    if (req.method === 'POST' && path === '/create/blueprint') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      if (project.legacy) return sendJson(res, 200, { ok: false, error: '旧方案不支持蓝图编辑' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      const bp = body.blueprint
      if (!bp || !Array.isArray(bp.sections)) return sendJson(res, 200, { ok: false, error: 'blueprint.sections 不合法' })
      const next = applyBlueprint(plan, bp)
      next.blueprint.updatedAt = new Date().toISOString()
      next.blueprint.approvedAt = ''
      writeJson(plans.planFile(id, project.currentVersion), next)
      const brief = bp.sections.find((s) => s.id === 'brief')
      if (brief?.content?.title) project.title = String(brief.content.title).slice(0, 80)
      const voice = bp.sections.find((s) => s.id === 'voice')
      if (voice?.enabled && voice.content?.voiceId) project.renderVoice = String(voice.content.voiceId).slice(0, 80)
      plans.saveProject(project)
      return sendJson(res, 200, { ok: true, project, plan: next, blueprint: next.blueprint })
    }
    if (req.method === 'POST' && path === '/create/blueprint/approve') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      const bp = body.blueprint || plan.blueprint
      if (!bp || !Array.isArray(bp.sections)) return sendJson(res, 200, { ok: false, error: '还没有可确认的蓝图' })
      bp.approvedAt = new Date().toISOString()
      const next = applyBlueprint(plan, bp)
      writeJson(plans.planFile(id, project.currentVersion), next)
      return sendJson(res, 200, { ok: true, project, plan: next, blueprint: next.blueprint })
    }
    if (req.method === 'POST' && path === '/create/blueprint/revise') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const sectionId = String(body.sectionId || '')
      const instruction = String(body.instruction || '').trim().slice(0, 300)
      if (!instruction) return sendJson(res, 200, { ok: false, error: '先写一句要改什么' })
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      const bp = deriveBlueprint({ plan, project, cfg: loadCfg(), characters: characterItems() })
      const section = bp.sections.find((s) => s.id === sectionId)
      if (!section) return sendJson(res, 200, { ok: false, error: '没有这个部分' })
      const tmpDir = join(STORE, 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const tag = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const inFile = join(tmpDir, `.bp-in-${tag}.json`)
      const outFile = join(tmpDir, `.bp-out-${tag}.json`)
      writeJson(inFile, { title: plan.title || project.title, section, instruction })
      const r = await runEngine('blueprint.mjs', ['--revise', '--in', inFile, '--out', outFile], 180_000)
      let data = null
      try { data = JSON.parse(readFileSync(outFile, 'utf8')) } catch { data = null }
      try { unlinkSync(inFile) } catch { /* ignore */ }
      try { unlinkSync(outFile) } catch { /* ignore */ }
      if (!r.ok || !data?.ok) return sendJson(res, 200, { ok: false, error: data?.error || 'AI 改这节失败（看日志）', log: (r.text || '').slice(-1500) })
      return sendJson(res, 200, { ok: true, content: data.content, model: data.model || '' })
    }

    /* ══════════ 制作阶段：关键帧 → 视频 → 组合 ══════════ */
    function productionView(project, plan) {
      const production = prod.ensureProduction(project)
      const rows = prod.shotRows(plan)
      const takes = prod.productionTakes(project.id)
      for (const phase of ['keyframes', 'videos']) {
        const conf = phase === 'keyframes' ? production.keyframes : production.videos
        for (const [shotId, list] of Object.entries(takes[phase])) {
          for (const t of list) t.selected = String(t.id) === String(conf?.[shotId]?.selectedAssetId || '')
        }
      }
      const allJobs = genStore.listJobs(400).filter((j) => j.projectId === project.id && j.phase)
      const jobs = {
        keyframe: allJobs.filter((j) => j.phase === 'keyframe'),
        video: allJobs.filter((j) => j.phase === 'video'),
      }
      const assembly = { status: 'idle', ...(production.assembly || {}) }
      let character = null
      try { character = prod.pickCharacter(plan, characterItems(), production) } catch { character = null }
      let voice = { enabled: true, voice: '' }
      try { voice = prod.voiceOf(plan, project, loadCfg()) } catch { voice = { enabled: true, voice: '' } }
      if (assembly.runId) {
        const st = renders.readStatus(assembly.runId)
        if (st) {
          assembly.stage = st.stage
          assembly.error = st.error || assembly.error || ''
          assembly.seconds = st.seconds || 0
          assembly.title = st.title || assembly.title || ''
          assembly.videoFile = st.files?.video || ''
          assembly.coverFile = st.files?.cover || ''
          if (st.stage === 'rendered') assembly.status = 'done'
          else if (st.stage === 'failed') assembly.status = 'failed'
          else if (st.stage === 'assembling') assembly.status = 'running'
        }
      }
      return {
        production, rows, takes, jobs, assembly, character, voice,
        approvedAt: plan?.blueprint?.approvedAt || '',
        canProduce: Boolean(plan?.blueprint?.approvedAt),
      }
    }

    if (req.method === 'GET' && path === '/create/production') {
      const id = String(q.get('id') || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      const had = Boolean(project.production)
      const view = productionView(project, plan)
      if (!had) plans.saveProject(project)
      return sendJson(res, 200, { ok: true, project, plan, ...view })
    }

    if (req.method === 'POST' && path === '/create/production') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      prod.mergeProduction(project, body.patch || {})
      plans.saveProject(project)
      return sendJson(res, 200, { ok: true, project, plan, ...productionView(project, plan) })
    }

    if (req.method === 'POST' && path === '/create/production/keyframes') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      if (!plan.blueprint?.approvedAt) return sendJson(res, 200, { ok: false, error: '先在「方案蓝图」里点确认，再生成关键帧' })
      const cfg = loadCfg()
      if (cfg.generation?.enabled === false) return sendJson(res, 200, { ok: false, error: '生成服务未启用' })
      const production = prod.ensureProduction(project)
      const all = prod.shotRows(plan).filter((r) => r.enabled)
      const wanted = Array.isArray(body.shotIds) ? body.shotIds.map(String) : []
      const rows = wanted.length ? all.filter((r) => wanted.includes(String(r.shotId))) : all
      if (!rows.length) return sendJson(res, 200, { ok: false, error: '没有可生成的分镜' })
      if (rows.length > 12) return sendJson(res, 200, { ok: false, error: '一次最多 12 镜，先分批生成' })
      const perShot = clampNum(body.perShot, 1, 2, 1)
      const takes = prod.productionTakes(id)
      const live = new Set(genStore.listJobs(300)
        .filter((j) => j.projectId === id && j.phase === 'keyframe' && ['queued', 'running'].includes(j.status))
        .map((j) => String(j.shotId)))
      const characters = characterItems()
      const jobs = []
      for (const row of rows) {
        if (live.has(String(row.shotId))) continue
        const existing = (takes.keyframes[row.shotId] || []).length
        for (let k = 0; k < perShot; k++) {
          const spec = prod.keyframeSpec({
            plan, project, cfg, characters, production, row, takeNo: existing + k + 1,
          })
          jobs.push(genStore.createJob(spec))
        }
      }
      if (jobs.length) pumpGen()
      plans.saveProject(project)
      log(`关键帧任务 ${id}：${jobs.length} 个`)
      return sendJson(res, 200, { ok: true, ...productionView(project, plan), jobs })
    }

    if (req.method === 'POST' && path === '/create/production/videos') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      if (!plan.blueprint?.approvedAt) return sendJson(res, 200, { ok: false, error: '先在「方案蓝图」里点确认，再生成视频' })
      const cfg = loadCfg()
      if (cfg.generation?.enabled === false) return sendJson(res, 200, { ok: false, error: '生成服务未启用' })
      const production = prod.ensureProduction(project)
      const takes = prod.productionTakes(id)
      const all = prod.shotRows(plan).filter((r) => r.enabled)
      const wanted = Array.isArray(body.shotIds) ? body.shotIds.map(String) : []
      const rows = wanted.length ? all.filter((r) => wanted.includes(String(r.shotId))) : all
      if (!rows.length) return sendJson(res, 200, { ok: false, error: '没有可生成的分镜' })
      if (rows.length > 8) return sendJson(res, 200, { ok: false, error: '一次最多 8 镜，先分批生成' })
      const live = new Set(genStore.listJobs(300)
        .filter((j) => j.projectId === id && j.phase === 'video' && ['queued', 'running'].includes(j.status))
        .map((j) => String(j.shotId)))
      const jobs = []
      const missing = []
      for (const row of rows) {
        if (live.has(String(row.shotId))) continue
        const sel = production.keyframes[row.shotId]?.selectedAssetId
        const keyframe = sel ? prod.findTake(takes.keyframes, row.shotId, sel) : null
        if (!keyframe) { missing.push({ shotId: row.shotId, n: row.n }); continue }
        const existing = (takes.videos[row.shotId] || []).length
        const spec = prod.videoSpec({ plan, project, cfg, production, row, keyframe, takeNo: existing + 1 })
        jobs.push(genStore.createJob(spec))
      }
      if (jobs.length) pumpGen()
      plans.saveProject(project)
      log(`视频任务 ${id}：${jobs.length} 个；缺关键帧 ${missing.length} 镜`)
      if (!jobs.length && missing.length) {
        return sendJson(res, 200, { ok: false, error: `还有 ${missing.length} 镜没选关键帧，先到「关键帧」页选图`, missing })
      }
      return sendJson(res, 200, { ok: true, ...productionView(project, plan), jobs, missing })
    }

    if (req.method === 'POST' && path === '/create/production/assemble') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const plan = plans.getVersion(id, project.currentVersion)
      if (!plan) return sendJson(res, 200, { ok: false, error: '方案不存在' })
      if (!plan.blueprint?.approvedAt) return sendJson(res, 200, { ok: false, error: '先在「方案蓝图」里点确认，再组合' })
      if (!existsSync(ASSEMBLY_WORKER)) return sendJson(res, 200, { ok: false, error: '缺少 production/assemble.mjs' })
      const production = prod.ensureProduction(project)
      if (production.assembly?.status === 'running') {
        const st = renders.readStatus(production.assembly.runId)
        if (st?.stage === 'assembling') return sendJson(res, 200, { ok: false, error: '已经有一个组合任务在跑' })
      }
      const takes = prod.productionTakes(id)
      const check = prod.assemblyCheck(plan, production, takes)
      if (!check.ok) {
        return sendJson(res, 200, {
          ok: false,
          error: check.missing.length
            ? `还有 ${check.missing.length} 镜没选视频：${check.missing.map((x) => `#${x.n}`).join('、')}`
            : '没有可组合的镜头',
          missing: check.missing,
        })
      }
      const slug = String(plan.title || project.title || 'ai-video')
        .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'ai-video'
      const base = `${today()}-${slug}-ai`
      let runId = base
      for (let n = 2; renders.findRunDir(runId); n++) runId = `${base}-${n}`
      const runDir = join(renders.runsDir(), runId)
      mkdirSync(runDir, { recursive: true })
      const voice = prod.voiceOf(plan, project, loadCfg())
      const wantVoice = body.voice === undefined ? voice.enabled : Boolean(body.voice)
      const spec = {
        projectId: project.id,
        version: project.currentVersion,
        runId,
        title: plan.title || project.title || '',
        subtitle: plan.subtitle || '',
        theme: plan.brief || project.brief || '',
        voice: wantVoice ? voice : { enabled: false, voice: '' },
        bgm: String(body.bgm || production.assembly?.bgm || ''),
        rows: check.ready.map(({ row, take }) => ({
          shotId: row.shotId, n: row.n, kind: row.kind, visual: row.visual, narration: row.narration,
          duration: row.duration, transition: row.transition,
          file: take.path || `generated/videos/${take.file}`, assetId: take.id,
        })),
      }
      writeJson(join(runDir, 'assembly.json'), spec)
      writeJson(join(runDir, 'script.json'), {
        title: spec.title, subtitle: spec.subtitle, theme: spec.theme,
        shots: spec.rows.map((r) => ({ kind: r.kind, narration: r.narration, duration: r.duration, assetId: r.assetId })),
        stats: { shotCount: spec.rows.length, narrationChars: spec.rows.reduce((n, r) => n + String(r.narration).replace(/\s/g, '').length, 0) },
      })
      renders.setStage(runId, 'assembling', {
        title: spec.title, subtitle: spec.subtitle, theme: spec.theme,
        shots: spec.rows.length, seconds: check.seconds, files: {}, needReview: false,
        projectId: project.id, projectVersion: project.currentVersion,
        createdAt: new Date().toISOString(),
      })
      production.assembly = {
        status: 'running', runId, stage: 'assembling', voice: voice.enabled,
        startedAt: new Date().toISOString(), error: '', at: new Date().toISOString(),
      }
      plans.saveProject(project)
      let child
      try {
        child = spawn(process.execPath, [ASSEMBLY_WORKER, '--project', id, '--run', runId], {
          cwd: HERE, env: genEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        production.assembly = { status: 'failed', runId, error: String(e?.message ?? e), at: new Date().toISOString() }
        plans.saveProject(project)
        renders.setStage(runId, 'failed', { error: production.assembly.error })
        return sendJson(res, 200, { ok: false, error: production.assembly.error })
      }
      assemblyRunning.set(runId, child)
      let tail = ''
      const take = (buf) => { tail = (tail + String(buf)).slice(-5000) }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      child.once('exit', (code) => {
        assemblyRunning.delete(runId)
        const st = renders.readStatus(runId)
        const fresh = plans.getProject(id)
        if (st?.stage !== 'failed' && code !== 0) {
          renders.setStage(runId, 'failed', { error: (tail.trim() || `assemble 退出码 ${code}`).slice(-2000) })
        }
        if (fresh) {
          const nowSt = renders.readStatus(runId)
          fresh.production = prod.ensureProduction(fresh)
          fresh.production.assembly = {
            ...fresh.production.assembly,
            status: nowSt?.stage === 'rendered' ? 'done' : 'failed',
            stage: nowSt?.stage || 'failed',
            error: nowSt?.stage === 'rendered' ? '' : (nowSt?.error || tail.trim().slice(-1200) || '组合失败'),
            at: new Date().toISOString(),
          }
          plans.saveProject(fresh)
        }
        log(`AI 组合结束 ${runId}：${renders.readStatus(runId)?.stage || '未知'}`)
      })
      log(`AI 组合开始 ${runId}：${spec.rows.length} 镜`)
      return sendJson(res, 200, { ok: true, runId, assembly: production.assembly, ...productionView(project, plan) })
    }

    if (req.method === 'POST' && path === '/create/production/assemble/cancel') {
      const body = await readBody(req)
      const id = String(body.id || '')
      const project = plans.getProject(id)
      if (!project) return sendJson(res, 200, { ok: false, error: '项目不存在' })
      const runId = String(body.runId || project.production?.assembly?.runId || '')
      const child = assemblyRunning.get(runId)
      if (child) killTree(child)
      assemblyRunning.delete(runId)
      if (runId) renders.setStage(runId, 'failed', { error: '已手动取消组合' })
      const fresh = plans.getProject(id)
      if (fresh) {
        fresh.production = prod.ensureProduction(fresh)
        fresh.production.assembly = { ...fresh.production.assembly, status: 'cancelled', stage: 'cancelled', error: '已手动取消', at: new Date().toISOString() }
        plans.saveProject(fresh)
      }
      return sendJson(res, 200, { ok: true, runId })
    }


    if (req.method === 'GET' && path === '/assets/fonts') {
      const dir = join(ASSETS_DIR(), 'fonts')
      if (!existsSync(dir)) return sendJson(res, 200, { ok: true, fonts: [], missing: true })
      const idx = readJsonArray(join(dir, 'index.json'))
      const byFile = new Map(idx.map((x) => [x.file, x]))
      const fonts = readdirSync(dir)
        .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
        .map((f) => {
          const st = statSync(join(dir, f))
          const meta = byFile.get(f) || {}
          const stem = f.replace(/\.[^.]+$/, '')
          return { file: f, name: meta.name || stem, family: meta.family || meta.name || stem, bytes: st.size }
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      return sendJson(res, 200, { ok: true, fonts })
    }
    if (req.method === 'GET' && path === '/assets/generated') {
      const kind = String(q.get('kind') || '').trim()
      const sub = kind === 'video' ? 'videos' : kind === 'image' ? 'images' : ''
      if (!sub) return sendJson(res, 200, { ok: false, error: 'kind 只能是 video / image' })
      const dir = join(ASSETS_DIR(), 'generated', sub)
      const missing = !existsSync(dir)
      const idx = readJsonArray(join(dir, 'index.json'))
      const byFile = new Map(idx.map((x) => [x.file, x]))
      const files = missing ? [] : readdirSync(dir).filter((f) => /\.(mp4|mov|webm|png|jpg|jpeg|webp)$/i.test(f))
      const items = files.map((f) => {
        const st = statSync(join(dir, f))
        const m = byFile.get(f) || {}
        return {
          id: m.id || f,
          file: f,
          kind,
          title: m.title || f.replace(/\.[^.]+$/, ''),
          prompt: m.prompt || '',
          model: m.model || '',
          provider: m.provider || '',
          seed: m.seed ?? null,
          params: m.params || null,
          parentId: m.parentId || '',
          operation: m.operation || '',
          status: m.status || 'draft',
          bytes: st.size,
          createdAt: m.createdAt || st.mtime.toISOString(),
        }
      }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return sendJson(res, 200, { ok: true, kind, missing, items })
    }
    if (req.method === 'GET' && path === '/assets/voices') {
      const dir = join(ASSETS_DIR(), 'voices')
      if (!existsSync(dir)) return sendJson(res, 200, { ok: true, dir, missing: true, voices: [] })
      const voices = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.wav') && !f.startsWith('_'))
        .map((f) => {
          const st = statSync(join(dir, f))
          let promptText = ''
          try { promptText = readFileSync(join(dir, f.replace(/\.wav$/i, '.txt')), 'utf8').trim() } catch { /* 没有参考文本 */ }
          return {
            file: f, name: f.replace(/\.wav$/i, ''), promptText,
            hasClone: existsSync(join(dir, '_clone-' + f)),
            bytes: st.size, mtime: st.mtimeMs,
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
      return sendJson(res, 200, { ok: true, dir, voices })
    }
    if (req.method === 'GET' && path === '/assets/clips') {
      let clips = []
      const clipsDir = join(ASSETS_DIR(), 'clips')
      const missing = !existsSync(clipsDir)
      try { clips = JSON.parse(readFileSync(join(clipsDir, 'index.json'), 'utf8')) } catch { /* 还没采过片段 */ }
      if (!Array.isArray(clips)) clips = []
      return sendJson(res, 200, { ok: true, dir: clipsDir, missing, clips })
    }
    if (req.method === 'GET' && path === '/assets/stickers') {
      const dir = join(ASSETS_DIR(), 'stickers', 'openmoji', 'png-618x618-color')
      if (!existsSync(dir)) return sendJson(res, 200, { ok: true, dir, missing: true, total: 0, files: [] })
      const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
      // emoji 定位查询：前端把 emoji 转成码点文件名后确认存在性
      const emojiFile = (q.get('emoji') || '').trim().replace(/\.png$/i, '')
      if (emojiFile) {
        if (!/^[0-9A-Fa-f-]{1,40}$/.test(emojiFile)) return sendJson(res, 200, { ok: true, exists: false })
        return sendJson(res, 200, { ok: true, exists: files.includes(`${emojiFile.toUpperCase()}.png`) })
      }
      // 分页：page 从 1 起，默认 pageSize=60，最大 200
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '60', 10) || 60))
      const start = (page - 1) * pageSize
      return sendJson(res, 200, { ok: true, total: files.length, page, pageSize, files: files.slice(start, start + pageSize) })
    }
    if (req.method === 'GET' && path === '/assets/memes') {
      let memes = []
      const memesDir = join(ASSETS_DIR(), 'memes', 'bili-emotes')
      const missing = !existsSync(memesDir)
      try { memes = JSON.parse(readFileSync(join(memesDir, 'index.json'), 'utf8')) } catch { /* 还没建索引 */ }
      if (!Array.isArray(memes)) memes = []
      // 可选按包筛选 + 分页：page 从 1 起，默认 pageSize=40，最大 200
      const pkg = (q.get('pkg') || '').trim()
      if (pkg) memes = memes.filter((m) => m && m.package === pkg)
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '40', 10) || 40))
      const start = (page - 1) * pageSize
      return sendJson(res, 200, { ok: true, dir: memesDir, missing, total: memes.length, page, pageSize, memes: memes.slice(start, start + pageSize) })
    }
    if (req.method === 'GET' && path === '/assets/bgm') {
      let bgm = []
      const bgmDir = join(ASSETS_DIR(), 'bgm')
      const missing = !existsSync(bgmDir)
      try { bgm = JSON.parse(readFileSync(join(bgmDir, 'index.json'), 'utf8')) } catch { /* 还没建索引 */ }
      if (!Array.isArray(bgm)) bgm = []
      // 可选按 mood 筛选（包含匹配）+ 分页：page 从 1 起，默认 pageSize=20，最大 200
      const mood = (q.get('mood') || '').trim()
      if (mood) bgm = bgm.filter((b) => b && String(b.mood || '').includes(mood))
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(q.get('pageSize') || '20', 10) || 20))
      const start = (page - 1) * pageSize
      return sendJson(res, 200, { ok: true, dir: bgmDir, missing, total: bgm.length, page, pageSize, bgm: bgm.slice(start, start + pageSize) })
    }
    if (req.method === 'POST' && path === '/assets/voice/harvest') {
      const body = await readBody(req)
      const name = String(body.name || '').trim()
      const bv = String(body.bv || '').trim()
      const from = Number(body.from)
      const to = Number(body.to)
      if (!/^[a-zA-Z0-9-]{2,20}$/.test(name)) return sendJson(res, 200, { ok: false, error: '名称只能是 2-20 位英文 / 数字 / 连字符' })
      if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, error: 'BV 号不对' })
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to - from < 3 || to - from > 60) {
        return sendJson(res, 200, { ok: false, error: '起止秒不对：3 ≤ 长度 ≤ 60' })
      }
      if (harvestRunningCount() >= HARVEST_MAX_CONCURRENT) {
        return sendJson(res, 200, { ok: false, error: `已有 ${HARVEST_MAX_CONCURRENT} 个采集任务在跑` })
      }
      // 环境预检：缺 yt-dlp / GPT-SoVITS / bili 直接失败，不让用户白等几分钟
      const envErr = harvestEnvCheck()
      const taskId = String(++harvestTaskSeq)
      if (envErr) {
        harvestJobs.set(taskId, {
          state: 'failed', error: envErr, file: '', promptText: '', name, bv,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        })
        scheduleHarvestCleanup(taskId)
        return sendJson(res, 200, { ok: false, taskId, error: envErr })
      }
      // 真正的流水线丢给分离的子进程（voice-harvest.mjs CLI），HTTP 立即返回
      const child = spawn(process.execPath, [
        join(ENGINE, 'voice-harvest.mjs'), '--bv', bv, '--from', String(from), '--to', String(to), '--name', name,
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      harvestJobs.set(taskId, {
        state: 'running', error: '', file: '', promptText: '', name, bv,
        startedAt: new Date().toISOString(), finishedAt: '', child,
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('error', (e) => {
        const j = harvestJobs.get(taskId)
        if (!j || j.state !== 'running') return
        j.state = 'failed'
        j.error = '子进程启动失败：' + String(e?.message ?? e)
        j.finishedAt = new Date().toISOString()
        scheduleHarvestCleanup(taskId)
      })
      child.on('close', (code) => {
        const j = harvestJobs.get(taskId)
        if (!j || j.state !== 'running') return
        j.finishedAt = new Date().toISOString()
        const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('__HARVEST_RESULT__'))
        let r = null
        if (line) { try { r = JSON.parse(line.slice('__HARVEST_RESULT__'.length)) } catch { r = null } }
        const produced = join(ASSETS_DIR(), 'voices', `${name}.wav`)
        if (r?.ok && existsSync(produced)) {
          j.state = 'done'
          j.file = r.file || `${name}.wav`
          j.promptText = r.promptText || ''
          log(`采音色 ${name}：${bv} ${from}-${to}s，${r.seconds ?? '?'}s 参考音已入库（后台任务 ${taskId}）`)
        } else {
          j.state = 'failed'
          j.error = r?.error || (out.trim().split(/\r?\n/).slice(-5).join('\n').slice(0, 500) || `子进程退出码 ${code}`)
        }
        scheduleHarvestCleanup(taskId)
      })
      log(`采音色任务 ${taskId} 已受理：${name} ← ${bv} ${from}-${to}s`)
      return sendJson(res, 200, { ok: true, taskId })
    }
    if (req.method === 'GET' && path === '/assets/voice/harvest/status') {
      const taskId = String(q.get('taskId') || '')
      const j = harvestJobs.get(taskId)
      if (!j) return sendJson(res, 200, { ok: false, error: '没有这个任务（可能已完成超过 30 分钟被清理）' })
      return sendJson(res, 200, {
        ok: true, taskId, state: j.state, error: j.error || '',
        file: j.file || '', promptText: j.promptText || '',
        name: j.name, bv: j.bv, startedAt: j.startedAt, finishedAt: j.finishedAt,
      })
    }
    if (req.method === 'POST' && path === '/assets/voice/import') {
      const body = await readBody(req)
      const src = String(body.path || '').trim()
      const name = String(body.name || '').trim()
      if (!/^[a-zA-Z0-9-]{2,20}$/.test(name)) return sendJson(res, 200, { ok: false, error: '名称只能是 2-20 位英文 / 数字 / 连字符' })
      if (!src || !isAbsolute(src)) return sendJson(res, 200, { ok: false, error: '请填 wav 文件的完整路径' })
      if (!/\.wav$/i.test(src)) return sendJson(res, 200, { ok: false, error: '只支持 .wav 文件' })
      if (!existsSync(src) || !statSync(src).isFile()) return sendJson(res, 200, { ok: false, error: '文件不存在：' + src })
      const dir = join(ASSETS_DIR(), 'voices')
      try { mkdirSync(dir, { recursive: true }) } catch { /* 建不了目录下面会报错 */ }
      const dest = join(dir, `${name}.wav`)
      try {
        cpSync(src, dest)
        const promptText = String(body.promptText || '').trim()
        if (promptText) writeFileSync(join(dir, `${name}.txt`), promptText, 'utf8')
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: '拷贝失败：' + String(e?.message ?? e) })
      }
      log(`导入音色 ${name}：${src} → ${dest}`)
      return sendJson(res, 200, { ok: true, file: `${name}.wav`, dir, promptText: Boolean(body.promptText) })
    }
    if (req.method === 'GET' && path === '/assets/media') {
      const file = assetsAbs(q.get('path') || '')
      if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found') }
      const st = statSync(file)
      const type = ASSETS_MEDIA_TYPES[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream'
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          const start = m[1] ? Number(m[1]) : 0
          const end = m[2] ? Number(m[2]) : st.size - 1
          if (start >= st.size || end < start) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` })
            return res.end()
          }
          res.writeHead(206, {
            'content-type': type, 'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1,
          })
          return createReadStream(file, { start, end }).pipe(res)
        }
      }
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
      return createReadStream(file).pipe(res)
    }
    if (req.method === 'POST' && path === '/assets/upload') {
      const kind = String(q.get('kind') || '')
      const cfg = UPLOAD_KINDS[kind]
      if (!cfg) return sendJson(res, 200, { ok: false, error: 'kind 只能是 font / video / audio / image' })
      const original = uploadName(req.headers['x-filename'])
      if (!original) return sendJson(res, 200, { ok: false, error: '文件名不合法' })
      const ext = extname(original).toLowerCase()
      if (!cfg.exts.includes(ext)) return sendJson(res, 200, { ok: false, error: `只支持 ${cfg.exts.join(' / ')}` })
      const dir = join(ASSETS_DIR(), cfg.dir)
      try { mkdirSync(dir, { recursive: true }) } catch { return sendJson(res, 200, { ok: false, error: '素材目录不可写' }) }
      const fileName = uniqueName(dir, original)
      const dest = join(dir, fileName)
      return await new Promise((resolveDone) => {
        const ws = createWriteStream(dest)
        let bytes = 0
        let done = false
        const fail = (msg) => {
          if (done) return
          done = true
          try { ws.destroy() } catch { /* ignore */ }
          try { unlinkSync(dest) } catch { /* ignore */ }
          sendJson(res, 200, { ok: false, error: msg })
          resolveDone()
        }
        req.on('data', (c) => {
          bytes += c.length
          if (bytes > cfg.max) { req.destroy(); fail('文件太大（上限 ' + Math.round(cfg.max / 1024 / 1024) + ' MB）') }
        })
        req.on('aborted', () => fail('上传中断'))
        ws.on('error', (e) => fail('写入失败：' + String(e?.message ?? e)))
        ws.on('finish', () => {
          if (done) return
          done = true
          try {
            if (kind === 'font') {
              const stem = fileName.replace(/\.[^.]+$/, '')
              const family = String(stem).replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 60) || 'LocalFont'
              appendJsonArray(join(dir, 'index.json'), { file: fileName, name: stem, family, bytes, license: '本地文件', addedAt: new Date().toISOString() })
            } else if (kind === 'video') {
              const seconds = probeSeconds(dest)
              appendJsonArray(join(dir, 'index.json'), {
                file: fileName, bv: '', url: '', title: fileName.replace(/\.[^.]+$/, ''), up: '本地',
                at: 0, dur: Math.round(seconds), seconds, license: '本地文件', source: 'local', fetchedAt: new Date().toISOString(),
              })
            } else if (kind === 'audio') {
              const seconds = probeSeconds(dest)
              appendJsonArray(join(dir, 'index.json'), {
                file: fileName, title: fileName.replace(/\.[^.]+$/, ''), artist: '本地', license: '本地文件',
                duration_seconds: seconds, source: 'local', mood: '本地',
              })
            }
            log(`导入本地${kind}：${fileName}（${(bytes / 1024 / 1024).toFixed(1)} MB）`)
            sendJson(res, 200, { ok: true, file: fileName, bytes, kind })
            resolveDone()
          } catch (e) { fail('入库失败：' + String(e?.message ?? e)) }
        })
        req.pipe(ws)
      })
    }
    if (req.method === 'POST' && path === '/assets/delete') {
      const body = await readBody(req)
      const kind = String(body.kind || '')
      const file = safeName(body.file)
      if (!file || file.startsWith('_')) {
        return sendJson(res, 200, { ok: false, error: '文件名不合法' })
      }
      if (kind === 'font') {
        const dir = join(ASSETS_DIR(), 'fonts')
        try { if (existsSync(join(dir, file))) unlinkSync(join(dir, file)) } catch { /* ignore */ }
        const idxFile = join(dir, 'index.json')
        const next = readJsonArray(idxFile).filter((x) => x.file !== file)
        try { mkdirSync(dir, { recursive: true }); writeFileSync(idxFile, JSON.stringify(next, null, 2)) } catch { /* ignore */ }
        log(`删除字体 ${file}`)
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'audio') {
        const dir = join(ASSETS_DIR(), 'bgm')
        try { if (existsSync(join(dir, file))) unlinkSync(join(dir, file)) } catch { /* ignore */ }
        const idxFile = join(dir, 'index.json')
        const next = readJsonArray(idxFile).filter((x) => x.file !== file)
        try { mkdirSync(dir, { recursive: true }); writeFileSync(idxFile, JSON.stringify(next, null, 2)) } catch { /* ignore */ }
        log(`删除本地音频 ${file}`)
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'voice') {
        const dir = join(ASSETS_DIR(), 'voices')
        const stem = file.replace(/\.wav$/i, '')
        for (const f of [file, stem + '.txt', '_clone-' + file]) {
          try { if (existsSync(join(dir, f))) unlinkSync(join(dir, f)) } catch { /* 删不掉就算了 */ }
        }
        log(`删除音色 ${file}（含参考文本与克隆音）`)
        return sendJson(res, 200, { ok: true })
      }
      if (kind === 'clip') {
        const idxFile = join(ASSETS_DIR(), 'clips', 'index.json')
        let clips = []
        try { clips = JSON.parse(readFileSync(idxFile, 'utf8')) } catch { /* 索引不存在 */ }
        if (!Array.isArray(clips)) clips = []
        const next = clips.filter((c) => c.file !== file)
        try { mkdirSync(join(ASSETS_DIR(), 'clips'), { recursive: true }); writeFileSync(idxFile, JSON.stringify(next, null, 2)) } catch { /* 写不进就算了 */ }
        try { if (existsSync(join(ASSETS_DIR(), 'clips', file))) unlinkSync(join(ASSETS_DIR(), 'clips', file)) } catch { /* 删不掉就算了 */ }
        log(`删除片段 ${file}`)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 200, { ok: false, error: 'kind 只能是 voice / clip / font / audio' })
    }

    /* ══════════ 审核 / 发布 ══════════ */
    if (req.method === 'GET' && path === '/review/list') {
      const runs = renders.listRuns()
        .filter((r) => r.hasVideo || ['rendered', 'approved', 'published', 'rejected'].includes(r.stage))
        .map((r) => ({ ...r, project: r.projectId ? plans.getProject(r.projectId) : null }))
      return sendJson(res, 200, { ok: true, runs, publishEnabled: loadCfg().publishEnabled })
    }
    if (req.method === 'GET' && path === '/review/media') {
      const runId = String(q.get('runId') || '')
      const kind = String(q.get('kind') || 'cover')
      const file = renders.mediaPath(runId, kind)
      if (!file || !existsSync(file)) { res.writeHead(404); return res.end('not found') }
      const st = statSync(file)
      const type = kind === 'cover' ? 'image/png' : 'video/mp4'
      const range = req.headers.range
      if (kind === 'video' && range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          const start = m[1] ? Number(m[1]) : 0
          const end = m[2] ? Number(m[2]) : st.size - 1
          if (start >= st.size || end < start) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` })
            return res.end()
          }
          res.writeHead(206, {
            'content-type': type, 'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1,
          })
          return createReadStream(file, { start, end }).pipe(res)
        }
      }
      res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
      return createReadStream(file).pipe(res)
    }
    if (req.method === 'POST' && path === '/review/delete') {
      const body = await readBody(req)
      const runId = safeName(body.runId)
      if (!runId) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      const live = jobs.get(runId)
      if (live?.stage === 'running') return sendJson(res, 200, { ok: false, error: '正在渲染，等渲染完再删' })
      const ok = renders.deleteRun(runId)
      if (!ok) return sendJson(res, 200, { ok: false, error: '删除失败（文件不在素材库目录）' })
      if (st.projectId) {
        const p = plans.getProject(st.projectId)
        const curRun = p?.runDir ? String(p.runDir).split(/[\\/]/).filter(Boolean).pop() : ''
        if (p && curRun === runId) {
          p.stage = 'draft'
          p.runDir = ''
          p.review = null
          plans.saveProject(p)
        }
      }
      log(`删除成片 ${runId}（只删本地，不动 B站 已发布内容）`)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/review/decision') {
      const body = await readBody(req)
      const runId = String(body.runId || '')
      const state = body.state === 'rejected' ? 'rejected' : 'approved'
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      renders.setReview(runId, state, body.note)
      memory.addEvent('review', { runId, state, text: `审核《${st.title || runId}》：${state === 'approved' ? '通过' : '打回'}${body.note ? `，备注：${String(body.note).slice(0, 40)}` : ''}` })
      if (st.projectId) {
        const p = plans.getProject(st.projectId)
        if (p) {
          p.stage = state === 'approved' ? 'approved' : 'rejected'
          p.review = { state, at: new Date().toISOString(), note: String(body.note || '') }
          plans.saveProject(p)
        }
      }
      log(`审核 ${runId}：${state}`)
      // 打回原因 / 通过偏好是复盘的重要素材，审完跑一次（节流在 reflect.mjs）
      runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
      return sendJson(res, 200, { ok: true, status: renders.readStatus(runId) })
    }
    if (req.method === 'GET' && path === '/review/stats') {
      const runId = String(q.get('runId') || '')
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      const bvid = String(st.bvid || st.review?.bvid || '')
      if (!bvid) return sendJson(res, 200, { ok: false, error: '这条还没有 BV 号（没真投稿过）' })
      const r = await runBiliAsync(['upload', 'stats', bvid], { timeoutMs: 60000 })
      return sendJson(res, 200, { ok: r.ok, bvid, data: r.data || null, error: r.error || null })
    }
    if (req.method === 'POST' && path === '/review/upload') {
      const body = await readBody(req)
      const runId = String(body.runId || '')
      const st = renders.readStatus(runId)
      if (!st) return sendJson(res, 200, { ok: false, error: '成片不存在' })
      const cfg = loadCfg()
      const video = renders.mediaPath(runId, 'video')
      if (!video || !existsSync(video)) return sendJson(res, 200, { ok: false, error: '没有成片文件' })
      const dryRun = body.dryRun !== false
      if (!dryRun) {
        if (!cfg.publishEnabled) return sendJson(res, 200, { ok: false, error: '「允许真投稿」还没打开（我的 → 发布权限）' })
        if (body.confirm !== true) return sendJson(res, 200, { ok: false, error: '真投稿需要二次确认' })
        if (st.review?.state !== 'approved' && st.stage !== 'approved') return sendJson(res, 200, { ok: false, error: '先点「通过」再投稿' })
      }
      const tags = (Array.isArray(body.tags) ? body.tags : cfg.defaultTags).map(String).filter(Boolean).slice(0, 10)
      if (!tags.length) return sendJson(res, 200, { ok: false, error: '至少一个标签' })
      const args = []
      if (dryRun) args.push('--dry-run')
      args.push('upload', 'video', video, '--title', String(body.title || st.title || '未命名').slice(0, 80))
      for (const t of tags) args.push('--tag', t)
      const desc = String(body.desc || st.subtitle || '').slice(0, 1500)
      // 合规：AI 声明由 bili CLI 默认勾选；简介末尾再追加中性文字声明，双保险
      const declaration = '本视频包含 AI 生成内容'
      const descFull = desc ? `${desc}\n\n${declaration}` : declaration
      args.push('--desc', descFull)
      const cover = renders.mediaPath(runId, 'cover')
      if (cover && existsSync(cover)) args.push('--cover', cover)
      if (body.zone || cfg.defaultZone) args.push('--zone', String(Number(body.zone || cfg.defaultZone)))
      const r = await runBiliAsync(args, { timeoutMs: 15 * 60_000 })
      if (r.ok && !dryRun) {
        const bvid = r.data?.bvid || r.data?.data?.bvid || ''
        renders.markPublished(runId, { bvid, title: String(body.title || st.title || '') })
        if (st.projectId) {
          const p = plans.getProject(st.projectId)
          if (p) { p.stage = 'published'; p.publishedBvid = bvid; plans.saveProject(p) }
        }
        memory.addEvent('publish', { runId, bvid, text: `投稿了《${String(body.title || st.title || '').slice(0, 30)}》${bvid ? '（' + bvid + '）' : ''}` })
        log(`已投稿 ${runId} → ${bvid || '(无 BV)'}`)
        runReflect()
        .then((r) => { if (r && !r.ok && !r.skipped) log('复盘失败：' + String(r.error || '').split('\n')[0]) })
        .catch((e) => { log('复盘异常：' + String(e?.message ?? e).split('\n')[0]) })
      }
      return sendJson(res, 200, {
        ok: r.ok, dryRun, command: [runBiliName(), ...args],
        data: r.data || null, error: r.error || null, text: r.error?.message || '',
      })
    }

    /* ══════════ 自己的视频（B站合集） ══════════ */
    if (req.method === 'GET' && path === '/canon/state') {
      return sendJson(res, 200, { ok: true, ...canon.status() })
    }
    if (req.method === 'POST' && path === '/canon/refresh') {
      const body = await readBody(req)
      const url = String(body.url || '').trim()
      if (url) saveCfg({ selfVideosUrl: url })
      const r = canon.refresh(loadCfg().selfVideosUrl, { force: true })
      if (!r.ok) return sendJson(res, 200, r)
      return sendJson(res, 200, { ok: true, refreshed: true, status: canon.status() })
    }

    /* ══════════ 主人 @ 任务（看视频 / 看评论 / 总结） ══════════ */
    if (req.method === 'GET' && path === '/owner/tasks') {
      const f = join(STORE, 'owner', 'tasks.json')
      let tasks = []
      try { tasks = JSON.parse(readFileSync(f, 'utf8'))?.tasks || [] } catch { tasks = [] }
      return sendJson(res, 200, { ok: true, tasks: tasks.slice(0, 30) })
    }
    if (req.method === 'POST' && path === '/owner/check') {
      const r = await runEngine('owner-task.mjs', ['--tick', '--force'], 15 * 60_000)
      return sendJson(res, 200, { ok: r.ok, log: String(r.text || '').slice(-2500) })
    }

    /* ══════════ 互动：预览 / dry-run / 受控发送 ══════════ */
    if (req.method === 'GET' && path === '/interact/state') {
      const cfg = loadCfg()
      return sendJson(res, 200, { ok: true, config: publicCfg(cfg), counts: interact.dayCounts(), commented: interact.commentedMap() })
    }
    if (req.method === 'POST' && path === '/interact/preview') {
      const body = await readBody(req)
      const kind = ['comment', 'reply', 'dm'].includes(body.kind) ? body.kind : 'comment'
      const cfg = loadCfg()
      let text = String(body.text || '').trim()
      let model = ''
      let logText = ''
      if (kind === 'reply') {
        const isOwner = body.owner === true
        const audit = auditMessage(body.message || '', { isOwner })
        if (!audit.allow) {
          if (isOwner && audit.reason === 'owner-dangerous') {
            return sendJson(res, 200, {
              ok: true, kind, model: 'audit-refused', cap: null,
              text: `${cfg.ownerCall || '老弟'}，这个操作得去工作台「刷B站设置」手动改，我在评论里不执行配置或发布操作。`,
            })
          }
          return sendJson(res, 200, {
            ok: true, kind, model: 'audit-refused', cap: null,
            blocked: true, reason: audit.reason,
            text: refusalText(body.message || '', audit.reason),
          })
        }
      }
      if (!text && body.owner && kind === 'reply') {
        const cmd = answerOwnerCommandDetailed(body.message || '', cfg)
        if (cmd) {
          // 数字先由本地脚本算准，再按人设改写；数字对不上就自动退回原句
          let out = cmd.text
          if (cmd.kind !== 'refuse') {
            try { out = await voiceOwnerStats(cmd.text, { persona: cfg.personaPrompt, ownerCall: cfg.ownerCall }) } catch { /* 用原句 */ }
          }
          return sendJson(res, 200, {
            ok: true, text: out, cap: null, kind,
            model: cmd.kind === 'refuse' ? 'owner-command' : 'owner-command+voice',
          })
        }
      }
      if (!text) {
        const ctx = kind === 'comment'
          ? {
            title: body.title || '', up: body.up || '', quotes: body.quotes || [], ownerCall: cfg.ownerCall, calls: callNames(cfg),
            selfVideos: canon.renderBlock(body.title || ''),
            memoryRecall: memory.renderRecallBlock(body.title || '', { k: 3 }),
          }
          : {
            message: body.message || '', replyingTo: body.replyingTo || '', video: body.video || '',
            owner: body.owner === true, ownerCall: cfg.ownerCall,
            selfVideos: canon.renderBlock(body.message || body.video || ''),
            memoryRecall: memory.renderRecallBlock(body.message || body.video || '', { k: 3 }),
          }
        const r = await runEngine('compose.mjs', ['--kind', kind, '--context', JSON.stringify(ctx)], 120_000)
        logText = r.text.slice(-1500)
        try {
          const j = JSON.parse((r.text.match(/\{[\s\S]*\}\s*$/) || ['{}'])[0])
          if (j.ok) { text = String(j.text || ''); model = j.model || '' }
        } catch { /* 下面统一报错 */ }
        if (!text) return sendJson(res, 200, { ok: false, error: '生成失败（看日志）', log: logText })
      }
      const cap = await interact.checkCap(kind, cfg)
      return sendJson(res, 200, { ok: true, text, model, cap, kind })
    }
    if (req.method === 'POST' && path === '/interact/send') {
      const body = await readBody(req)
      const kind = ['comment', 'reply', 'dm'].includes(body.kind) ? body.kind : ''
      if (!kind) return sendJson(res, 200, { ok: false, error: 'kind 不对' })
      const cfg = loadCfg()
      const text = String(body.text || '').trim().slice(0, 500)
      if (!text) return sendJson(res, 200, { ok: false, error: '没有内容' })
      const cap = await interact.checkCap(kind, cfg)
      if (cap) return sendJson(res, 200, { ok: false, error: cap })
      if (body.confirm !== true) return sendJson(res, 200, { ok: false, error: '需要二次确认' })

      const dryRun = body.dryRun === true
      const args = []
      if (dryRun) args.push('--dry-run')
      if (kind === 'comment') {
        const bv = String(body.bv || '').trim()
        if (!BV_RE.test(bv)) return sendJson(res, 200, { ok: false, error: 'BV 号不对' })
        args.push('comment', 'post', bv, text)
        for (const t of mentionTargets(cfg)) args.push('--at', t.target)
      } else if (kind === 'reply') {
        const bv = String(body.bv || '').trim()
        const rpid = String(body.rpid || '').trim()
        if (!BV_RE.test(bv) || !/^\d+$/.test(rpid)) return sendJson(res, 200, { ok: false, error: '回复参数不完整' })
        args.push('comment', 'reply', bv, rpid, text)
        if (body.root) args.push('--root', String(body.root))
        if (cfg.mentionName) args.push('--at', cfg.mentionName)
      } else {
        const uid = String(body.uid || cfg.dmUid || '').trim()
        if (!uid) return sendJson(res, 200, { ok: false, error: '没填私信对象 UID' })
        args.push('dm', 'send', uid, text)
      }

      const r = await runBiliAsync(args, { timeoutMs: 60000 })
      if (r.ok && !dryRun) {
        if (kind === 'comment') await interact.markComment(body.bv, { text })
        if (kind === 'reply') await interact.markReply(body.rpid, { text })
        if (kind === 'dm') await interact.markDm(body.uid || cfg.dmUid, { text })
        const what = kind === 'comment' ? '评论了' : kind === 'reply' ? '回复了' : '私信了'
        memory.addEvent(kind === 'dm' ? 'dm' : kind, {
          bv: body.bv || '', text: `${what}《${String(body.title || body.bv || '').slice(0, 26)}》：${text.slice(0, 46)}`,
        })
        log(`互动已发送（${kind}）：${text.slice(0, 40)}`)
      }
      return sendJson(res, 200, {
        ok: r.ok, dryRun, command: [runBiliName(), ...args],
        data: r.data || null, error: r.error || null, text: r.error?.message || '',
      })
    }

    /* ══════════ 调度（刷B站设置） ══════════ */
    if (req.method === 'GET' && path === '/config') {
      const cfg = loadCfg()
      const sched = loadSched()
      const prog = rangeProgress(cfg.scheduleRanges)
      return sendJson(res, 200, {
        ok: true, config: publicCfg(cfg),
        schedule: {
          ...sched, running: roundRunning, todayCount: collectedToday(),
          inWindow: prog.inWindow, target: targetToday(cfg), totalMinutes: prog.total,
          estMinutes: prog.total > 0 ? Math.max(1, Math.round(prog.total / Math.max(1, cfg.perDay))) : 0,
        },
        store: storeStats(),
      })
    }
    if (req.method === 'POST' && path === '/config') {
      const body = await readBody(req)
      const patch = {}
      const copyKeys = [
        'enabled', 'keywords', 'llmKey', 'scheduleRanges', 'perDay',
        'personaPrompt', 'reportLevel', 'favFolderId',
        'memoryEnabled', 'userCharLimit', 'memoryCharLimit', 'reflectEnabled', 'memoryEventsMax',
        'selfVideosEnabled', 'selfVideosUrl', 'selfVideosRefreshHours',
        'autoComment', 'autoReply', 'ownerUid', 'ownerUids', 'ownerCall', 'mentionName', 'mentions', 'replyPerDay', 'commentImageEvery',
        'ownerTasksEnabled', 'ownerTaskPollMinutes', 'ownerTaskPerDay', 'ownerTaskAllowDm', 'ownerTaskMaxAgeHours',
        'publicMentionsEnabled', 'publicMentionPerDay', 'mentionVision',
        'dmWatch', 'dmWatchMinutes', 'dmReplyPerDay', 'dmOwnerUid',
        'voice', 'modelChain', 'visionChain', 'concurrency', 'generation',
        'publishEnabled', 'defaultTags', 'defaultZone',
      ]
      for (const k of copyKeys) if (k in body) patch[k] = body[k]
      // 前端回传占位符 = 用户没改密钥，保留旧值不覆盖
      if (patch.llmKey === '__SAVED__') delete patch.llmKey
      const cfg = saveCfg(patch)
      return sendJson(res, 200, { ok: true, config: publicCfg(cfg) })
    }

    /* ══════════ 文本模型端点：拉列表 / 熔断状态 / 手动重置 ══════════ */
    if (req.method === 'GET' && path === '/llm/models') {
      const base = llmBase()
      const key = llmKeyValue()
      if (!key) return sendJson(res, 200, { ok: false, base, error: '还没有模型密钥（设置里的 llmKey / 环境变量 OC_API_KEY）' })
      try {
        const r = await fetch(base + '/models', {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        })
        const text = await r.text()
        if (!r.ok) return sendJson(res, 200, { ok: false, base, error: `HTTP ${r.status} ${text.slice(0, 200)}` })
        let j = {}
        try { j = JSON.parse(text) } catch { return sendJson(res, 200, { ok: false, base, error: '端点返回的不是 JSON' }) }
        const models = (j.data || []).map((m) => ({
          id: String(m.id || ''),
          modalities: m.metadata?.input_modalities || m.input_modalities || [],
          reasoning: Boolean(m.reasoning),
        })).filter((m) => m.id)
        return sendJson(res, 200, { ok: true, base, models })
      } catch (e) {
        return sendJson(res, 200, { ok: false, base, error: String(e?.message ?? e).slice(0, 300) })
      }
    }
    if (req.method === 'GET' && path === '/llm/state') {
      return sendJson(res, 200, { ok: true, base: llmBase(), state: readLlmBreaker() })
    }
    if (req.method === 'POST' && path === '/llm/reset-breaker') {
      resetLlmBreaker()
      return sendJson(res, 200, { ok: true, reset: true, state: readLlmBreaker() })
    }
    if (req.method === 'POST' && path === '/run-round') {
      const cfg = loadCfg()
      const done = collectedToday()
      const remain = Math.max(0, cfg.perDay - done)
      if (remain <= 0) return sendJson(res, 200, { ok: false, error: `今天已经到上限（${done}/${cfg.perDay}）` })
      const r = await runRound('manual', { count: Math.min(3, remain) })
      return sendJson(res, 200, r)
    }
    if (req.method === 'GET' && path === '/duty-log') {
      if (!existsSync(logFile())) return sendJson(res, 200, { ok: true, text: '' })
      const t = readFileSync(logFile(), 'utf8')
      return sendJson(res, 200, { ok: true, text: t.slice(-12000) })
    }
    if (req.method === 'POST' && path === '/open-folder') {
      const body = await readBody(req)
      const target = body.what === 'runs' ? renders.runsDir() : STORE
      try {
        const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false })
        child.unref()
        return sendJson(res, 200, { ok: true, path: target })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (req.method === 'GET' && path === '/model/health') {
      const r = await runOp('gen.mjs', ['--health'], 30000)
      let data = null
      try { data = JSON.parse((r.text.match(/\{[\s\S]*\}\s*$/) || ['{}'])[0]) } catch { data = null }
      return sendJson(res, 200, { ok: Boolean(data?.reachable), data, error: r.ok ? null : r.text.slice(-500) })
    }

    /* ══════════ 记忆（长期偏好 / 工作台事实） ══════════ */
    if (req.method === 'GET' && path === '/memory') {
      try { return sendJson(res, 200, { ok: true, ...memory.snapshot() }) }
      catch (e) { return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) }) }
    }
    if (req.method === 'POST' && path === '/memory/op') {
      const body = await readBody(req)
      let r
      if (Array.isArray(body.operations)) r = await memory.applyBatch(body.operations, { source: body.source || 'panel' })
      else r = await memory.apply(body, { source: body.source || 'panel' })
      log(`记忆操作：${Array.isArray(body.operations) ? 'batch' : `${body.target}.${body.action}`} → ${r.ok ? 'OK' : String(r.error || '').split('\n')[0]}`)
      return sendJson(res, 200, { ok: r.ok, error: r.error || null, result: r })
    }
    if (req.method === 'POST' && path === '/memory/pending/approve') {
      const body = await readBody(req)
      const r = await memory.approvePending(body.id)
      return sendJson(res, 200, { ok: r.ok, error: r.error || null, result: r })
    }
    if (req.method === 'POST' && path === '/memory/pending/discard') {
      const body = await readBody(req)
      return sendJson(res, 200, memory.discardPending(body.id))
    }
    if (req.method === 'POST' && path === '/memory/reflect') {
      const r = await runReflect({ force: true })
      log(r.ok ? `手动复盘完成：新记 ${r.added} 条` : `复盘未执行：${r.skipped || r.error || ''}`)
      return sendJson(res, 200, r)
    }
    if (req.method === 'GET' && path === '/memory/events') {
      const type = String(q.get('type') || '')
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 50, 200))
      return sendJson(res, 200, { ok: true, events: memory.listEvents({ type, limit }) })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-wb',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-workbench: /api/bili-wb 路由')
  } catch (e) {
    try { ctx.logger?.warn?.('[bili-workbench] 路由没挂上：' + String(e?.message ?? e)) } catch { /* ignore */ }
  }

  /* ── 生成任务：上次遗留的 running 标中断，queued 继续跑 ── */
  try {
    const n = genStore.recoverInterrupted()
    if (n) log(`生成队列：${n} 个中断任务已标记，可重试`)
    pumpGen()
  } catch (e) {
    log('生成队列恢复失败：' + String(e?.message ?? e))
  }

  /* ── 自己的视频：启动时补一次缓存，之后每 6 小时看一次是否过期 ── */
  canon.ensureFresh()
    .then((st) => { if (st?.epCount) log(`自己的视频：${st.title} · ${st.epCount} 集`) })
    .catch(() => { /* 离线时用旧缓存 */ })
  try {
    const canonTimer = setInterval(() => { canon.ensureFresh().catch(() => { /* 忽略 */ }) }, 6 * 3600_000)
    canonTimer.unref?.()
    ctx.effect(() => () => clearInterval(canonTimer), 'bili-workbench: 自己的视频定时器')
  } catch { /* ignore */ }

  /* ── 主人 @ 任务：每分钟看一眼是否到点（频率可配置） ── */
  const ownerTick = async () => {
    try {
      const cfg = loadCfg()
      const hasOwner = Boolean(cfg.ownerUid || (cfg.ownerUids || []).length)
      const ownerOn = cfg.ownerTasksEnabled !== false && hasOwner
      const publicOn = cfg.publicMentionsEnabled !== false && Number(cfg.publicMentionPerDay) > 0
      if (!ownerOn && !publicOn) return
      const every = Math.max(1, Number(cfg.ownerTaskPollMinutes) || 3) * 60_000
      if (Date.now() - ownerTaskLast < every) return
      if (ownerTaskRunning) return
      ownerTaskRunning = true
      ownerTaskLast = Date.now()
      const r = await runEngine('owner-task.mjs', ['--tick'], 15 * 60_000)
      if (!r.ok) log('主人 @ 任务失败：' + String(r.text || '').slice(-300))
      else {
        const m = /完成：处理 (\d+) 条/.exec(String(r.text || ''))
        if (m && Number(m[1]) > 0) log(`主人 @ 任务：处理 ${m[1]} 条`)
      }
    } catch (e) {
      log('主人 @ 任务异常：' + (e?.message ?? e))
    } finally {
      ownerTaskRunning = false
    }
  }
  try {
    const ownerKick = setTimeout(ownerTick, 60_000)
    ownerKick.unref?.()
    const ownerTimer = setInterval(ownerTick, 60_000)
    ownerTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(ownerKick); clearInterval(ownerTimer) }, 'bili-workbench: 主人任务定时器')
  } catch (e) { log('主人任务定时器没起来：' + (e?.message ?? e)) }

  /* ── 采集定时器：按时段 + 每日上限平均分配，每分钟看一次 ── */
  try {
    const timer = setInterval(() => {
      try {
        const cfg = loadCfg()
        if (!cfg.enabled) return
        const prog = rangeProgress(cfg.scheduleRanges)
        if (!prog.inWindow || prog.total <= 0) return
        const target = targetToday(cfg)
        const done = collectedToday()
        if (done >= target) return
        if (roundRunning) return
        const sched = loadSched()
        const last = Date.parse(sched.lastRunAt || '') || 0
        // 上一轮一条新的都没采到（热门页重复），10 分钟内别反复打
        if (sched.lastAdded === 0 && Date.now() - last < 10 * 60_000) return
        const n = Math.min(target - done, 3)
        log(`定时器触发（目标 ${target} / 已采 ${done}，本轮 ${n}）`)
        runRound('timer', { count: n }).catch((e) => log('定时轮次异常：' + (e?.message ?? e)))
      } catch (e) {
        log('定时器这一跳出错（已兜住）：' + (e?.message ?? e))
      }
    }, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'bili-workbench: 采集定时器')
  } catch (e) { log('采集定时器没起来：' + (e?.message ?? e)) }

  /* ── 自动回复：每 3 分钟看一次 feed replies（只回 is_new，账本防重复） ── */
  let replyRunning = false
  const autoReplyTick = async () => {
    try {
      const cfg = loadCfg()
      if (!cfg.autoReply) return
      if (replyRunning) return
      const done = interact.dayCounts().replies
      if (cfg.replyPerDay > 0 && done >= cfg.replyPerDay) return
      replyRunning = true
      const limit = cfg.replyPerDay > 0 ? Math.min(cfg.replyPerDay - done, 5) : 5
      const r = await runEngine('auto-reply.mjs', ['--limit', String(Math.max(1, limit))], 5 * 60_000)
      if (r.text) log('自动回复：' + r.text.slice(-500))
    } catch (e) {
      log('自动回复异常：' + (e?.message ?? e))
    } finally {
      replyRunning = false
    }
  }
  try {
    const kick = setTimeout(() => { autoReplyTick() }, 45_000)
    kick.unref?.()
    const replyTimer = setInterval(() => { autoReplyTick() }, 3 * 60_000)
    replyTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(kick); clearInterval(replyTimer) }, 'bili-workbench: 自动回复定时器')
  } catch (e) { log('自动回复定时器没起来：' + (e?.message ?? e)) }

  /* ── 长任务：每 10 分钟看一次有没有到点的任务（一个任务一轮） ── */
  try {
    // 上次进程在任务中途退出：别让卡片永远卡在“逛B站中”
    for (const t of tasks.list()) {
      if (['checking', 'collecting', 'planning'].includes(t.status)) {
        tasks.update(t.id, { status: 'queued', nextRunAt: new Date().toISOString() })
        tasks.addLog(t.id, '宿主重启，任务已恢复排队')
      }
    }
    const taskKick = setTimeout(() => {
      if (!roundRunning && !taskRunning && tasks.due().length) kickTask()
    }, 20_000)
    taskKick.unref?.()
    const taskTimer = setInterval(() => {
      try {
        if (roundRunning || taskRunning) return
        if (tasks.due().length) kickTask()
      } catch (e) { log('长任务定时器这一跳出错：' + (e?.message ?? e)) }
    }, 10 * 60_000)
    taskTimer.unref?.()
    ctx.effect(() => () => { clearTimeout(taskKick); clearInterval(taskTimer) }, 'bili-workbench: 长任务定时器')
  } catch (e) { log('长任务定时器没起来：' + (e?.message ?? e)) }

  /* ── 重启恢复：上次渲染到一半被重启，项目别永远卡在「渲染中」 ── */
  try {
    // 老版本成片在 bili-op/runs（插件目录里，升级会被清）；先迁到素材库 renders/
    const moved = renders.migrateLegacyRuns()
    if (moved) log(`已迁移 ${moved} 个旧成片到素材库 renders/`)
    for (const p of plans.listProjects()) {
      if (p.legacy) continue
      if (p.stage === 'rendering') {
        const runId = p.runDir ? String(p.runDir).split(/[\\/]/).filter(Boolean).pop() : ''
        const st = runId ? renders.readStatus(runId) : null
        if (st?.stage === 'rendered' || st?.stage === 'approved' || st?.stage === 'published') p.stage = st.stage
        else p.stage = 'draft'
        plans.saveProject(p)
        log(`恢复项目 ${p.id} 状态 → ${p.stage}`)
      } else if (p.stage === 'rendered' && (!p.runDir || !existsSync(p.runDir))) {
        p.stage = 'draft'
        p.runDir = ''
        plans.saveProject(p)
        log(`项目 ${p.id} 的成片文件已不存在，状态改回草稿`)
      }
    }
  } catch (e) { log('项目状态恢复失败：' + (e?.message ?? e)) }

  /* ── 插件卸载/宿主退出：杀掉还在跑的渲染/采音色子进程，避免孤儿 ── */
  try {
    const cleanupChildren = () => {
      for (const j of jobs.values()) if (j.stage === 'running' && j.child) killTree(j.child)
      for (const j of harvestJobs.values()) if (j.state === 'running' && j.child) killTree(j.child)
      for (const g of genRunning.values()) killTree(g.child)
      genRunning.clear()
    }
    ctx.effect(() => {
      process.once('SIGTERM', cleanupChildren)
      process.once('SIGINT', cleanupChildren)
      process.once('beforeExit', cleanupChildren)
      return () => {
        process.off('SIGTERM', cleanupChildren)
        process.off('SIGINT', cleanupChildren)
        process.off('beforeExit', cleanupChildren)
        cleanupChildren()
      }
    }, 'bili-workbench: 子进程清理')
  } catch { /* ignore */ }

  log(`工作台已挂载（库=${STORE}）`)
  try { ctx.logger?.info?.('[bili-workbench] 已挂载（库=' + STORE + '）') } catch { /* ignore */ }
}

function runBiliName() {
  return process.platform === 'win32' ? 'bili.exe' : 'bili'
}
