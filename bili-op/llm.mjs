/**
 * llm.mjs —— 打我们自己的模型端点（40080，OpenAI 兼容）
 *
 * 规矩：
 *  · key 从环境变量读（OC_API_KEY 或 BILI_OP_LLM_KEY），**不写进源码**
 *  · 模型带失败自动轮换（第一个能用就一直用；报错就换下一个）
 *  · chatJSON 负责把"带 ``` 围栏 / 前后有废话"的输出抠成 JSON
 */

export const LLM_BASE = (process.env.BILI_OP_LLM_BASE || 'http://127.0.0.1:40080/v1').replace(/\/+$/, '')
/** 密钥每次调用动态解析：env 优先，兜底读素材库 config.json 的 llmKey。
 *  之前在 import 时冻结成 const，宿主进程内调用（复盘/语气改写）在「key 只存 config」的常规配置下永远拿不到（审查 BUG-3）。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
function key() {
  const env = process.env.OC_API_KEY || process.env.BILI_OP_LLM_KEY
  if (env) return env
  const candidates = []
  if (process.env.BILI_STORE) candidates.push(join(process.env.BILI_STORE, 'config.json'))
  try {
    const loc = join(homedir(), '.dsh-bili-workbench', 'location.json')
    if (existsSync(loc)) {
      // location.json 历史上两种字段都出现过：store / storePath
      const j = JSON.parse(readFileSync(loc, 'utf8'))
      const p = j.storePath || j.store
      if (p) candidates.push(join(p, 'config.json'))
    }
  } catch { /* location 坏了就走默认 */ }
  candidates.push(join(homedir(), '.dsh-bili-workbench', 'store', 'config.json'))
  for (const f of candidates) {
    try {
      if (!existsSync(f)) continue
      const k = String(JSON.parse(readFileSync(f, 'utf8')).llmKey || '').trim()
      if (k) return k
    } catch { /* 下一个 */ }
  }
  return ''
}
/** 模型链每次调用时读 env：进程内调用（reflect/语气改写）可能在启动后才设置 BILI_OP_MODELS */
export function models() {
  return (process.env.BILI_OP_MODELS || 'pulse-alpha-free,deepseek-v4.1-flash-free,glm-5.3-flash-free,big-pickle')
    .split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * 识图子智能体的模型链（独立于主链）。
 * 主链会轮换到纯文本模型，所以**不能**靠主链识图；识图必须有单独的能力声明。
 * 默认按 2026-11-05 实测可用排序（只有这四个真的能吃图）：
 *   pulse-alpha-free / deepseek-v4.1-flash-free / glm-5.3-flash-free /
 *   mimo-v2.6-flash-free / nemotron-3.5-super-vl-free
 *   crouton-alpha-free 声明支持图但本机 403（地区限制），不进默认链。
 */
export function visionModels() {
  return (process.env.BILI_OP_VISION_MODELS || 'pulse-alpha-free,deepseek-v4.1-flash-free,glm-5.3-flash-free,mimo-v2.6-flash-free,nemotron-3.5-super-vl-free')
    .split(',').map((s) => s.trim()).filter(Boolean)
}
let modelIdx = 0
export const currentModel = () => {
  const m = models()
  return m[((modelIdx % m.length) + m.length) % m.length]
}

/* ---------- 熔断与重试上限 ----------
 *
 * 背景：模型链全挂时，每次 chat() 都会把整条链打一遍（模型数 × 每模型尝试次数），
 * 而调用方通常还在循环处理多条视频/评论，叠上并发就形成请求风暴
 * （2026-10-28 实测：3 个模型全部 Model is unavailable，单波 250 次请求、约 12 分钟一波）。
 *
 * 闸门设计（两层，都在出站唯一出口，调用方不需要各自实现）：
 *   1. 连续整链失败达到上限（默认 3 次）→ **永久停止**，之后 chat() 直接抛错、不再探测上游；
 *      只有「保存模型链/密钥」或「手动重置熔断」才会解除（2026-11-05 按主人要求改）；
 *   2. 请求预算 → 累计发出请求数超上限后同样直接抛错。
 * 成功一次即清零连续失败计数。
 *
 * ⚠️ 状态必须落盘：真实调用链是 index.js 用 spawn 起子进程（auto-comment/judge/...），
 * 每个子进程都是全新模块实例。只存内存变量的话计数每次归零，熔断永远不触发。
 * 因此 failStreak / breakerUntil / 当日请求数都写进 store 下的 llm_breaker.json。
 */
const CHAIN_FAIL_LIMIT = Math.max(1, Number(process.env.BILI_OP_CHAIN_FAIL_LIMIT || 3))
// 旧版是冷却 10 分钟后自动重试；现在改为永久停止，保留变量只为兼容旧状态文件
const CHAIN_COOLDOWN_MS = Math.max(0, Number(process.env.BILI_OP_CHAIN_COOLDOWN_MS || 10 * 60_000))
// 0 = 不限。默认按「每小时」给一个宽松上限：正常调用远达不到，故障时能兜住风暴。
const CHAIN_REQUEST_BUDGET = Math.max(0, Number(process.env.BILI_OP_CHAIN_REQUEST_BUDGET || 120))
const BUDGET_WINDOW_MS = 60 * 60_000

/** 定位闸门状态文件：优先素材库目录（各进程一致），取不到就让调用方退化到内存模式。 */
function breakerFile() {
  try {
    const dir = process.env.BILI_STORE
      || (() => {
        try {
          const loc = join(homedir(), '.dsh-bili-workbench', 'location.json')
          if (existsSync(loc)) {
            const j = JSON.parse(readFileSync(loc, 'utf8'))
            const p = j.storePath || j.store
            if (p) return p
          }
        } catch { /* 下面走默认 */ }
        return join(homedir(), '.dsh-bili-workbench', 'store')
      })()
    return join(dir, 'llm_breaker.json')
  } catch { return '' }
}

const BREAKER_FILE = breakerFile()
// 内存兜底：文件不可用时至少保证单进程内有效
let memState = { failStreak: 0, breakerUntil: 0, stopped: false, stoppedAt: 0, windowStart: 0, requestCount: 0 }

function readState() {
  if (!BREAKER_FILE) return { ...memState }
  try {
    if (!existsSync(BREAKER_FILE)) return { ...memState }
    const d = JSON.parse(readFileSync(BREAKER_FILE, 'utf8'))
    return {
      failStreak: Number(d.failStreak) || 0,
      breakerUntil: Number(d.breakerUntil) || 0,
      stopped: Boolean(d.stopped),
      stoppedAt: Number(d.stoppedAt) || 0,
      windowStart: Number(d.windowStart) || 0,
      requestCount: Number(d.requestCount) || 0,
    }
  } catch { return { ...memState } }
}

function writeState(s) {
  memState = { ...s }
  if (!BREAKER_FILE) return
  try {
    mkdirSync(dirname(BREAKER_FILE), { recursive: true })
    writeFileSync(BREAKER_FILE, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }))
  } catch { /* 落盘失败不影响主流程，内存态仍然有效 */ }
}

