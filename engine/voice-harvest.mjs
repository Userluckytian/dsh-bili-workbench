/**
 * voice-harvest.mjs —— 一键采音色：从 B站 视频指定秒数区间自动采一个参考音色。
 *
 * 流水线（全同步 spawnSync，调用方在路由里直接调）：
 *   1. runBili 验证视频 + 拉逐字稿（没字幕直接失败，不引 whisper，保持零依赖）
 *   2. yt-dlp 按区间下载音频到临时目录
 *   3. demucs（GPT-SoVITS venv）分人声
 *   4. 取区间内字幕最密的 ≤9.5s 窗口，loudnorm / 32k / mono 输出 assets-src/voices/<name>.wav
 *   5. 窗口内字幕行拼接写 <name>.txt 作为参考文本
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runBili } from './bili.mjs'
import { assetsRoot } from './store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = here

/** GPT-SoVITS venv python（demucs 装在里面） */
function sovitsPython() {
  const p = join(ENGINE_DIR, '..', '..', 'refs', 'GPT-SoVITS', '.venv', 'Scripts', 'python.exe')
  return existsSync(p) ? p : ''
}

const normItems = (d) => (Array.isArray(d?.items) ? d.items : [])
  .map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, content: String(x.content || '').trim() }))
  .filter((x) => x.content)

/**
 * 在 [from, to] 区间里挑字幕最密的 ≤9.5s 窗口。
 * 滑窗锚在每个字幕行的起点；优先行数最多且覆盖 ≥3s 的，没有就退回覆盖最长的。
 */
function pickWindow(items, from, to, maxLen = 9.5) {
  const rel = items
    .map((x) => ({ from: Math.max(0, x.from - from), to: Math.max(0, (x.to || x.from + 2) - from), content: x.content }))
    .filter((x) => x.to > 0 && x.from < to - from)
    .sort((a, b) => a.from - b.from)
  if (!rel.length) return null
  let best = null
  for (const anchor of rel) {
    const w0 = anchor.from
    const w1 = w0 + maxLen
    const rows = rel.filter((x) => x.from >= w0 && x.from < w1)
    if (!rows.length) continue
    const span = Math.max(0, Math.min(rows[rows.length - 1].to, w1) - w0)
    const cand = { start: from + w0, end: from + Math.min(w1, to), rows, count: rows.length, span }
    if (!best
      || (cand.span >= 3 && (best.span < 3 || cand.count > best.count))
      || (cand.span < 3 && best.span < 3 && cand.span > best.span)) best = cand
  }
  return best
}

