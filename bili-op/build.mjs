/**
 * build.mjs —— 一条命令把一期片子从头做到尾（**不发布**）
 *
 *   node build.mjs --theme "本周AI圈新鲜事" [--count 5] [--tone 语气] [--burn] [--skip-gen]
 *   node build.mjs --run runs/2026-10-23-xxx            # 拿现成的 script.json 接着做
 *
 * 步骤：生成脚本 → 配音+时间轴 → Remotion 渲染 → 合音轨 → 烧字幕(可选) → 封面 → status.json
 * 产物全在 run 目录里；最后**停在这里等人审**（对应方案里的 G2 闸门）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { makeCover } from './cover.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 渲染用的浏览器：优先 BILI_OP_CHROME，其次按「Chrome → Edge」顺序探测本机实际有的那个。
 * （Remotion 只要有 Chromium 内核就行；A 机是 Chrome，这台是 Edge，两边都不用改代码。）
 */
function detectBrowser() {
  const explicit = process.env.BILI_OP_CHROME
  if (explicit) return explicit
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return candidates[0]
}
const CHROME = detectBrowser()

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt
}
const flag = (name) => process.argv.includes('--' + name)
const now = () => Date.now()
const log = (m) => console.log(m)
const mb = (f) => (existsSync(f) ? (statSync(f).size / 1024 / 1024).toFixed(1) + ' MB' : '-')

function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', windowsHide: true, ...opts })
  if (r.error) throw new Error(`${bin} 起不来：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${bin} 退出码 ${r.status}`)
}

/**
 * 跑 Remotion：**不要用 npx**。
 * Node 22 在 Windows 上拒绝 spawn `.cmd`（安全策略），`spawnSync('npx')` 会直接失败（status=null）。
 * 所以直接用 node 跑 @remotion/cli 的入口 JS。
 */