/** 请求预算按滑动窗口计：窗口过期就把计数归零重开。 */
function stateWithWindow(s) {
  const now = Date.now()
  if (!s.windowStart || now - s.windowStart > BUDGET_WINDOW_MS) {
    return { ...s, windowStart: now, requestCount: 0 }
  }
  return s
}

/** 供调用方/诊断查看当前闸门状态 */
export const chainState = () => {
  const s = stateWithWindow(readState())
  return {
    failStreak: s.failStreak,
    breakerUntil: s.breakerUntil,
    stopped: Boolean(s.stopped),
    stoppedAt: s.stoppedAt || 0,
    requestCount: s.requestCount,
    failLimit: CHAIN_FAIL_LIMIT,
    requestBudget: CHAIN_REQUEST_BUDGET,
    persistent: Boolean(BREAKER_FILE),
  }
}

/** 手动重置：清掉「永久停止」和连续失败计数，允许重新探测上游。 */
export function resetBreaker() {
  const s = stateWithWindow(readState())
  writeState({ ...s, failStreak: 0, breakerUntil: 0, stopped: false, stoppedAt: 0, requestCount: 0 })
  return chainState()
}

/** 判断一个错误是不是「不该再继续尝试」的闸门错误（调用方用它在循环里提前结束） */
export const isStopError = (e) => e?.code === 'CHAIN_BREAKER' || e?.code === 'REQUEST_BUDGET'

