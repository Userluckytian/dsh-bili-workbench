/**
 * llm.mjs —— 打我们自己的模型端点（40080，OpenAI 兼容）
 *
 * 规矩：
 *  · key 从环境变量读（OC_API_KEY 或 BILI_OP_LLM_KEY），**不写进源码**
 *  · 模型带失败自动轮换（第一个能用就一直用；报错就换下一个）
 *  · chatJSON 负责把"带 ``` 围栏 / 前后有废话"的输出抠成 JSON
 */

export const LLM_BASE = (process.env.BILI_OP_LLM_BASE || 'http://127.0.0.1:40080/v1').replace(/\/+$/, '')
const KEY = process.env.OC_API_KEY || process.env.BILI_OP_LLM_KEY || ''
export const MODELS = (process.env.BILI_OP_MODELS || 'deepseek-v4.1-flash,big-pickle,glm-5.3-flash')
  .split(',').map((s) => s.trim()).filter(Boolean)

let modelIdx = 0
export const currentModel = () => MODELS[((modelIdx % MODELS.length) + MODELS.length) % MODELS.length]

export function assertKey() {
  if (!KEY) {
    throw new Error(
      '没有模型密钥。设置环境变量 OC_API_KEY（我们自己的 40080 端点），例如：\n' +
      '  $env:OC_API_KEY="..."   # 只在当前终端生效\n' +
      '或者写进 bili-op/config.json 的 llmKey 字段（该文件不进 git）。',
    )
  }
}

/**
 * 一次对话。返回纯文本。
 * @param {{role:string,content:string}[]} messages
 */
export async function chat(messages, { maxTokens = 3000, temperature = 0.4, timeoutMs = 180000 } = {}) {
  assertKey()
  const tried = []
  const waitMs = Number(process.env.BILI_OP_429_WAIT || 15000)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const model = currentModel()
    // 每个模型最多试 2 次（429 限流时退避一次再试，别立刻放弃）
    for (let inner = 0; inner < 2; inner++) {
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
        //    这不是"模型挂了"，是 token 给少了：**无条件**加倍再试一次（上限 16k）。
        if (!text || !String(text).trim()) {
          if (inner === 0) {
            clearTimeout(timer)
            const bigger = Math.min(Math.max(maxTokens * 2, 6000), 16000)
            console.log(`  ${model} 空回复（reasoning 吃光 token）⇒ 加到 ${bigger} 再试`)
            return await chat(messages, { maxTokens: bigger, temperature, timeoutMs })
          }
          throw new Error('空回复（可能 max_tokens 被 reasoning 吃光）')
        }
        return { text: String(text), model, usage: j?.usage || null }
      } catch (e) {
        if (inner === 1 || !/空回复|429|rate_limit/i.test(String(e?.message ?? e))) {
          tried.push(`${model}: ${e?.message ?? e}`)
          modelIdx++
          break
        }
      } finally {
        clearTimeout(timer)
      }
    }
    if (attempt === MODELS.length - 1) {
      throw new Error('所有模型都失败了：\n  ' + tried.join('\n  '))
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
  const out = { base: LLM_BASE, hasKey: Boolean(KEY), models: MODELS, reachable: false, modelList: [] }
  try {
    const r = await fetch(`${LLM_BASE}/models`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} })
    out.reachable = r.ok
    if (r.ok) {
      const j = await r.json()
      out.modelList = (j?.data || []).map((m) => m.id)
    }
  } catch (e) { out.error = String(e?.message ?? e) }
  return out
}
