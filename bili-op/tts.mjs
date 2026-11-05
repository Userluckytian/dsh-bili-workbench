/**
 * tts.mjs —— 逐镜配音 + 时间轴 + 合并字幕
 *
 * 输入：runs/<run>/script.json
 * 输出（同一个 run 目录下）：
 *   audio/shot-1.mp3|wav …    每镜配音
 *   audio/shot-1.srt …        每镜的时间戳（edge-tts 自带；克隆音色按句近似）
 *   voice.mp3                 带间隔拼接好的整条旁白
 *   subtitles.srt             整片时间轴的字幕（已按镜头起点平移）
 *   props.json                给 Remotion 用：每镜 frames / from / audio 秒数
 *
 * 两种音色：
 *   · edge-tts（zh-CN-*）：默认，快，带字级 SRT；
 *   · GPT-SoVITS 克隆音色（assets-src/voices/<name>.wav + .txt）：零样本克隆，
 *     需要本机 refs/GPT-SoVITS；没启动就自动拉起，用完（本次启动的）自动关掉。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const VOICES_DIR = join(ROOT, 'assets-src', 'voices')
const FPS = 30
const GAP = 0.35          // 每镜之间留给换气/转场
const CLONE_URL = process.env.GPT_SOVITS_URL || 'http://127.0.0.1:9880'
const EDGE_VOICES = new Set([
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural',
  'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural',
  'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural',
])

const cloneState = { child: null, started: false }

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}

/** edge-tts 在哪：EDGE_TTS_BIN > ~/.local/bin/edge-tts.exe > PATH */
function edgeTtsBin() {
  const env = process.env.EDGE_TTS_BIN
  if (env && existsSync(env)) return env
  const p = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'edge-tts.exe' : 'edge-tts')
  return existsSync(p) ? p : 'edge-tts'
}
const BIN = edgeTtsBin()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const probeSeconds = (file) => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
  return Number(String(out).trim()) || 0
}

