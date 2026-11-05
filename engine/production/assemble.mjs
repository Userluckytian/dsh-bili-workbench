/**
 * assemble.mjs —— AI 制作线的最后一步：把选中的镜头视频拼成一条成片
 *
 *   node assemble.mjs --project <projectId> --run <runId>
 *
 * 输入（宿主已写好）：
 *   renders/<runId>/assembly.json   选中镜头（顺序、旁白、视频文件）
 *   renders/<runId>/script.json     给 bili-op/tts.mjs 用的逐镜脚本
 *
 * 输出：
 *   renders/<runId>/audio/…         逐镜配音
 *   renders/<runId>/voice.mp3       整条旁白
 *   renders/<runId>/final.mp4       成片（会出现在「审核 / 发布」）
 *   renders/<runId>/cover.png       封面
 *   renders/<runId>/status.json     stage=rendered / failed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assetsRoot, STORE } from '../store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..', '..')
const ROOT = resolve(PLUGIN, '..')
const BILI_OP = process.env.BILI_OP_DIR
  || (existsSync(join(PLUGIN, 'bili-op', 'build.mjs')) ? join(PLUGIN, 'bili-op') : join(ROOT, 'bili-op'))
const TTS = join(BILI_OP, 'tts.mjs')
const FPS = 30

const arg = (name, dflt = '') => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

function readJson(f, dflt = null) {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}
function writeJson(f, obj) {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8')
}
function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts })
  if (r.error) throw new Error(`${bin} 起不来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}：${String(r.stderr || r.stdout || '').slice(-1200)}`)
  return r
}
function probeSeconds(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  const n = Number(String(r.stdout || '').trim())
  if (!Number.isFinite(n) || n <= 0) throw new Error('读不出视频时长：' + file)
  return n
}
const num = (n) => Math.round(Number(n) * 1000) / 1000
const fmtTime = (sec) => {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const ms = Math.round((s - Math.floor(s)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(mm)}:${p(ss)},${p(ms, 3)}`
}

function setStatus(runDir, patch) {
  const f = join(runDir, 'status.json')
  const cur = readJson(f, {}) || {}
  writeJson(f, { ...cur, ...patch })
}

function main() {
  const projectId = arg('project')
  const runId = arg('run')
  if (!projectId || !runId) throw new Error('用法：node assemble.mjs --project <id> --run <runId>')
  const runsDir = process.env.BILI_OP_RUNS || join(STORE, 'renders')
  const runDir = join(runsDir, runId)
  if (!existsSync(join(runDir, 'assembly.json'))) throw new Error('找不到组合任务：' + runDir)
  const workDir = runDir
  const spec = readJson(join(workDir, 'assembly.json'))
  if (!spec?.rows?.length) throw new Error('assembly.json 里没有镜头')

  const voiceOn = Boolean(spec.voice?.enabled && spec.voice?.voice)
  const voiced = voiceOn
    ? spec.rows.map((row, i) => ({ row, i })).filter(({ row }) => String(row.narration || '').trim())
    : []
  console.log(`组合：${spec.title || runId} · ${spec.rows.length} 镜 · 对白 ${voiced.length} 句 · 配音=${voiceOn ? spec.voice.voice : '关'}`)

  // ① 只给有对白的镜头生成配音；无对白镜头后面补静音轨
  const audioByIndex = new Map()
  if (voiceOn && voiced.length) {
    if (!existsSync(TTS)) throw new Error('找不到 bili-op/tts.mjs')
    const voiceDir = join(workDir, '_voice')
    mkdirSync(voiceDir, { recursive: true })
    writeJson(join(voiceDir, 'script.json'), {
      title: spec.title,
      subtitle: spec.subtitle || '',
      theme: spec.theme || '',
      shots: voiced.map(({ row }) => ({
        kind: row.kind || 'item',
        narration: row.narration,
        duration: row.duration,
        index: row.n,
      })),
    })
    console.log('① 生成对白配音…')
    run(process.execPath, [TTS, voiceDir, '--voice', spec.voice.voice], { stdio: 'inherit' })
    const vprops = readJson(join(voiceDir, 'props.json'))
    if (!vprops?.shots?.length) throw new Error('配音完成但读不到 props.json')
    voiced.forEach(({ row, i }, j) => {
      const p = vprops.shots[j]
      if (!p?.audio) throw new Error(`第 ${row.n} 镜没有拿到配音文件`)
      audioByIndex.set(i, {
        file: join(voiceDir, p.audio),
        seconds: Number(p.audioSeconds) || 0,
        narration: row.narration,
      })
    })
  } else {
    console.log('① 跳过配音（无对白 / 配音不参与）')
  }

  // ② 每镜统一规格：1920×1080 / 30fps；有对白按对白时长，无对白按镜头时长
  const segDir = join(workDir, 'segments')
  mkdirSync(segDir, { recursive: true })
  const segs = []
  const timeline = []
  let cursor = 0
  for (const [i, row] of spec.rows.entries()) {
    const clip = resolve(assetsRoot(), String(row.file || ''))
    if (!existsSync(clip)) throw new Error(`第 ${row.n} 镜视频不存在：${row.file}`)
    const out = join(segDir, `seg-${String(i + 1).padStart(2, '0')}.mp4`)
    const av = audioByIndex.get(i)
    const clipSec = Math.min(12, Math.max(1, probeSeconds(clip)))
    let dur = 0
    if (av) dur = Math.max(1, av.seconds + 0.25)
    else dur = Math.min(clipSec, Math.max(1, Number(row.duration) || clipSec))
    const d = num(dur)
    const vf = `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=12,trim=duration=${d},setpts=PTS-STARTPTS[v]`
    const audioInput = av
      ? ['-i', av.file]
      : ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=44100:cl=stereo']
    const af = av
      ? `[1:a]aresample=44100,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a]`
      : `[1:a]atrim=duration=${d},asetpts=PTS-STARTPTS[a]`
    console.log(`  ${String(row.n).padStart(2)} ${d}s ← ${row.file}${av ? '（对白）' : '（静音）'}`)
    run('ffmpeg', [
      '-y', '-i', clip, ...audioInput,
      '-filter_complex', `${vf};${af}`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', out,
    ])
    timeline.push({ n: row.n, narration: String(row.narration || ''), start: cursor, dur: d })
    cursor += d
    segs.push(out)
  }

  // 重新生成整片 SRT（对白镜头才有字幕，时间轴按最终时长）
  let srtIndex = 0
  const srt = timeline
    .filter((x) => x.narration.trim())
    .map((x) => `${++srtIndex}\n${fmtTime(x.start)} --> ${fmtTime(x.start + x.dur)}\n${x.narration}\n`)
    .join('\n')
  if (srt) writeFileSync(join(workDir, 'subtitles.srt'), srt, 'utf8')

  // ③ 拼接
  if (!segs.length) throw new Error('没有可拼接的镜头')
  const list = join(segDir, 'list.txt')
  writeFileSync(list, segs.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8')
  const finalMp4 = join(workDir, 'final.mp4')
  console.log('② 拼接…')
  run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', finalMp4])

  // ④ 封面：第一镜首帧
  const cover = join(workDir, 'cover.png')
  try {
    const first = resolve(assetsRoot(), String(spec.rows[0].file || ''))
    run('ffmpeg', ['-y', '-ss', '0', '-i', first, '-frames:v', '1', '-vf', 'scale=1920:-2', cover])
  } catch { /* 封面失败不影响成片 */ }

  const total = segs.reduce((n, f) => n + probeSeconds(f), 0)
  setStatus(workDir, {
    stage: 'rendered',
    title: spec.title,
    subtitle: spec.subtitle || '',
    theme: spec.theme || '',
    shots: spec.rows.length,
    seconds: num(total),
    needReview: true,
    review: null,
    builtAt: new Date().toISOString(),
    createdAt: readJson(join(workDir, 'status.json'), {})?.createdAt || new Date().toISOString(),
    projectId,
    projectVersion: spec.version,
    files: {
      video: 'final.mp4',
      cover: existsSync(cover) ? 'cover.png' : '',
      subtitles: existsSync(join(workDir, 'subtitles.srt')) ? 'subtitles.srt' : '',
    },
    error: '',
  })
  try { rmSync(list, { force: true }) } catch { /* 可选清理 */ }
  console.log(`✅ 组合完成：${finalMp4} · ${num(total)} 秒`)
}

try {
  main()
} catch (e) {
  const runId = arg('run')
  const candidates = [
    process.env.BILI_OP_RUNS ? join(process.env.BILI_OP_RUNS, runId) : '',
    join(STORE, 'renders', runId),
  ].filter(Boolean)
  const dir = candidates.find((d) => existsSync(join(d, 'status.json'))) || candidates[1]
  try { setStatus(dir, { stage: 'failed', error: String(e?.message ?? e).slice(0, 2000), builtAt: new Date().toISOString() }) } catch { /* ignore */ }
  console.error('组合失败：' + (e?.message ?? e))
  process.exit(1)
}
