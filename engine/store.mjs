/**
 * store.mjs —— 素材库（单一真相源）
 *
 * 设计要点：
 *  · **按 BV 幂等**：一条视频只存一份，谁先抓到谁写，其他人只读 ⇒ 不重复看
 *  · 存的是"能用来创作的料"：逐字稿带时间戳、关键帧、封面、引用片段、判定
 *  · 纯文件（JSON + 图片），不用数据库：好查、好备份、好手改
 *
 * 目录：
 *   <STORE>/videos/<BV>.json     一条视频的全部事实
 *   <STORE>/subs/<BV>.json       逐字稿（带时间戳，单独放方便 grep）
 *   <STORE>/frames/<BV>/f*.jpg   关键帧
 *   <STORE>/covers/<BV>.jpg      封面
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

// 素材库位置：默认 ~/.dsh-bili-workbench/store；可以在「我的」页面改。
// 优先级：location.json（用户选过）> BILI_STORE > 新默认目录。
const HOME_DIR = join(homedir(), '.dsh-bili-workbench')
const LOCATION_FILE = join(HOME_DIR, 'location.json')
const DEFAULT_STORE = join(HOME_DIR, 'store')
const expandHome = (p) => String(p || '').replace(/^~(?=$|[\\/])/, homedir())

function readLocation() {
  try {
    const j = JSON.parse(readFileSync(LOCATION_FILE, 'utf8'))
    return expandHome(j?.storePath || '')
  } catch { return '' }
}

export function resolveStoreRoot() {
  const saved = readLocation()
  if (saved && isAbsolute(saved)) return saved
  const env = expandHome(process.env.BILI_STORE || '')
  if (env) return resolve(env)
  return DEFAULT_STORE
}

export const defaultStorePath = () => DEFAULT_STORE
export const locationFile = () => LOCATION_FILE

export let STORE = resolveStoreRoot()

/**
 * 素材根目录（assets-src）的唯一权威解析：读写两侧都必须走这里。
 * 优先级：BILI_ASSETS 环境变量 > STORE 同级 assets-src。
 * 此前 voice-harvest/clip 用模块相对路径、plan/render 只认 STORE 同级，
 * 设了 BILI_ASSETS 或切库后写侧与读侧会指向不同目录（采了音色却显示失败）。
 */
export function assetsRoot() {
  return resolve(process.env.BILI_ASSETS || join(STORE, '..', 'assets-src'))
}

const dirsFor = (root) => ({
  videos: join(root, 'videos'),
  subs: join(root, 'subs'),
  frames: join(root, 'frames'),
  covers: join(root, 'covers'),
})
let DIRS = dirsFor(STORE)

/** 切换素材库位置；写 location.json，之后重启也以它为优先 */
export function setStoreRoot(p) {
  const abs = resolve(expandHome(p))
  if (!isAbsolute(abs)) throw new Error('素材库位置必须是绝对路径')
  mkdirSync(abs, { recursive: true })
  DIRS = dirsFor(abs)
  STORE = abs
  _statsCache = null
  mkdirSync(HOME_DIR, { recursive: true })
  writeFileSync(LOCATION_FILE, JSON.stringify({ storePath: abs }, null, 2), 'utf8')
  ensureStore()
  return STORE
}

export function ensureStore() {
  mkdirSync(STORE, { recursive: true })
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true })
  return STORE
}

export const paths = (bv) => ({
  record: join(DIRS.videos, `${bv}.json`),
  subs: join(DIRS.subs, `${bv}.json`),
  framesDir: join(DIRS.frames, bv),
  cover: join(DIRS.covers, `${bv}.jpg`),
})