/** 读 srt → [{start,end,text}]，时间换算成秒 */
function parseSrt(text) {
  const cues = []
  for (const block of String(text).replace(/\r/g, '').split('\n\n')) {
    const lines = block.split('\n').filter(Boolean)
    if (lines.length < 2) continue
    const m = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(block)
    if (!m) continue
    const toSec = (h, mm, s, ms) => Number(h) * 3600 + Number(mm) * 60 + Number(s) + Number(ms) / 1000
    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    const body = lines.slice(lines.findIndex((l) => l.includes('-->')) + 1).join(' ').trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

/** 克隆音色没有字级时间戳：按标点切句，按字数比例分配这一镜的时长 */
function approxCues(text, sec) {
  const parts = String(text).split(/(?<=[。！？；，,.!?;])/).map((s) => s.trim()).filter(Boolean)
  const list = parts.length ? parts : [String(text)]
  const total = list.reduce((a, s) => a + s.length, 0) || 1
  let t = 0
  return list.map((s) => {
    const d = sec * s.length / total
    const c = { start: t, end: t + d, text: s }
    t += d
    return c
  })
}

const fmtTime = (sec) => {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(mm)}:${p(ss)},${p(ms, 3)}`
}

function silenceFile(outDir, ext) {
  const f = join(outDir, `_silence.${ext}`)
  if (!existsSync(f)) {
    const rate = ext === 'wav' ? 32000 : 24000
    const args = ['-y', '-f', 'lavfi', '-i', `anullsrc=r=${rate}:cl=mono`, '-t', String(GAP)]
    if (ext === 'wav') args.push('-c:a', 'pcm_s16le')
    else args.push('-q:a', '9')
    args.push(f)
    execFileSync('ffmpeg', args, { stdio: 'ignore' })
  }
  return f
}

/** 本机 127.0.0.1 请求不要走系统代理 */
function localNoProxy() {
  const add = ['127.0.0.1', 'localhost', '::1']
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const cur = String(process.env[key] || '')
    const parts = cur.split(',').map((s) => s.trim()).filter(Boolean)
    for (const a of add) if (!parts.includes(a)) parts.push(a)
    process.env[key] = parts.join(',')
  }
}

async function cloneReady() {
  localNoProxy()
  try {
    const r = await fetch(CLONE_URL + '/docs', { signal: AbortSignal.timeout(1500) })
    return Boolean(r.status)
  } catch { return false }
}

function startCloneService() {
  const py = process.platform === 'win32'
    ? join(ROOT, 'refs', 'GPT-SoVITS', '.venv', 'Scripts', 'python.exe')
    : join(ROOT, 'refs', 'GPT-SoVITS', '.venv', 'bin', 'python')
  if (!existsSync(py)) throw new Error('GPT-SoVITS 环境未安装（缺少 refs/GPT-SoVITS/.venv）')
  const cwd = join(ROOT, 'refs', 'GPT-SoVITS')
  cloneState.child = spawn(py, ['api_v2.py', '-c', 'GPT_SoVITS/configs/tts_infer_v1_smoke.yaml'], {
    cwd, windowsHide: true, stdio: 'ignore',
  })
  cloneState.started = true
  return cloneState.child
}

function stopCloneService() {
  if (!cloneState.started || !cloneState.child) return
  const pid = cloneState.child.pid
  cloneState.started = false
  const child = cloneState.child
  cloneState.child = null
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
  } catch {
    try { child.kill() } catch { /* ignore */ }
  }
}

async function ensureCloneService() {
  if (await cloneReady()) return false
  startCloneService()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await sleep(1000)
    if (await cloneReady()) return true
  }
  throw new Error('GPT-SoVITS 服务启动超时（90 秒）；看 refs/GPT-SoVITS/_api.log')
}

async function cloneTts(text, outWav, voice) {
  const ref = join(VOICES_DIR, voice + '.wav')
  const txt = join(VOICES_DIR, voice + '.txt')
  if (!existsSync(ref)) throw new Error(`找不到参考音：${ref}`)
  if (!existsSync(txt)) throw new Error(`找不到参考文本：${txt}`)
  const prompt = readFileSync(txt, 'utf8').trim()
  if (!prompt) throw new Error(`参考文本为空：${txt}`)
  const body = {
    text,
    text_lang: 'zh',
    ref_audio_path: ref.replace(/\\/g, '/'),
    prompt_text: prompt,
    prompt_lang: 'zh',
  }
  const r = await fetch(CLONE_URL + '/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!r.ok) throw new Error(`GPT-SoVITS ${r.status}：${(await r.text()).slice(0, 200)}`)
  writeFileSync(outWav, Buffer.from(await r.arrayBuffer()))
}

async function main() {
  const runArg = arg('run', '')
  const runDir = runArg ? resolve(runArg) : (process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : '')
  if (!runDir || !existsSync(join(runDir, 'script.json'))) {
    console.error('用法: node tts.mjs <run目录>   （目录里要有 script.json）')
    process.exit(2)
  }
  const voice = arg('voice', 'zh-CN-YunxiNeural')
  const clone = !EDGE_VOICES.has(voice)
  const script = JSON.parse(readFileSync(join(runDir, 'script.json'), 'utf8'))
  if (!Array.isArray(script.shots) || !script.shots.length) throw new Error('script.json 里没有 shots')

  if (clone) {
    await ensureCloneService()
    console.log(`配音：${voice} · ${script.shots.length} 镜 · GPT-SoVITS=${CLONE_URL}`)
  } else {
    console.log(`配音：${voice} · ${script.shots.length} 镜 · edge-tts=${BIN}`)
  }

  const audioDir = join(runDir, 'audio')
  mkdirSync(audioDir, { recursive: true })

  const cues = []
  let cursor = 0
  let totalFrames = 0
  const props = { title: script.title, subtitle: script.subtitle, shots: [], fps: FPS }
  const shotExt = clone ? 'wav' : 'mp3'

  for (const [i, shot] of script.shots.entries()) {
    const n = i + 1
    const media = join(audioDir, `shot-${n}.${shotExt}`)
    const t0 = Date.now()
    let sec = 0

    if (clone) {
      await cloneTts(shot.narration, media, voice)
      sec = probeSeconds(media)
      for (const c of approxCues(shot.narration, sec)) {
        cues.push({ start: cursor + c.start, end: cursor + c.end, text: c.text })
      }
    } else {
      const srt = join(audioDir, `shot-${n}.srt`)
      execFileSync(BIN, [
        '--text', shot.narration,
        '--voice', voice,
        '--write-media', media,
        '--write-subtitles', srt,
      ], { stdio: 'ignore', windowsHide: true })
      sec = probeSeconds(media)
      for (const c of parseSrt(readFileSync(srt, 'utf8'))) {
        cues.push({ start: cursor + c.start, end: cursor + c.end, text: c.text })
      }
    }

    if (sec <= 0) throw new Error(`第 ${n} 镜配音时长读不出来：${media}`)

    const frames = Math.max(1, Math.round((sec + GAP) * FPS))
    props.shots.push({
      ...shot,
      indexLabel: shot.kind === 'item' ? String(shot.index || '') : '',
      audio: `audio/shot-${n}.${shotExt}`,
      audioSeconds: Number(sec.toFixed(3)),
      from: totalFrames,
      frames,
    })
    totalFrames += frames
    cursor += sec + GAP
    console.log(`  ${String(n).padStart(2)} [${shot.kind.padEnd(5)}] ${sec.toFixed(2)}s → ${frames} 帧  (${Date.now() - t0} ms)`)
  }

  props.mascotVideo = script.mascot === false ? undefined : (script.mascotVideo === false ? undefined : (script.mascotVideo || 'mascot/dafieiyu-anim.mp4'))
  props.mascot = script.mascot === false ? undefined : (script.mascot || 'mascot/default.png')
  props.totalFrames = totalFrames
  props.totalSeconds = Number(cursor.toFixed(2))

  // 整条旁白：镜与镜之间插 0.35 秒静音
  const sil = silenceFile(audioDir, shotExt)
  const listFile = join(audioDir, '_concat.txt')
  const parts = []
  for (const [i] of script.shots.entries()) {
    parts.push(join(audioDir, `shot-${i + 1}.${shotExt}`).replace(/\\/g, '/'))
    if (i < script.shots.length - 1) parts.push(sil.replace(/\\/g, '/'))
  }
  writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'), 'utf8')
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', join(runDir, 'voice.mp3')], { stdio: 'ignore' })

  // 合并字幕（重新编号）
  const srtOut = cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join('\n')
  writeFileSync(join(runDir, 'subtitles.srt'), srtOut, 'utf8')

  writeFileSync(join(runDir, 'props.json'), JSON.stringify(props, undefined, 2), 'utf8')
  try { rmSync(sil, { force: true }) } catch { /* 清不掉就算了 */ }

  console.log(`\n整片：${props.totalSeconds} 秒 · ${totalFrames} 帧 · 字幕 ${cues.length} 条`)
  console.log(`已写入 ${join(runDir, 'props.json')}`)
}

process.on('exit', stopCloneService)
main()
  .catch((e) => { stopCloneService(); console.error('失败：' + (e?.message ?? e)); process.exit(1) })
  .then(() => { stopCloneService() })
