/**
 * stress.mjs —— 素材库压测（合成数据，绝不碰真实库）
 *
 * 用法：
 *   node scripts/stress.mjs --n=5000              # 造 5000 条到临时库并压测
 *   node scripts/stress.mjs --n=200 --keep        # 保留合成库目录方便排查
 *   node scripts/stress.mjs --clean               # 清掉上次的合成库
 *
 * 原理：BILI_STORE 指向 <tmp>/stress-store，启动宿主前设置即可隔离。
 * 本脚本只负责「造数据 + 打请求 + 统计延迟」，宿主需先按同库启动。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? true] : [a, true]
}))
const N = Number(args.n || 1000)
const ROOT = join(tmpdir(), 'dsh-stress-store')
const VIDEOS = join(ROOT, 'videos')

if (args.clean) {
  rmSync(ROOT, { recursive: true, force: true })
  console.log(`已清理 ${ROOT}`)
  process.exit(0)
}

const TIERS = ['必看', '可以看', '跳过', '未判定']
const rand = (n) => Math.floor(Math.random() * n)
const pad = (n, w = 6) => String(n).padStart(w, '0')

mkdirSync(VIDEOS, { recursive: true })
console.log(`造数据：${N} 条 → ${ROOT}`)
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const bv = `BVstress${pad(i)}`
  // 刻意做得接近真实体积：带 frames / 热评 / 弹幕，验证列表接口是否真的瘦身
  const rec = {
    bvid: bv,
    title: `压测素材 #${i} ${'长标题'.repeat(3)}`,
    up: { mid: 100000 + i, name: `UP主${i % 500}` },
    duration: 60 + rand(600),
    pubdate: new Date(Date.now() - rand(90) * 86400_000).toISOString(),
    stat: { view: rand(9_000_000), danmaku: rand(5000), reply: rand(2000), favorite: rand(20000), coin: rand(9000), like: rand(80000), share: rand(900) },
    url: `https://www.bilibili.com/video/${bv}`,
    cover: `covers/${bv}.jpg`,
    frames: Array.from({ length: 10 }, (_, k) => ({ t: k * 12, file: `frames/${bv}/f${pad(k, 2)}.jpg`, timeStr: `0:${pad(k * 12, 2)}` })),
    aiSummary: '',
    judge: i % 4 === 0 ? null : { worth: i % 3 !== 0, tier: TIERS[i % 4], why: `压测理由 ${i}`, at: new Date().toISOString(), model: 'stress' },
    hotComments: Array.from({ length: 8 }, (_, k) => ({ text: `压测热评 ${i}-${k} ${'内容'.repeat(12)}`, like: rand(5000), user: `用户${k}`, rpid: 300000 + i * 10 + k })),
    hotDanmaku: Array.from({ length: 10 }, (_, k) => ({ text: `弹幕${k}`, count: rand(50) })),
    memes: [`梗${i % 7}`, `梗${i % 11}`],
    danmakuTotal: rand(6000),
    reason: '',
    source: ['collect'],
    fetchedAt: new Date(Date.now() - i * 60_000).toISOString(),
    fetchedBy: 'stress',
    quotes: Array.from({ length: 3 }, (_, k) => ({ t: k * 20, text: `压测金句 ${i}-${k}`, kind: '金句' })),
    subtitle: { lang: 'ai-zh', chars: rand(4000), missing: '' },
  }
  writeFileSync(join(VIDEOS, `${bv}.json`), JSON.stringify(rec))
}
const mb = readdirSync(VIDEOS).reduce((s, f) => s + f.length, 0)
console.log(`造完：${Date.now() - t0}ms，${readdirSync(VIDEOS).length} 个文件`)
console.log(`\n下一步：以这个库启动宿主，再跑统计`)
console.log(`  $env:BILI_STORE='${ROOT}'`)
console.log(`  然后请求 /api/bili-wb/store/list?page=1&pageSize=20 观察延迟与体积\n`)