function chainGuard() {
  const s = stateWithWindow(readState())
  const now = Date.now()
  if (s.stopped) {
    const e = new Error(
      `模型链已停止（连续 ${s.failStreak} 次整链失败），不再探测上游。` +
      '检查 40080 端点/模型名后，在工作台「设置 → 模型顺序」保存，或点「重置熔断」再试。',
    )
    e.code = 'CHAIN_BREAKER'
    throw e
  }
  // 兼容旧状态文件：旧版写的冷却时间到了就自动放行
  if (s.breakerUntil && now < s.breakerUntil) {
    const left = Math.ceil((s.breakerUntil - now) / 1000)
    const e = new Error(
      `模型链已熔断（连续 ${s.failStreak} 次整链失败），${left} 秒内不再请求上游。` +
      '请检查模型链配置或上游额度后再试。',
    )
    e.code = 'CHAIN_BREAKER'
    throw e
  }
  if (CHAIN_REQUEST_BUDGET > 0 && s.requestCount >= CHAIN_REQUEST_BUDGET) {
    const mins = Math.ceil((s.windowStart + BUDGET_WINDOW_MS - now) / 60000)
    const e = new Error(
      `本小时已达上游请求上限 ${CHAIN_REQUEST_BUDGET} 次（${mins} 分钟后重置），` +
      '停止继续尝试以免故障时打成风暴。',
    )
    e.code = 'REQUEST_BUDGET'
    throw e
  }
}

/** 每发一个请求记一次；同时再查一遍预算，保证同一轮整链重试里也能及时刹车。 */
function noteRequest() {
  const s = stateWithWindow(readState())
  if (CHAIN_REQUEST_BUDGET > 0 && s.requestCount >= CHAIN_REQUEST_BUDGET) {
    chainGuard()
  }
  writeState({ ...s, requestCount: s.requestCount + 1 })
}

/** 整链失败达到上限时永久停止；成功则清零连续失败计数。 */
function noteChainResult(ok) {
  const s = stateWithWindow(readState())
  if (ok) {
    if (s.failStreak !== 0 || s.breakerUntil !== 0 || s.stopped) {
      writeState({ ...s, failStreak: 0, breakerUntil: 0, stopped: false, stoppedAt: 0 })
    }
    return
  }
  const failStreak = s.failStreak + 1
  const next = { ...s, failStreak }
  if (failStreak >= CHAIN_FAIL_LIMIT) {
    // 不再按冷却时间自动恢复：主人要求「全部模型连续失败 3 次就停止打上游」
    next.stopped = true
    next.stoppedAt = Date.now()
    next.breakerUntil = 0
    console.log(
      `  [停止] 连续 ${failStreak} 次整链失败，不再探测上游（保存模型链或手动重置后恢复）`,
    )
  }
  writeState(next)
}

export function assertKey() {
  const k = key()
  if (!k) {
    throw new Error(
      '没有模型密钥。设置环境变量 OC_API_KEY，或在工作台「刷B站 → 刷B站设置」里填模型密钥（存到 bili-store/config.json 的 llmKey）。例如：\n' +
      '  $env:OC_API_KEY="..."   # 只在当前终端生效',
    )
  }
}
export const currentKey = () => key()

/**
 * 一次对话。返回纯文本。
 * @param {{role:string,content:string|any[]}[]} messages
 * @param {{maxTokens?:number,temperature?:number,timeoutMs?:number,chain?:string[],noRotate?:boolean}} opts
 *   chain：显式指定模型链（识图子智能体用）；不传则用主链
 *   noRotate：失败不推进全局轮换下标（识图不该影响主链的下一个模型）
 */
