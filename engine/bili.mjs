/**
 * bili.mjs —— 调本机 `bili` 命令（工作台引擎用）
 * 和面板那半端同一套规矩：强制 UTF-8、失败也解析 stdout 里的 {ok:false,error}。
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 环境清洗：绕开 bili-cli 的一个 bug。
 *
 * 本机 NO_PROXY 里带 `[::1]`（IPv6 回环的方括号写法）。`bili auth login` 会把它
 * 当成 "host:port" 解析，直接崩：
 *   InvalidURL: Invalid port: ':1]'
 * 复现范围很窄 —— 只有 auth login 这一步，其他命令都正常。但面板的「扫码登录」
 * 正好走它，所以在这里统一把方括号形式摘掉（保留 `::1`，语义不变）。
 *
 * 只动子进程环境，不改用户系统变量；也没必要因为别人的 bug 让整台机器变形。
 */
function cleanEnv() {
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  for (const k of ['NO_PROXY', 'no_proxy']) {
    const v = env[k]
    if (!v || !v.includes('[::1]')) continue
    env[k] = v.split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== '[::1]')
      .join(',')
  }
  return env
}

export function biliBin() {
  const env = process.env.BILI_BIN
  if (env) return env
  const exe = process.platform === 'win32' ? 'bili.exe' : 'bili'
  const local = join(homedir(), '.local', 'bin', exe)
  return existsSync(local) ? local : 'bili'
}

export function runBili(args, { timeoutMs = 60000 } = {}) {
  const t0 = Date.now()
  const r = spawnSync(biliBin(), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: cleanEnv(),
  })
  // spawnSync 自身失败（ENOENT = bili 命令不存在、被信号杀、超时等）不能当"没输出"吞掉
  if (r.error) {
    const enoent = r.error.code === 'ENOENT'
    return {
      ok: false, data: null, ms: Date.now() - t0,
      error: enoent
        ? { code: 'bili-missing', message: '未找到 bili 命令（bili CLI）。安装：pip install bili-agent 或 uv tool install bili-agent，详见 README' }
        : { code: r.error.code || 'spawn-error', message: String(r.error.message || r.error).slice(0, 300) },
    }
  }
  const out = String(r.stdout || '').trim()
  let parsed = null
  try { parsed = JSON.parse(out) } catch {
    const lines = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    for (let i = lines.length - 1; i >= 0 && parsed === null; i--) {
      try { parsed = JSON.parse(lines[i]) } catch { /* 往上继续找 */ }
    }
  }
  const ms = Date.now() - t0
  if (!parsed) {
    return { ok: false, data: null, error: { code: 'no_json', message: (r.stderr || out || 'no output').slice(0, 300) }, ms }
  }
  return { ok: parsed.ok === true, data: parsed.data || null, error: parsed.error || null, ms }
}

/**
 * runBili 的异步版：宿主进程（dsh 面板路由）必须用这个。
 * spawnSync 会冻结事件循环 —— 投稿/看懂这类长命令（最长 15 分钟）会把整个 dsh 宿主
 * 卡死（所有 tab、其他插件、轮询全部无响应）。engine 里的 CLI 脚本跑在独立子进程，
 * 用同步版没问题；只有 index.js 的请求处理必须走这里。
 * 返回结构与 runBili 完全一致。
 */
export function runBiliAsync(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now()
    let out = ''
    let errText = ''
    let child
    try {
      child = spawn(biliBin(), args, { encoding: 'utf8', windowsHide: true, env: cleanEnv() })
    } catch (e) {
      resolvePromise({ ok: false, data: null, ms: 0, error: { code: 'spawn-error', message: String(e?.message || e).slice(0, 300) } })
      return
    }
    let done = false
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolvePromise(r) } }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已退出 */ }
      finish({ ok: false, data: null, ms: Date.now() - t0, error: { code: 'timeout', message: `bili 命令超时（${timeoutMs}ms）已终止` } })
    }, timeoutMs)
    child.on('error', (e) => {
      const enoent = e.code === 'ENOENT'
      finish({
        ok: false, data: null, ms: Date.now() - t0,
        error: enoent
          ? { code: 'bili-missing', message: '未找到 bili 命令（bili CLI）。安装：pip install bili-agent 或 uv tool install bili-agent，详见 README' }
          : { code: e.code || 'spawn-error', message: String(e.message || e).slice(0, 300) },
      })
    })
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { errText += d })
    child.on('close', () => {
      const text = out.trim()
      let parsed = null
      try { parsed = JSON.parse(text) } catch {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
        for (let i = lines.length - 1; i >= 0 && parsed === null; i--) {
          try { parsed = JSON.parse(lines[i]) } catch { /* 往上继续找 */ }
        }
      }
      const ms = Date.now() - t0
      if (!parsed) {
        finish({ ok: false, data: null, error: { code: 'no_json', message: (errText || text || 'no output').slice(0, 300) }, ms })
        return
      }
      finish({ ok: parsed.ok === true, data: parsed.data || null, error: parsed.error || null, ms })
    })
  })
}

/** B站 公开接口拿封面（bili 的 video info 里没有 pic 字段） */
export async function fetchCover(bv) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) bili-workbench',
      referer: 'https://www.bilibili.com/',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) return null
  const j = await r.json()
  const pic = j?.data?.pic
  if (!pic) return null
  const img = await fetch(String(pic).replace(/^http:/, 'https:'), {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!img.ok) return null
  return Buffer.from(await img.arrayBuffer())
}