/** 读一条；没有就 null */
export function get(bv) {
  const f = paths(bv).record
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

/** 写一条（含目录创建） */
export function put(rec) {
  ensureStore()
  const p = paths(rec.bvid)
  writeFileSync(p.record, JSON.stringify(rec, null, 2), 'utf8')
  return p.record
}

export const has = (bv) => existsSync(paths(bv).record)

/** 新鲜度：默认 7 天内算新鲜（数据类的东西没必要天天重抓） */
export function isFresh(bv, maxAgeDays = 7) {
  const rec = get(bv)
  if (!rec || !rec.fetchedAt) return false
  const age = (Date.now() - Date.parse(rec.fetchedAt)) / 86400000
  return Number.isFinite(age) && age <= maxAgeDays
}

/** 存逐字稿（带时间戳） */
export function putSubtitle(bv, sub) {
  ensureStore()
  writeFileSync(paths(bv).subs, JSON.stringify(sub, null, 2), 'utf8')
}

/** 把 bili 抽好的帧拷进库（bili 自己存在 %APPDATA%，我们复制一份，库才自洽） */
export function storeFrames(bv, frames) {
  ensureStore()
  const dir = paths(bv).framesDir
  mkdirSync(dir, { recursive: true })
  const out = []
  for (const [i, f] of frames.entries()) {
    if (!f || !f.path || !existsSync(f.path)) continue
    const name = `f${String(i + 1).padStart(2, '0')}-${String(Math.floor(Number(f.time) || 0)).padStart(4, '0')}s.jpg`
    const dest = join(dir, name)
    try {
      copyFileSync(f.path, dest)
      out.push({ t: Number(f.time) || 0, file: `frames/${bv}/${name}`, timeStr: f.time_str || '' })
    } catch { /* 拷不过去就跳过这一帧 */ }
  }
  return out
}

export function storeCover(bv, buf) {
  ensureStore()
  const p = paths(bv).cover
  writeFileSync(p, buf)
  return `covers/${bv}.jpg`
}

/** 列表（按抓取时间倒序） */
export function list({ limit = 100 } = {}) {
  if (!existsSync(DIRS.videos)) return []
  const out = []
  for (const f of readdirSync(DIRS.videos)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(DIRS.videos, f), 'utf8'))
      out.push(rec)
    } catch { /* 坏文件跳过 */ }
  }
  out.sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')))
  return out.slice(0, limit)
}

/** 库的规模：条数 + 磁盘占用（MB）；30 秒内存缓存（切库即失效），列表页不用每次全量扫盘 */
let _statsCache = null

/**
 * 今日已采条数：30 秒 + 按日双键缓存。
 * /config 被多个页面高频轮询，此前每次都触发 list() 全量读盘（2000 个 JSON 同步 parse），
 * 是宿主越用越卡的主因之一。采集以分钟计，30 秒陈旧对上限判定无实际影响。
 */
let _todayCache = null
export function todayCount() {
  const day = new Date().toLocaleDateString('sv-SE')
  if (_todayCache && _todayCache.path === STORE && _todayCache.day === day
    && Date.now() - _todayCache.at < 30_000) return _todayCache.value
  const n = list({ limit: 2000 }).filter((r) => {
    // 与 index.js localDay 同口径：按本地时区取日（ISO 的 UTC 日期会和本地日差一天）
    try { return new Date(r.fetchedAt).toLocaleDateString('sv-SE') === day } catch { return String(r.fetchedAt || '').slice(0, 10) === day }
  }).length
  _todayCache = { at: Date.now(), path: STORE, day, value: n }
  return n
}

export function stats() {
  if (_statsCache && _statsCache.path === STORE && Date.now() - _statsCache.at < 30_000) return _statsCache.value
  let bytes = 0
  let files = 0
  const walk = (d) => {
    if (!existsSync(d)) return
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else { bytes += st.size; files++ }
    }
  }
  walk(STORE)
  const n = existsSync(DIRS.videos) ? readdirSync(DIRS.videos).filter((f) => f.endsWith('.json')).length : 0
  const value = { videos: n, files, mb: Number((bytes / 1024 / 1024).toFixed(1)), path: STORE }
  _statsCache = { at: Date.now(), path: STORE, value }
  return value
}