export function harvestVoice({ bv, from, to, name }) {
  const t0 = Date.now()
  const info = runBili(['video', 'info', bv], { timeoutMs: 60000 })
  if (!info.ok) {
    return { ok: false, error: '视频信息获取失败：' + (info.error?.message || info.error?.code || '未知错误') }
  }

  // 1. 逐字稿（只关心 [from, to] 内的行）
  const sub = runBili(['video', 'subtitle', bv], { timeoutMs: 90000 })
  const inRange = normItems(sub.data).filter((x) => x.to > from && x.from < to)
  if (!inRange.length) {
    return { ok: false, error: '该视频无字幕，暂不支持自动采集' }
  }
  const win = pickWindow(inRange, from, to)
  if (!win) return { ok: false, error: '该视频无字幕，暂不支持自动采集' }

  // 2. yt-dlp 按区间下载音频
  const tmpBase = join(tmpdir(), `bili-voice-${Date.now()}`)
  const outTpl = join(tmpBase, 'audio.%(ext)s')
  mkdirSync(tmpBase, { recursive: true })
  const yd = spawnSync('yt-dlp', [
    '--no-playlist', '-f', 'ba/b',
    '--download-sections', `*${from}-${to}`,
    '-o', outTpl,
    `https://www.bilibili.com/video/${bv}`,
  ], { encoding: 'utf8', timeout: 5 * 60_000, windowsHide: true })
  if (yd.status !== 0) {
    rmSync(tmpBase, { recursive: true, force: true })
    const tail = String(yd.stderr || yd.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n')
    return { ok: false, error: `yt-dlp 下载失败（退出码 ${yd.status}）：\n${tail.slice(0, 500)}` }
  }
  const produced = readdirSync(tmpBase)
    .filter((f) => f.startsWith('audio.') && extname(f) !== '.part')
    .map((f) => join(tmpBase, f))
  if (!produced.length) {
    rmSync(tmpBase, { recursive: true, force: true })
    return { ok: false, error: 'yt-dlp 退出码 0 但没有产物' }
  }

  try {
    // 3. demucs 分人声
    const py = sovitsPython()
    if (!py) return { ok: false, error: 'GPT-SoVITS 环境未安装' }
    const demucsOut = join(tmpBase, 'demucs')
    mkdirSync(demucsOut, { recursive: true })
    const dm = spawnSync(py, [
      '-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-o', demucsOut, produced[0],
    ], { encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true })
    if (dm.status !== 0) {
      const tail = String(dm.stderr || dm.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n')
      return { ok: false, error: `demucs 分离失败（退出码 ${dm.status}）：\n${tail.slice(0, 500)}` }
    }
    const stemBase = produced[0].replace(/\.[^.]+$/, '').split(/[\\/]/).pop() || 'audio'
    const vocals = join(demucsOut, 'htdemucs', stemBase, 'vocals.wav')
    if (!existsSync(vocals)) return { ok: false, error: 'demucs 跑完但没找到 vocals.wav' }

    // 4. 截窗口 + loudnorm / 32k / mono → assets-src/voices/<name>.wav
    const voicesDir = join(assetsRoot(), 'voices')
    mkdirSync(voicesDir, { recursive: true })
    const outWav = join(voicesDir, `${name}.wav`)
    const start = Math.max(0, win.start - from)
    const dur = Math.min(9.5, win.end - win.start)
    const ff = spawnSync('ffmpeg', [
      '-y', '-ss', String(start), '-t', String(dur), '-i', vocals,
      '-af', 'loudnorm', '-ar', '32000', '-ac', '1', outWav,
    ], { encoding: 'utf8', timeout: 2 * 60_000, windowsHide: true })
    if (ff.status !== 0 || !existsSync(outWav)) {
      const tail = String(ff.stderr || ff.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n')
      return { ok: false, error: `ffmpeg 截取失败：\n${tail.slice(0, 500)}` }
    }

    // 5. 参考文本
    const promptText = win.rows.map((x) => x.content).join('')
    writeFileSync(join(voicesDir, `${name}.txt`), promptText, 'utf8')

    return { ok: true, file: `${name}.wav`, promptText, seconds: Math.round(dur), ms: Date.now() - t0 }
  } finally {
    rmSync(tmpBase, { recursive: true, force: true })
  }
}

/* ───────────── CLI（后台子进程入口） ─────────────
 * index.js 用 spawn(node, voice-harvest.mjs --bv …) 异步起任务，避免 spawnSync
 * 长流水线（yt-dlp + demucs，几分钟）阻塞宿主事件循环。
 * 结束时向 stdout 打一行 __HARVEST_RESULT__{json}，退出码 0=成功 1=失败。
 */
if (process.argv[1] && process.argv[1].replace(/[\\]/g, '/').endsWith('voice-harvest.mjs')) {
  const arg = (n, d = '') => {
    const i = process.argv.indexOf('--' + n)
    return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
  }
  const bv = arg('bv')
  const from = Number(arg('from'))
  const to = Number(arg('to'))
  const name = arg('name')
  let result
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv) || !Number.isFinite(from) || !Number.isFinite(to) || !name) {
    result = { ok: false, error: '参数不对：需要 --bv --from --to --name' }
  } else {
    try {
      result = harvestVoice({ bv, from, to, name })
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e) }
    }
  }
  console.log('__HARVEST_RESULT__' + JSON.stringify(result))
  process.exitCode = result.ok ? 0 : 1
}