function renderRemotion({ renderDir, propsPath, out }) {
  // 本地开发时依赖在 render/node_modules；插件方式安装时依赖在包根 node_modules。
  // 用 createRequire 按 Node 的解析规则找，不要写死目录。
  let bin = ''
  try {
    const req = createRequire(join(renderDir, 'package.json'))
    const cliPkgPath = req.resolve('@remotion/cli/package.json')
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
    bin = join(dirname(cliPkgPath), cliPkg.bin?.remotion || 'remotion-cli.js')
  } catch {
    bin = resolve(renderDir, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
  }
  if (!existsSync(bin)) throw new Error('找不到 Remotion CLI：' + bin + '（先 npm install）')
  sh(process.execPath, [
    bin, 'render', 'src/index.tsx', 'News', out,
    `--props=${propsPath}`,
    `--browser-executable=${CHROME}`,
    '--concurrency=4',
  ], { cwd: renderDir })
}

async function main() {
  const started = now()
  let runDir = arg('run', '')
  const theme = arg('theme', '')

  // ① 生成脚本
  if (runDir) {
    runDir = resolve(runDir)
    if (!existsSync(join(runDir, 'script.json'))) throw new Error('这个 run 目录里没有 script.json')
    log(`① 用现成脚本：${runDir}`)
  } else {
    if (!theme) throw new Error('要么给 --theme "主题"，要么给 --run <目录>')
    log(`① 生成脚本：${theme}`)
    const args = [join(HERE, 'gen.mjs'), theme, '--count', String(arg('count', 5))]
    if (arg('tone', '')) args.push('--tone', arg('tone', ''))
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' })
    process.stdout.write(out)
    const m = /已写入 (.+script\.json)/.exec(out)
    if (!m) throw new Error('没找到生成结果目录')
    runDir = dirname(m[1].trim())
  }

  const script = JSON.parse(readFileSync(join(runDir, 'script.json'), 'utf8'))

  // ② 配音 + 时间轴
  log('\n② 配音 + 时间轴')
  const ttsArgs = [join(HERE, 'tts.mjs'), runDir]
  if (arg('voice', '')) ttsArgs.push('--voice', arg('voice', ''))
  sh(process.execPath, ttsArgs)

  // ③ Remotion 渲染（只出视频，音轨后面合）
  log('\n③ 渲染画面')
  const t3 = now()
  const propsPath = join(runDir, 'props.json')
  const videoRaw = join(runDir, 'video-silent.mp4')
  const reuse = flag('skip-render') && existsSync(join(runDir, 'video.mp4'))
  if (reuse) {
    log(`   复用已有画面：${join(runDir, 'video.mp4')}`)
    sh('ffmpeg', ['-y', '-i', join(runDir, 'video.mp4'), '-c', 'copy', videoRaw], { stdio: 'ignore' })
  } else {
    renderRemotion({ renderDir: join(HERE, 'render'), propsPath, out: videoRaw })
    log(`   渲染耗时 ${((now() - t3) / 60000).toFixed(1)} 分钟 · ${mb(videoRaw)}`)
  }

  // ④ 合音轨
  log('\n④ 合入旁白')
  const videoOut = join(runDir, 'final.mp4')
  sh('ffmpeg', ['-y', '-i', videoRaw, '-i', join(runDir, 'voice.mp3'),
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', videoOut], { stdio: 'ignore' })
  log(`   ${mb(videoOut)}`)

  // ⑤ 烧字幕（可选）—— B站 上传用烧死的最保险
  let burned = ''
  if (flag('burn')) {
    log('\n⑤ 烧字幕')
    burned = join(runDir, 'final-subbed.mp4')
    const srt = join(runDir, 'subtitles.srt').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
    sh('ffmpeg', ['-y', '-i', videoOut,
      // ⚠️ libass 默认按 384×288 的 PlayRes 缩放 ⇒ FontSize/MarginV 都是"相对单位"，
      //    给 22/46 会渲成 80px 的大字。13/26 换算到 1080p 约 49px / 98px，正好。
      '-vf', `subtitles='${srt}':force_style='FontName=Microsoft YaHei,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&HCC000000,BorderStyle=1,Outline=2,Shadow=0.6,MarginV=26'`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'copy', burned], { stdio: 'ignore' })
    log(`   ${mb(burned)}`)
  }

  // ⑥ 封面
  log('\n⑥ 封面')
  const cover = join(runDir, 'cover.png')
  await makeCover({ title: script.title, subtitle: script.subtitle || '', out: cover })
  log(`   ${cover}`)

  // ⑦ 状态文件（人工闸门就守在这里）
  //    工作台在开跑前先写了一份 status（带 projectId / 真实帧数），这里要保留这些字段
  let prevStatus = {}
  try { prevStatus = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) } catch { prevStatus = {} }
  const status = {
    ...prevStatus,
    stage: 'rendered',                 // drafted → rendered → approved → published
    theme: script.theme || prevStatus.theme || '',
    title: script.title,
    subtitle: script.subtitle || '',
    model: script.model || '',
    shots: script.stats?.shotCount || 0,
    narrationChars: script.stats?.narrationChars || 0,
    seconds: JSON.parse(readFileSync(propsPath, 'utf8')).totalSeconds,
    frames: JSON.parse(readFileSync(propsPath, 'utf8')).totalFrames,
    realFrames: Number(prevStatus.realFrames) || 0,
    projectId: prevStatus.projectId || script.projectId || '',
    projectVersion: prevStatus.projectVersion || script.projectVersion || 0,
    files: {
      video: videoOut,
      videoBurned: burned || '',
      cover,
      subtitles: join(runDir, 'subtitles.srt'),
      voice: join(runDir, 'voice.mp3'),
      script: join(runDir, 'script.json'),
      props: propsPath,
    },
    needReview: true,
    builtAt: new Date().toISOString(),
    costYuan: 0,
  }
  writeFileSync(join(runDir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')

  log(`\n✅ 出片完成（${((now() - started) / 60000).toFixed(1)} 分钟，0 元）`)
  log(`   成片：${videoOut}`)
  if (burned) log(`   带字幕：${burned}`)
  log(`   封面：${cover}`)
  log(`   状态：${join(runDir, 'status.json')}（stage=rendered，等你审）`)
}

mkdirSync(join(HERE, 'runs'), { recursive: true })
main().catch((e) => { console.error('\n失败：' + (e?.message ?? e)); process.exit(1) })