export async function chat(messages, { maxTokens = 3000, temperature = 0.4, timeoutMs = 180000, chain = null, noRotate = false } = {}, depth = 0) {
  assertKey()
  const list = Array.isArray(chain) && chain.length ? chain : models()
  if (!list.length) throw new Error('模型链是空的：在「刷B站 → 设置 → 模型链」里至少填一个模型')
  // 熔断/预算闸门：放在最前面，命中就一个请求都不发
  chainGuard()
  const KEY = key()
  const tried = []
  const waitMs = Number(process.env.BILI_OP_429_WAIT || 15000)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 显式传了 chain 就按它自己的顺序轮换，不碰主链下标
  let localIdx = 0

  for (let attempt = 0; attempt < list.length; attempt++) {
    const model = chain ? list[((localIdx % list.length) + list.length) % list.length] : currentModel()
    // 每个模型最多试 2 次（429 限流时退避一次再试，别立刻放弃）
    for (let inner = 0; inner < 2; inner++) {
      // 每次真正发请求前过闸：一个请求都不多发
      noteRequest()
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(`${LLM_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
          signal: ctrl.signal,
        })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          const is429 = res.status === 429 || /rate_limit/i.test(t)
          if (is429 && inner === 0) {
            console.log(`  ${model} 限流，${Math.round(waitMs / 1000)} 秒后重试…`)
            clearTimeout(timer)
            await sleep(waitMs)
            continue
          }
          throw new Error(`HTTP ${res.status} ${t.slice(0, 160)}`)
        }
        const j = await res.json()
        const text = j?.choices?.[0]?.message?.content
        // ⚠️ 推理型模型会把 max_tokens 全花在 reasoning 上 ⇒ content 空。
        //    这不是"模型挂了"，是 token 给少了：加倍再试**一次**（depth 守卫：
        //    之前是无深度限制的递归，弱模型持续空回复会无限循环烧钱，审查 BUG-7）。
        if (!text || !String(text).trim()) {
          if (inner === 0 && depth < 1) {
            clearTimeout(timer)
            const bigger = Math.min(Math.max(maxTokens * 2, 6000), 16000)
            console.log(`  ${model} 空回复（reasoning 吃光 token）⇒ 加到 ${bigger} 再试`)
            // 递归时把 chain/noRotate 一起带下去，否则识图会偷渡回主链
            return await chat(messages, { maxTokens: bigger, temperature, timeoutMs, chain, noRotate }, depth + 1)
          }
          throw new Error('空回复（可能 max_tokens 被 reasoning 吃光）')
        }
        noteChainResult(true)
        return { text: String(text), model, usage: j?.usage || null }
      } catch (e) {
        if (inner === 1 || !/空回复|429|rate_limit/i.test(String(e?.message ?? e))) {
          tried.push(`${model}: ${e?.message ?? e}`)
          if (chain) localIdx++
          else if (!noRotate) modelIdx++
          break
        }
      } finally {
        clearTimeout(timer)
      }
    }
    if (attempt === list.length - 1) {
      // 整条链走完都没成功：记一次「整链失败」，达到上限即开闸
      noteChainResult(false)
      const err = new Error('所有模型都失败了：\n  ' + tried.join('\n  '))
      err.code = 'CHAIN_EXHAUSTED'
      throw err
    }
  }
  throw new Error('unreachable')
}

/** 抠 JSON：去掉 ``` 围栏，从第一个 { 或 [ 开始找配对的结尾 */
export function extractJson(text) {
  let t = String(text || '').trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = t.search(/[[{]/)
  if (start < 0) throw new Error('回复里没有 JSON：' + t.slice(0, 200))
  const openCh = t[start]
  const closeCh = openCh === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) return JSON.parse(t.slice(start, i + 1))
    }
  }
  throw new Error('JSON 没闭合：' + t.slice(start, start + 200))
}

/** 要 JSON 的对话；解析失败会重试一次（把报错喂回去让它自己修） */
export async function chatJSON(messages, opts = {}) {
  const first = await chat(messages, opts)
  try {
    return { json: extractJson(first.text), model: first.model, raw: first.text, usage: first.usage }
  } catch (e) {
    const retry = await chat([
      ...messages,
      { role: 'assistant', content: first.text.slice(0, 4000) },
      { role: 'user', content: `上面那段不是合法 JSON（${e.message}）。请**只输出**合法 JSON，不要解释、不要代码块围栏。` },
    ], opts)
    return { json: extractJson(retry.text), model: retry.model, raw: retry.text, usage: retry.usage }
  }
}

/** 健康检查：能不能连上、哪些模型可用 */
export async function health() {
  const k = key()
  const out = { base: LLM_BASE, hasKey: Boolean(k), models: models(), reachable: false, modelList: [] }
  try {
    const r = await fetch(`${LLM_BASE}/models`, { headers: k ? { authorization: `Bearer ${k}` } : {} })
    out.reachable = r.ok
    if (r.ok) {
      const j = await r.json()
      out.modelList = (j?.data || []).map((m) => m.id)
    }
  } catch (e) { out.error = String(e?.message ?? e) }
  return out
}
