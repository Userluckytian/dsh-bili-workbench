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
import { join } from 'node:path'
import { homedir } from 'node:os'

// 保持原机器的数据目录不变；换机器时默认落到 ~/.dsh-bili-workbench/store
const LEGACY_STORE = 'D:\\AI_projects\\bibilili\\bili-store'
export const STORE = process.env.BILI_STORE
  || (existsSync(LEGACY_STORE) ? LEGACY_STORE : join(homedir(), '.dsh-bili-workbench', 'store'))

const DIRS = {
  videos: join(STORE, 'videos'),
  subs: join(STORE, 'subs'),
  frames: join(STORE, 'frames'),
  covers: join(STORE, 'covers'),
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

/** 库的规模：条数 + 磁盘占用（MB） */
export function stats() {
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
  return { videos: n, files, mb: Number((bytes / 1024 / 1024).toFixed(1)), path: STORE }
}
