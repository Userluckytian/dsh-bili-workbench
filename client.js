/**
 * dsh-bili-workbench —— 浏览器半端
 * ============================================================================
 * 界面以 workbench-mockup/index.html 为准：
 *   · 左侧 196px 竖排导航（可折叠）+ 右侧内容区，每页自己的标题/副标题
 *   · 登录/二维码只在「我的」
 *   · 五个模块：素材库 / 刷B站 / 创作·出片 / 审核·发布 / 我的
 *
 * 数据全部走宿主 /api/bili-wb/*；没有假数据。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    const API = '/api/bili-wb'
    const jget = async (p) => {
      try {
        const r = await fetch(API + p, { headers: { accept: 'application/json' } })
        return r.ok ? await r.json() : { ok: false, error: 'HTTP ' + r.status }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    }
    const jpost = async (p, body) => {
      try {
        const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        return r.ok ? await r.json() : { ok: false, error: 'HTTP ' + r.status }
      } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    }

    /* ── 小工具 ── */
    const fmtNum = (n) => {
      const v = Number(n)
      if (!Number.isFinite(v)) return '-'
      if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿'
      if (v >= 1e4) return (v / 1e4).toFixed(1) + '万'
      return String(v)
    }
    const fmtDur = (d) => {
      if (typeof d === 'string' && /:/.test(d)) return d
      const s = Number(d)
      if (!Number.isFinite(s) || s <= 0) return ''
      return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    }
    const mmss = (t) => {
      const s = Math.max(0, Math.round(Number(t) || 0))
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    const dayOf = (iso) => {
      try { return new Date(iso).toLocaleDateString('sv-SE') } catch { return String(iso || '').slice(0, 10) }
    }
    const errText = (r) => (r && (r.error?.message || r.error?.hint || (typeof r.error === 'string' ? r.error : '') || r.hint || r.text)) || ''
    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
    const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''

    const STAGES = {
      draft: ['草稿', ''],
      rendering: ['渲染中', 'ok'],
      rendered: ['已完成 · 待审', 'ok'],
      approved: ['已通过', 'worth'],
      rejected: ['已打回', 'skip'],
      published: ['已发布', 'worth'],
      failed: ['失败', 'skip'],
      scripted: ['已排期', ''],
    }
    const stageOf = (s) => STAGES[s] || [s || '未知', '']
    const VOICES = {
      'zh-CN-YunxiNeural': '云希（男·青年）',
      'zh-CN-XiaoxiaoNeural': '晓晓（女·通用）',
      'zh-CN-XiaoyiNeural': '晓伊（女·年轻）',
      'zh-CN-YunxiaNeural': '云夏（少年）',
    }
    const voiceLabel = (v) => VOICES[v] || v || ''

    function useApi(path, { auto = true } = {}) {
      const [st, setSt] = useState({ loading: Boolean(auto), data: null, err: '' })
      const [tick, setTick] = useState(0)
      const pathRef = useRef(path)
      pathRef.current = path
      useEffect(() => {
        if (!path || !auto) return
        let live = true
        setSt((s) => ({ ...s, loading: true, err: '' }))
        jget(path).then((r) => {
          if (!live) return
          if (r && r.ok !== false) setSt({ loading: false, data: r, err: '' })
          else setSt({ loading: false, data: r, err: errText(r) || '取数失败' })
        })
        return () => { live = false }
      }, [path, tick, auto])
      return { ...st, reload: () => setTick((n) => n + 1) }
    }

    function usePoll(reload, ms, enabled) {
      const ref = useRef(reload)
      ref.current = reload
      useEffect(() => {
        if (!enabled) return
        const t = setInterval(() => ref.current(), ms)
        return () => clearInterval(t)
      }, [ms, enabled])
    }

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(ta)
          return ok
        } catch { return false }
      }
    }

    const CSS = `
[data-wb-root]{
  /* 直接吃 dsh 的主题变量：白底 + 深色文字；dsh 切暗色时自动跟着变 */
  --wb-bg:var(--dsw-alias-bg-base,#fff);
  --wb-panel:var(--dsw-alias-bg-layer-1,#fff);
  --wb-card:var(--dsw-alias-bg-layer-1,#fff);
  --wb-card2:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.05));
  --wb-line:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 12%,transparent);
  --wb-tx:var(--dsw-alias-label-primary,#0f1115);
  --wb-dim:var(--dsw-alias-label-secondary,#61666b);
  --wb-dim2:var(--dsw-alias-label-tertiary,#81858c);
  --wb-acc:#3b82f6; --wb-green:#22c55e; --wb-blue:#3b82f6; --wb-gray:#9aa0a6; --wb-amber:#f59e0b; --wb-red:#ef4444;
  --wb-rail:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 3%,var(--dsw-alias-bg-base,#fff));
  --wb-shadow:0 1px 2px rgba(15,17,21,.04);
  display:flex;height:calc(100vh - 76px);max-height:calc(100vh - 76px);min-height:480px;position:relative;overflow:hidden;
  background:var(--wb-bg);color:var(--wb-tx);
  font:14px/1.5 "Microsoft YaHei","Segoe UI",system-ui,sans-serif;
}
[data-wb-root] *{box-sizing:border-box}
[data-wb-rail]{width:196px;flex:none;background:var(--wb-rail);border-right:1px solid var(--wb-line);
  display:flex;flex-direction:column;padding:16px 10px;gap:2px;transition:width .16s ease;}
[data-wb-brand]{font-size:15px;font-weight:800;padding:6px 12px 16px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;}
[data-wb-brand] small{display:block;font-size:11px;font-weight:500;color:var(--wb-dim2);margin-top:3px;}
[data-wb-nav]{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;margin-bottom:2px;border:0;border-radius:9px;
  background:transparent;color:var(--wb-dim);font:inherit;text-align:left;cursor:pointer;position:relative;white-space:nowrap;}
[data-wb-nav]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-nav][aria-selected="true"]{background:rgba(59,130,246,.12);color:var(--wb-acc);font-weight:700;}
[data-wb-nav][aria-selected="true"]::before{content:"";position:absolute;left:-10px;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--wb-acc);}
[data-wb-nav] .ico{font-size:15px;width:18px;text-align:center;flex:none;}
[data-wb-nav] [data-wb-label]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-wb-nav] .badge{margin-left:auto;font-size:10px;padding:0 6px;border-radius:999px;background:var(--wb-acc);color:#fff;}
[data-wb-rail-foot]{margin-top:auto;padding:8px 4px 0;border-top:1px solid var(--wb-line);}
[data-wb-ghost]{width:100%;padding:7px;border-radius:8px;border:1px solid var(--wb-line);background:transparent;color:var(--wb-dim);font:inherit;cursor:pointer;}
[data-wb-ghost]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-root][data-collapsed] [data-wb-rail]{width:62px;padding:16px 6px;}
[data-wb-root][data-collapsed] [data-wb-label],
[data-wb-root][data-collapsed] [data-wb-brand] small{display:none;}
[data-wb-root][data-collapsed] [data-wb-brand]{font-size:0;padding:4px 0 14px;text-align:center;}
[data-wb-root][data-collapsed] [data-wb-brand]::after{content:"WB";font-size:13px;}
[data-wb-root][data-collapsed] [data-wb-nav]{justify-content:center;padding:10px 0;}
[data-wb-main]{flex:1;min-width:0;overflow:auto;padding:20px 24px 34px;}
[data-wb-page]{display:flex;flex-direction:column;gap:14px;max-width:1180px;}
[data-wb-head]{display:flex;align-items:center;gap:12px;margin-bottom:2px;flex-wrap:wrap;}
[data-wb-title]{font-size:19px;font-weight:800;}
[data-wb-sub]{font-size:12px;color:var(--wb-dim2);}
[data-wb-grow]{flex:1;min-width:0;}
[data-wb-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-wb-col]{display:flex;flex-direction:column;gap:10px;}
[data-wb-btn]{padding:7px 13px;border-radius:9px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font:inherit;cursor:pointer;white-space:nowrap;}
[data-wb-btn]:hover{border-color:rgba(59,130,246,.5);}
[data-wb-btn][data-primary]{background:var(--wb-acc);border-color:var(--wb-acc);color:#fff;font-weight:600;}
[data-wb-btn][data-sm]{padding:4px 10px;font-size:12px;}
[data-wb-btn][disabled]{opacity:.45;cursor:not-allowed;}
[data-wb-chip]{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--wb-line);color:var(--wb-dim);white-space:nowrap;}
[data-wb-chip][data-sel]{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.55);color:var(--wb-acc);font-weight:600;}
[data-wb-chip][data-ok]{color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-chip][data-warn]{color:#b45309;color:light-dark(#b45309,#fbbf24);border-color:rgba(245,158,11,.45);}
[data-wb-tier]{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:700;white-space:nowrap;display:inline-block;border:1px solid;}
[data-wb-tier="值得看"]{background:rgba(34,197,94,.16);color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-tier="可以看"]{background:rgba(59,130,246,.16);color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);border-color:rgba(59,130,246,.45);}
[data-wb-tier="跳过"]{background:rgba(154,160,166,.14);color:#5b6166;color:light-dark(#5b6166,#9aa0a6);border-color:rgba(154,160,166,.35);}
[data-wb-tier][data-tone="worth"], [data-wb-badge][data-tone="worth"]{background:rgba(34,197,94,.16);color:#15803d;color:light-dark(#15803d,#4ade80);border-color:rgba(34,197,94,.45);}
[data-wb-tier][data-tone="ok"], [data-wb-badge][data-tone="ok"]{background:rgba(59,130,246,.16);color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);border-color:rgba(59,130,246,.45);}
[data-wb-tier][data-tone="skip"], [data-wb-badge][data-tone="skip"]{background:rgba(154,160,166,.14);color:#5b6166;color:light-dark(#5b6166,#9aa0a6);border-color:rgba(154,160,166,.35);}
[data-wb-badge]{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-dim);white-space:nowrap;}
[data-wb-cmt]{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,.14);color:#b45309;color:light-dark(#b45309,#fbbf24);border:1px solid rgba(245,158,11,.4);white-space:nowrap;flex:none;}
[data-wb-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;font-size:12px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font-family:inherit;}
[data-wb-input]:focus{outline:none;border-color:var(--wb-acc);}
[data-wb-input][data-area]{resize:vertical;min-height:64px;line-height:19px;}
[data-wb-input][data-num]{width:84px;text-align:center;}
[data-wb-search]{width:100%;padding:10px 14px;border-radius:11px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font:inherit;}
[data-wb-search]:focus{outline:none;border-color:var(--wb-acc);}
[data-wb-searchwrap]{max-width:560px;margin:0 auto 12px;position:relative;width:100%;}
[data-wb-searchwrap] .kbd{position:absolute;right:12px;top:11px;font-size:11px;color:var(--wb-dim2);}
[data-wb-split]{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
@media(max-width:980px){[data-wb-split]{grid-template-columns:1fr;}}
@media(max-width:820px){[data-wb-rail]{width:62px;padding:16px 6px;}[data-wb-label],[data-wb-brand] small{display:none;}[data-wb-brand]{font-size:0;text-align:center;}[data-wb-brand]::after{content:"WB";font-size:13px;}[data-wb-nav]{justify-content:center;padding:10px 0;}[data-wb-main]{padding:16px;}}
[data-wb-sec]{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--wb-line);border-radius:13px;background:var(--wb-card);box-shadow:var(--wb-shadow);}
[data-wb-h]{font-size:11px;font-weight:700;letter-spacing:.04em;color:var(--wb-dim2);}
[data-wb-projtitle]{font-size:14.5px;font-weight:700;}
[data-wb-note]{font-size:11.5px;line-height:17px;color:var(--wb-dim2);}
[data-wb-meta]{font-size:11.5px;color:var(--wb-dim2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-wb-why]{font-size:12.5px;color:var(--wb-dim);line-height:1.55;}
[data-wb-pre]{margin:0;padding:10px 12px;border-radius:9px;font-size:11.5px;line-height:18px;white-space:pre-wrap;word-break:break-word;background:var(--wb-card2);color:var(--wb-dim);max-height:280px;overflow:auto;}
[data-wb-err]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.28);color:#b91c1c;color:light-dark(#b91c1c,#f87171);word-break:break-word;}
[data-wb-okmsg]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.28);color:#15803d;color:light-dark(#15803d,#4ade80);}
[data-wb-loading]{font-size:12px;color:var(--wb-dim2);}
[data-wb-grid]{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));}
[data-wb-card]{display:flex;flex-direction:column;overflow:hidden;border-radius:13px;border:1px solid var(--wb-line);background:var(--wb-card);box-shadow:var(--wb-shadow);min-width:0;}
[data-wb-card]:hover{border-color:rgba(59,130,246,.45);}
[data-wb-cover]{position:relative;aspect-ratio:16/9;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,.85);font-family:ui-monospace,Consolas,monospace;background:linear-gradient(135deg,#4c6ef5,#845ef7 55%,#0ca678);}
[data-wb-cover] img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
[data-wb-cover] [data-wb-tier]{position:absolute;left:8px;top:8px;z-index:2;}
[data-wb-cover] [data-wb-dur]{position:absolute;right:7px;bottom:7px;font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;font-family:ui-monospace,monospace;z-index:2;}
[data-wb-body]{padding:11px 13px 13px;display:flex;flex-direction:column;gap:6px;min-width:0;}
[data-wb-cardtitle]{font-size:13.5px;font-weight:700;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
[data-wb-mat]{display:flex;align-items:flex-start;gap:14px;padding:14px;border:1px solid var(--wb-line);border-radius:13px;background:var(--wb-card);box-shadow:var(--wb-shadow);}
[data-wb-mat] [data-wb-thumb]{width:188px;flex:none;border-radius:9px;overflow:hidden;background:var(--wb-card2);position:relative;aspect-ratio:16/9;}
[data-wb-mat] [data-wb-thumb] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-wb-mat] .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:7px;}
@media(max-width:980px){[data-wb-mat]{flex-direction:column;}[data-wb-mat] [data-wb-thumb]{width:100%;}}
[data-wb-quotes]{display:flex;flex-direction:column;gap:5px;}
[data-wb-quote]{font-size:12.5px;padding:6px 9px;border-radius:8px;background:var(--wb-card2);border:1px solid var(--wb-line);line-height:1.5;}
[data-wb-quote] b{color:#1d4ed8;color:light-dark(#1d4ed8,#7aa7ff);font-family:ui-monospace,monospace;font-weight:700;margin-right:6px;}
[data-wb-frames]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-frames] img{width:76px;height:43px;object-fit:cover;border-radius:6px;border:1px solid var(--wb-line);}
[data-wb-bar]{height:7px;border-radius:999px;background:var(--wb-card2);overflow:hidden;}
[data-wb-bar] i{display:block;height:100%;background:linear-gradient(90deg,var(--wb-acc),#8b5cf6);transition:width .3s;}
[data-wb-shots]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-shot]{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--wb-card2);border:1px solid var(--wb-line);color:var(--wb-dim);}
[data-wb-shot] b{color:var(--wb-tx);}
[data-wb-login]{display:flex;gap:18px;align-items:flex-start;padding:16px;border:1px solid rgba(59,130,246,.4);border-radius:13px;background:rgba(59,130,246,.08);}
[data-wb-qr]{width:150px;height:150px;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;}
[data-wb-qr] img{width:100%;height:100%;object-fit:contain;}
[data-wb-qr] .ph{width:118px;height:118px;border-radius:4px;background:repeating-conic-gradient(#0b1020 0 25%,#fff 0 50%) 0 0/16px 16px;}
[data-wb-stat]{padding:12px 14px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card);}
[data-wb-stat] b{display:block;font-size:20px;line-height:1.2;}
[data-wb-stat] span{font-size:11.5px;color:var(--wb-dim2);}
[data-wb-field]{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--wb-dim);flex-wrap:wrap;}
[data-wb-field] input, [data-wb-field] select{max-width:100%;}
[data-wb-toggle]{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--wb-dim);}
[data-wb-toggle] input{accent-color:var(--wb-acc);}
[data-wb-overlay]{position:absolute;inset:0;z-index:60;background:rgba(3,7,18,.9);display:flex;align-items:center;justify-content:center;padding:24px;}
[data-wb-overlay] video{max-width:96%;max-height:88%;border-radius:12px;background:#000;}
[data-wb-overlay] .x{position:absolute;top:14px;right:18px;font-size:22px;color:#fff;background:transparent;border:0;cursor:pointer;}
[data-wb-kv]{font-size:11.5px;line-height:19px;color:var(--wb-dim2);word-break:break-all;}
[data-wb-divider]{height:1px;background:var(--wb-line);margin:2px 0;}
[data-wb-composer]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid rgba(59,130,246,.35);border-radius:11px;background:rgba(59,130,246,.06);}
`

    /* ── 小组件 ── */
    const Btn = ({ primary, sm, children, ...rest }) => h('button', {
      ...rest, 'data-wb-btn': '', 'data-primary': primary ? '' : undefined, 'data-sm': sm ? '' : undefined,
    }, children)
    const Chip = ({ sel, ok, warn, children, ...rest }) => h('span', { ...rest, 'data-wb-chip': '', 'data-sel': sel ? '' : undefined, 'data-ok': ok ? '' : undefined, 'data-warn': warn ? '' : undefined }, children)
    const Tier = ({ t }) => t ? h('span', { 'data-wb-tier': t }, t) : null
    const PageHead = ({ title, sub, children }) => h('div', { 'data-wb-head': '' },
      h('div', {}, h('div', { 'data-wb-title': '' }, title), sub ? h('div', { 'data-wb-sub': '' }, sub) : null),
      h('div', { 'data-wb-grow': '' }),
      children)
    const Field = ({ label, children }) => h('div', { 'data-wb-field': '' }, h('span', {}, label), children)
    const Note = ({ children }) => h('div', { 'data-wb-note': '' }, children)
    const Sec = ({ title, children, style }) => h('div', { 'data-wb-sec': '', style },
      title ? h('div', { 'data-wb-h': '' }, title) : null, children)
    const Err = ({ children }) => children ? h('div', { 'data-wb-err': '' }, children) : null
    const OkMsg = ({ children }) => children ? h('div', { 'data-wb-okmsg': '' }, children) : null

    /* ═══════════════════ ① 素材库 ═══════════════════ */
    function StoreRow({ r, onDetail, onBasket, inBasket }) {
      const quotes = r.quotes || []
      const frames = r.frames || []
      return h('div', { 'data-wb-mat': '' },
        h('div', { 'data-wb-thumb': '' },
          h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
          r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
        h('div', { className: 'body' },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '', style: { flex: '1 1 260px' } }, r.title || '(无标题)'),
            r.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null),
          h('div', { 'data-wb-meta': '' },
            [r.up?.name, fmtDur(r.duration), `采集于 ${dayOf(r.fetchedAt)}`, `${quotes.length} 条可用片段`].filter(Boolean).join(' · ')),
          r.judge ? h('div', { 'data-wb-why': '' }, `💬 ${r.judge.why || '（没写理由）'}`)
            : h('div', { 'data-wb-note': '' }, '还没判定 —— 去「刷B站 → 设置」跑一轮'),
          quotes.length
            ? h('div', { 'data-wb-quotes': '' }, ...quotes.map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
              h('b', {}, mmss(x.t)), x.text, x.kind ? h('span', { 'data-wb-meta': '', style: { marginLeft: '6px' } }, `· ${x.kind}`) : null)))
            : h('div', { 'data-wb-note': '' }, '（这条没有可用片段 —— 无字幕或无信息量）'),
          (r.memes || []).length ? h('div', { 'data-wb-meta': '' }, '热梗：' + r.memes.slice(0, 4).join(' · ')) : null,
          (r.hotComments || []).length ? h('div', { 'data-wb-note': '' }, '热评：' + r.hotComments.slice(0, 2).map((x) => x.text).join(' / ')) : null,
          (r.hotDanmaku || []).length ? h('div', { 'data-wb-note': '' }, '弹幕：' + r.hotDanmaku.slice(0, 4).map((x) => `${x.text}(${x.count})`).join(' · ')) : null,
          frames.length
            ? h('div', { 'data-wb-frames': '' }, ...frames.slice(0, 6).map((f, i) => h('img', {
              key: i,
              src: `${API}/store/media?kind=frame&bv=${r.bvid}&name=${encodeURIComponent(String(f.file || '').split('/').pop())}`,
              alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' },
            })))
            : null,
          h('div', { 'data-wb-row': '' },
            h(Btn, { sm: true, onClick: () => onDetail(r.bvid) }, '逐字稿 / 详情'),
            h(Btn, { sm: true, onClick: () => onBasket(r.bvid) }, inBasket ? '已加入创作篮' : '加入创作篮'),
            h('div', { 'data-wb-grow': '' }),
            r.stat ? h('span', { 'data-wb-meta': '' }, `播放 ${fmtNum(r.stat.view)} · 点赞 ${fmtNum(r.stat.like)}`) : null)))
    }

    function TabStore({ basket, setBasket }) {
      const [q, setQ] = useState('')
      const [view, setView] = useState('list')
      const [open, setOpen] = useState('')
      const list = useApi('/store/list?limit=300')
      const detail = useApi(open ? '/store/item?bv=' + encodeURIComponent(open) : '', { auto: Boolean(open) })
      const rows = (list.data?.rows || []).filter((r) => {
        if (!q.trim()) return true
        const k = q.trim().toLowerCase()
        return [r.title, r.up?.name, r.judge?.why, ...(r.quotes || []).map((x) => x.text)]
          .some((s) => String(s || '').toLowerCase().includes(k))
      })
      const rec = detail.data?.record
      const sub = detail.data?.subtitles

      const toggleBasket = (bv) => setBasket(basket.includes(bv) ? basket.filter((x) => x !== bv) : [...basket, bv])

      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '素材库', sub: '从视频里收集的素材：点评 + 时间点片段 + 关键帧' },
          h('input', { 'data-wb-search': '', style: { maxWidth: '260px' }, placeholder: '在库里搜标题 / 点评 / 金句…', value: q, onChange: (e) => setQ(e.target.value) }),
          h(Btn, { sm: true, onClick: list.reload }, '刷新'),
          h(Btn, { sm: true, onClick: () => setView(view === 'list' ? 'cards' : 'list') }, view === 'list' ? '卡片视图' : '列表视图')),
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, `库内 ${list.data?.stats?.videos ?? rows.length} 条 · ${list.data?.stats?.mb ?? '-'} MB`),
          basket.length ? h(Chip, { ok: true }, `创作篮 ${basket.length}`) : null,
          h('div', { 'data-wb-grow': '' }),
          h(Note, {}, '素材库不显示档位标签 —— 档位只属于「刷B站」')),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读素材库…') : null,
        !list.loading && !rows.length ? h(Note, {}, q ? '没搜到 —— 换个词试试' : '库还是空的 —— 去「刷B站」采几条，或点「看懂视频」') : null,

        view === 'list'
          ? h('div', { 'data-wb-col': '' }, ...rows.map((r) => h(StoreRow, {
            key: r.bvid, r, inBasket: basket.includes(r.bvid),
            onDetail: (bv) => setOpen(open === bv ? '' : bv),
            onBasket: toggleBasket,
          })))
          : h('div', { 'data-wb-grid': '' }, ...rows.map((r) => h('div', { key: r.bvid, 'data-wb-card': '' },
            h('div', { 'data-wb-cover': '' },
              h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
              r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, r.title || '(无标题)'),
                r.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null),
              h('div', { 'data-wb-meta': '' }, [r.up?.name, `${(r.quotes || []).length} 条片段`].filter(Boolean).join(' · ')),
              (r.quotes || [])[0] ? h('div', { 'data-wb-note': '' }, `${mmss(r.quotes[0].t)}「${String(r.quotes[0].text).slice(0, 26)}」`) : null,
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, onClick: () => setOpen(r.bvid) }, '详情'),
                h(Btn, { sm: true, onClick: () => toggleBasket(r.bvid) }, basket.includes(r.bvid) ? '已加入' : '加入创作篮')))))),

        rec ? h(Sec, { title: '素材详情' },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '' }, rec.title),
            rec.judge ? h(Tier, { t: rec.judge.tier }) : null,
            rec.commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null,
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setOpen('') }, '收起')),
          h('div', { 'data-wb-meta': '' }, [rec.up?.name, fmtDur(rec.duration), rec.zone, dayOf(rec.fetchedAt)].filter(Boolean).join(' · ')),
          rec.judge ? h('div', { 'data-wb-why': '' }, `判定：${rec.judge.tier} — ${rec.judge.why}`) : null,
          (rec.memes || []).length ? h('div', { 'data-wb-meta': '' }, '热梗：' + rec.memes.join(' · ')) : null,
          (rec.hotComments || []).length ? h('div', { 'data-wb-col': '' },
            h('div', { 'data-wb-h': '' }, '热评'),
            ...rec.hotComments.slice(0, 8).map((x, i) => h('div', { key: i, 'data-wb-note': '' }, `👍 ${x.like ?? 0} · ${x.user || ''}：${x.text}`))) : null,
          (rec.hotDanmaku || []).length ? h('div', { 'data-wb-meta': '' }, '热门弹幕：' + rec.hotDanmaku.slice(0, 10).map((x) => `${x.text}(${x.count})`).join(' · ')) : null,
          (rec.quotes || []).length ? h('div', { 'data-wb-col': '' },
            h('div', { 'data-wb-h': '' }, `可用片段 ${rec.quotes.length} 条`),
            h('div', { 'data-wb-quotes': '' }, ...rec.quotes.map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
              h('b', {}, mmss(x.t)), x.text, x.kind ? h('span', { 'data-wb-meta': '', style: { marginLeft: '6px' } }, `· ${x.kind}`) : null)))) : null,
          sub?.items?.length ? h('div', { 'data-wb-col': '' },
            h('div', { 'data-wb-h': '' }, `逐字稿（共 ${sub.total} 句，显示前 ${sub.items.length}）`),
            h('pre', { 'data-wb-pre': '' }, sub.items.map((x) => `${mmss(x.from)} ${x.content}`).join('\n'))) : null) : null)
    }

    /* ═══════════════════ ② 刷B站 ═══════════════════ */
    /** 评论 / 回复 / 私信共用：先生成草稿，再看原文，再决定 dry-run 还是真发 */
    function InteractComposer({ kind, target, onClose, onSent }) {
      const [text, setText] = useState('')
      const [gen, setGen] = useState(true)
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [real, setReal] = useState(false)
      const label = kind === 'comment' ? '评论' : kind === 'reply' ? '回复' : '私信'

      const genText = async () => {
        setGen(true); setDump('')
        const r = await jpost('/interact/preview', { kind, ...(target.ctx || {}) })
        setGen(false)
        if (r.ok) {
          setText(r.text || '')
          if (r.cap) setDump('注意：' + r.cap)
        } else setDump('生成失败：' + (errText(r) || ''))
      }
      useEffect(() => { genText() }, [])
      const send = async () => {
        if (!text.trim()) return
        setBusy('send')
        const r = await jpost('/interact/send', { kind, text, confirm: true, dryRun: !real, ...(target.ids || {}) })
        setBusy('')
        if (r.ok) {
          setDump(`${r.dryRun ? 'dry-run（没有真的发）' : '已发送'}\n${(r.command || []).join(' ')}`)
          if (!r.dryRun) onSent?.()
        } else setDump('失败：' + (errText(r) || ''))
      }

      return h('div', { 'data-wb-composer': '' },
        h('div', { 'data-wb-row': '' },
          h('div', { 'data-wb-h': '' }, `${label} ${target.label || ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: onClose }, '收起')),
        gen ? h('div', { 'data-wb-loading': '' }, `AI 正在写${label}…（一般 10–40 秒）`) : null,
        h('textarea', {
          'data-wb-input': '', 'data-area': '', value: text,
          onChange: (e) => setText(e.target.value), placeholder: gen ? '生成中…' : `${label}内容`,
        }),
        h('div', { 'data-wb-row': '' },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', checked: real, onChange: (e) => setReal(e.target.checked) }),
            h('span', {}, '真的发（不勾=只 dry-run）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, primary: true, disabled: gen || busy === 'send' || !text.trim(), onClick: send }, busy === 'send' ? '发送中…' : '发送'),
          h(Btn, { sm: true, disabled: gen || busy === 'p', onClick: async () => { setBusy('p'); await genText(); setBusy('') } }, '重新生成')),
        dump ? h('pre', { 'data-wb-pre': '' }, dump) : null)
    }

    function VideoCard({ it, tier, commented, onWatch, onComment }) {
      const bv = it.bvid
      const view = it.stat?.view ?? it.play
      const like = it.stat?.like ?? it.like
      const up = it.author?.name || it.up?.name || it.owner?.name || ''
      return h('div', { 'data-wb-card': '' },
        h('div', { 'data-wb-cover': '' },
          h('span', {}, bv),
          h('img', { src: `${API}/cover?bv=${bv}`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
          tier ? h(Tier, { t: tier }) : null,
          it.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(it.duration)) : null),
        h('div', { 'data-wb-body': '' },
          h('div', { 'data-wb-cardtitle': '' }, it.title || '(无标题)'),
          h('div', { 'data-wb-meta': '' }, [up, view ? `播放 ${fmtNum(view)}` : '', like ? `点赞 ${fmtNum(like)}` : ''].filter(Boolean).join(' · ')),
          h('div', { 'data-wb-row': '' },
            commented ? h('span', { 'data-wb-cmt': '' }, '已评论') : null,
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => onComment(it) }, '评论'),
            h(Btn, { sm: true, primary: true, onClick: () => onWatch(bv) }, '看懂视频'),
            h(Btn, { sm: true, onClick: () => window.open(it.url || ('https://www.bilibili.com/video/' + bv), '_blank') }, '打开'))))
    }

    function SubVideo({ storeMap, cfg, onCommented, onKeywordsChanged }) {
      const [q, setQ] = useState('')
      const [key, setKey] = useState('')
      const [detail, setDetail] = useState('')
      const [comment, setComment] = useState(null)
      const [editTags, setEditTags] = useState(false)
      const pressRef = useRef(null)
      const suppressRef = useRef(false)
      const hot = useApi(key ? '' : '/hot?size=24', { auto: !key })
      const search = useApi(key ? `/search?q=${encodeURIComponent(key)}&size=24` : '', { auto: Boolean(key) })
      const watch = useApi(detail ? '/video?bv=' + encodeURIComponent(detail) : '', { auto: Boolean(detail) })
      const items = key ? (search.data?.items || []) : (hot.data?.items || [])
      const loading = key ? search.loading : hot.loading
      const err = key ? search.err : hot.err
      const d = watch.data?.data

      const keywords = cfg?.keywords || []
      const cancelPress = () => {
        if (pressRef.current) { clearTimeout(pressRef.current); pressRef.current = null }
      }
      const startPress = () => {
        cancelPress()
        pressRef.current = setTimeout(() => { suppressRef.current = true; setEditTags(true) }, 550)
      }
      const saveKeywords = async (next) => {
        const r = await jpost('/config', { keywords: next })
        if (!r.ok) return false
        onKeywordsChanged?.()
        return true
      }
      const delKeyword = async (k) => {
        const next = keywords.filter((x) => x !== k)
        if (await saveKeywords(next) && key === k) { setKey(''); setQ('') }
      }
      const addKeyword = async () => {
        const v = String(prompt('加一个关注关键词：') || '').trim()
        if (!v) return
        if (!keywords.includes(v)) {
          if (!await saveKeywords([...keywords, v])) return
        }
        setQ(v); setKey(v)
      }
      const openComment = (it) => {
        const rec = storeMap[it.bvid] || {}
        setComment({
          label: it.title || it.bvid,
          ctx: { title: it.title || '', up: it.author?.name || it.up?.name || '', quotes: rec.quotes || [] },
          ids: { bv: it.bvid },
        })
      }
      return h('div', {
        'data-wb-col': '',
        onClick: (e) => {
          if (!editTags) return
          if (e.target?.closest?.('[data-wb-tag]')) return
          setEditTags(false)
        },
      },
        h('div', { 'data-wb-searchwrap': '' },
          h('input', {
            'data-wb-search': '', placeholder: '搜视频、UP、关键词…', value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') setKey(q.trim()) },
          }),
          h('span', { className: 'kbd' }, 'Enter')),
        h('div', { 'data-wb-row': '', style: { justifyContent: 'center', marginBottom: '6px' } },
          h('span', { 'data-wb-chip': '', 'data-sel': key ? undefined : '', style: { cursor: 'pointer' }, onClick: () => { if (editTags) return; setKey(''); setQ('') } }, '热门'),
          ...keywords.map((k) => h('span', {
            key: k, 'data-wb-chip': '', 'data-wb-tag': '',
            'data-sel': key === k ? '' : undefined,
            style: {
              cursor: 'pointer', position: 'relative',
              borderStyle: editTags ? 'dashed' : undefined,
              paddingRight: editTags ? '18px' : undefined,
            },
            onPointerDown: startPress,
            onPointerUp: cancelPress,
            onPointerLeave: cancelPress,
            onContextMenu: (e) => e.preventDefault(),
            onClick: () => {
              if (suppressRef.current) { suppressRef.current = false; return }
              if (editTags) return
              setKey(k); setQ(k)
            },
          }, k, editTags ? h('span', {
            'data-wb-tagdel': '',
            style: {
              position: 'absolute', top: '-7px', right: '-7px', width: '14px', height: '14px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '50%', background: 'var(--dsw-alias-label-primary, #0f1115)',
              color: 'var(--dsw-alias-bg-base, #fff)', fontSize: '11px', lineHeight: 1,
            },
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => { e.stopPropagation(); delKeyword(k) },
          }, '×') : null)),
          h('span', { 'data-wb-chip': '', style: { cursor: 'pointer' }, onClick: () => { if (!editTags) addKeyword() } }, '+ 关键词')),
        editTags ? h(Note, {}, '点标签右上角 × 删除 · 点空白处退出') : null,
        h('div', { 'data-wb-row': '' },
          h(Note, {}, key ? `搜索：${key}` : '综合热门'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: key ? search.reload : hot.reload }, '刷新')),
        comment ? h(InteractComposer, {
          key: comment.ids?.bv || 'comment',
          kind: 'comment', target: comment,
          onClose: () => setComment(null),
          onSent: () => { setComment(null); onCommented?.() },
        }) : null,
        h(Err, {}, err),
        loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        d ? h(Sec, { title: '看懂视频' },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '' }, d.title || detail),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setDetail('') }, '收起')),
          h('div', { 'data-wb-meta': '' }, [d.owner?.name, d.stat ? `播放 ${fmtNum(d.stat.view)} · 点赞 ${fmtNum(d.stat.like)}` : '', fmtDur(d.duration)].filter(Boolean).join(' · ')),
          d.ai_summary ? h('div', { 'data-wb-why': '' }, d.ai_summary) : null,
          d.transcript?.text ? h('pre', { 'data-wb-pre': '' }, String(d.transcript.text).slice(0, 2500)) : h(Note, {}, '这条没有字幕；已落库，但创作时引用不到原句。')) : null,
        h('div', { 'data-wb-grid': '' }, ...items.map((it) => h(VideoCard, {
          key: it.bvid, it,
          tier: storeMap[it.bvid]?.tier || '',
          commented: Boolean(storeMap[it.bvid]?.commented),
          onWatch: setDetail,
          onComment: openComment,
        }))),
        !loading && !items.length ? h(Note, {}, key ? '没搜到，换个词' : '热门拉不到（看看 bili 是否登录）') : null)
    }

    function SubInbox({ onCommented, cfg }) {
      const inbox = useApi('/inbox')
      const [composer, setComposer] = useState(null)
      const items = inbox.data?.items || []
      const c = inbox.data?.counts || {}
      const ownerUid = String(cfg?.ownerUid || '')
      const isOwner = (m) => Boolean(ownerUid && m.user?.mid && String(m.user.mid) === ownerUid)

      const replyTarget = (m) => ({
        kind: 'reply', label: m.user?.name || '',
        ctx: {
          message: m.content || '', replyingTo: m.replying_to || '', video: m.on?.title || '',
          owner: isOwner(m), ownerCall: cfg?.ownerCall || '老弟',
        },
        ids: { bv: m.on?.bvid, rpid: m.rpid, root: m.root },
      })
      const dmTarget = (m) => ({
        kind: 'dm', label: m.user?.name || '',
        ctx: { message: m.content || '', video: m.on?.title || '' },
        ids: { uid: String(m.user?.mid || '') },
      })

      return h('div', { 'data-wb-col': '' },
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, `回复 ${c.replies ?? 0}`),
          h(Chip, {}, `@ ${c.mentions ?? 0}`),
          h(Chip, {}, `私信 ${c.private_messages ?? 0}`),
          h(Chip, {}, `赞 ${c.likes ?? 0}`),
          h(Chip, { ok: Boolean(cfg?.autoReply) }, `自动回复 ${cfg?.autoReply ? '开' : '关'}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: inbox.reload }, '刷新')),
        h(Note, {}, '默认由 AI 写草稿；发出前一定先给你看原文，默认 dry-run。'),
        h(Err, {}, inbox.err),
        inbox.loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        composer ? h(InteractComposer, {
          key: composer.kind + (composer.ids?.rpid || composer.ids?.uid || composer.label || ''),
          kind: composer.kind, target: composer,
          onClose: () => setComposer(null),
          onSent: () => { setComposer(null); inbox.reload(); onCommented?.() },
        }) : null,
        !inbox.loading && !items.length ? h(Note, {}, inbox.data?.note || '没有新回复。') : null,
        ...items.map((m, i) => h('div', { key: i, 'data-wb-sec': '' },
          h('div', { 'data-wb-row': '' },
            h(Chip, {}, '回复'),
            isOwner(m) ? h(Chip, { ok: true }, '主人') : null,
            h('b', {}, m.user?.name || '?'),
            h('span', { 'data-wb-meta': '' }, [dayOf(m.time), m.on?.bvid].filter(Boolean).join(' · ')),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setComposer(replyTarget(m)) }, isOwner(m) ? '回答主人' : 'AI 写回复'),
            m.user?.mid ? h(Btn, { sm: true, onClick: () => setComposer(dmTarget(m)) }, '私信') : null),
          h('div', { 'data-wb-why': '' }, String(m.content || '')))))
    }

    function SubSettings({ onRunRound, onSaved }) {
      const cfgRes = useApi('/config')
      const cfg = cfgRes.data?.config
      const sched = cfgRes.data?.schedule || {}
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')

      useEffect(() => {
        if (cfg && draft === null) {
          setDraft({
            ...cfg,
            keywordsText: (cfg.keywords || []).join('\n'),
            modelChainText: (cfg.modelChain || []).join('\n'),
            tagsText: (cfg.defaultTags || []).join(','),
          })
        }
      }, [cfg, draft])
      if (cfgRes.loading || !draft) return h('div', { 'data-wb-loading': '' }, '读设置中…')

      const set = (k, v) => setDraft({ ...draft, [k]: v })
      const save = async () => {
        setBusy('save'); setMsg('保存中…')
        const r = await jpost('/config', {
          enabled: draft.enabled, scheduleRanges: draft.scheduleRanges, perDay: draft.perDay,
          keywords: String(draft.keywordsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          llmKey: draft.llmKey,
          personaPrompt: draft.personaPrompt, reportLevel: draft.reportLevel, favFolderId: draft.favFolderId,
          autoComment: draft.autoComment, autoReply: draft.autoReply,
          ownerUid: draft.ownerUid, ownerCall: draft.ownerCall,
          mentionName: draft.mentionName, replyPerDay: draft.replyPerDay,
          dmWatch: draft.dmWatch, dmWatchMinutes: draft.dmWatchMinutes,
          voice: draft.voice, modelChain: String(draft.modelChainText || '').split('\n').map((s) => s.trim()).filter(Boolean),
        })
        setBusy('')
        if (r.ok) {
          setMsg('已保存')
          setDraft({ ...r.config, keywordsText: (r.config.keywords || []).join('\n'), modelChainText: (r.config.modelChain || []).join('\n'), tagsText: (r.config.defaultTags || []).join(',') })
          cfgRes.reload(); onSaved?.()
        } else setMsg('保存失败：' + (errText(r) || ''))
      }
      const run = async () => {
        setBusy('run'); setMsg('跑一轮中…（采集 + 判定 + 抽句 / 弹幕 / 热梗 / 热评 + 日报，可能一两分钟）')
        const r = await jpost('/run-round')
        setBusy('')
        setMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : '跑失败：' + (errText(r) || ''))
      }

      return h('div', { 'data-wb-col': '' },
        h('div', { 'data-wb-row': '' },
          h(Note, {}, sched.lastRunAt ? `上次：${new Date(sched.lastRunAt).toLocaleString('zh-CN')} · ${sched.lastResult || ''}` : '还没跑过'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { primary: true, sm: true, disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存设置'),
          h(Btn, { sm: true, disabled: busy === 'run', onClick: run }, '立即跑一轮'),
          msg ? h('span', { 'data-wb-note': '' }, msg) : null),
        h('div', { 'data-wb-split': '' },
          h(Sec, { title: '日常 · 定时自动刷' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.enabled), onChange: (e) => set('enabled', e.target.checked) }),
              h('span', {}, '定时自动刷（总开关）')),
            h(Field, { label: '时段' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '240px' }, value: draft.scheduleRanges, onChange: (e) => set('scheduleRanges', e.target.value) }),
              h(Note, {}, '全天写 00:00-24:00；可多段，如 09:00-12:00, 20:00-23:30')),
            h(Field, { label: '每天上限' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 500, value: draft.perDay, onChange: (e) => set('perDay', e.target.value) }),
              h('span', {}, '条')),
            h(Field, { label: '来源' },
              h('span', {}, '综合热门 + 关注关键词（按时间自动混合）')),
            h(Note, {}, `今天已采 ${sched.todayCount ?? '?'} / 目标 ${sched.target ?? '?'} 条 · ${sched.inWindow === false ? '不在时段内' : '在时段内'}${sched.estMinutes ? ` · 约每 ${sched.estMinutes} 分钟 1 条` : ''} · 每条约 10 帧由 AI 挑`)),

          h(Sec, { title: '偏好 · 它按什么说话' },
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '关注关键词（一行一个；和视频页标签同步，采集时与热门混合）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 4, value: draft.keywordsText, onChange: (e) => set('keywordsText', e.target.value) })),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '人设（判定 / 方案 / 评论都用它）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 3, value: draft.personaPrompt || '', onChange: (e) => set('personaPrompt', e.target.value), placeholder: '例：叫我老弟，说话像贴吧老哥，犀利不客气，控制在 40 字内' })),
            h(Field, { label: '日报粒度' },
              h('select', { 'data-wb-input': '', style: { width: '120px' }, value: draft.reportLevel, onChange: (e) => set('reportLevel', e.target.value) },
                h('option', { value: 'full' }, '完整'),
                h('option', { value: 'brief' }, '薄版'),
                h('option', { value: 'off' }, '不写'))),
            h(Field, { label: '自动收藏到' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.favFolderId || '', onChange: (e) => set('favFolderId', e.target.value), placeholder: '收藏夹 ID / 名称（留空不收藏）' }))),

          h(Sec, { title: '互动 · 自动评论与回复' },
            h(Field, { label: '主人 UID' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.ownerUid || '', onChange: (e) => set('ownerUid', e.target.value), placeholder: '例如 498295893' }),
              h(Note, {}, '只有这个 UID 的指令会被当主人；其他人问统计/配置会被忽略')),
            h(Field, { label: '称呼' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '120px' }, value: draft.ownerCall || '', onChange: (e) => set('ownerCall', e.target.value), placeholder: '老弟' }),
              h(Note, {}, '评论里会自然称呼这个称呼')),
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.autoComment), onChange: (e) => set('autoComment', e.target.checked) }),
              h('span', {}, '自动评论并 @ 主人（每条采到的视频都留一条）')),
            h(Field, { label: '额外 @（可选）' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.mentionName || '', onChange: (e) => set('mentionName', e.target.value), placeholder: '留空=主人 UID' }),
              h(Note, {}, '只发在评论区，不私信')),
            h('div', { 'data-wb-row': '', style: { marginTop: '4px' } },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.autoReply), onChange: (e) => set('autoReply', e.target.checked) }),
                h('span', {}, '有人回复就自动回（主人指令会优先回答）'))),
            h(Field, { label: '每天最多回复' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 0, max: 200, value: draft.replyPerDay, onChange: (e) => set('replyPerDay', e.target.value) }),
              h('span', {}, '条（0=不限）')),
            h('div', { 'data-wb-row': '' },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.dmWatch), onChange: (e) => set('dmWatch', e.target.checked) }),
                h('span', {}, '私信监听（默认关，每')),
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 3, max: 240, value: draft.dmWatchMinutes, onChange: (e) => set('dmWatchMinutes', e.target.value) }),
              h('span', {}, '分钟看一眼）'))),

          h(Sec, { title: '模型链（判定 / 方案 / 互动都用它）' },
            h('textarea', {
              'data-wb-input': '', 'data-area': '', rows: Math.max(4, (draft.modelChainText || '').split('\n').length),
              value: draft.modelChainText, onChange: (e) => set('modelChainText', e.target.value),
            }),
            h(Note, {}, '一行一个；失败自动换下一个，429 退避重试。'),
            h(Field, { label: '默认音色' },
              h('select', { 'data-wb-input': '', style: { width: '190px' }, value: draft.voice, onChange: (e) => set('voice', e.target.value) },
                h('option', { value: 'zh-CN-YunxiNeural' }, '云希（男·青年）'),
                h('option', { value: 'zh-CN-XiaoxiaoNeural' }, '晓晓（女·通用）'),
                h('option', { value: 'zh-CN-XiaoyiNeural' }, '晓伊（女·年轻）'),
                h('option', { value: 'zh-CN-YunxiaNeural' }, '云夏（少年）')))),
        ),
        h(Err, {}, cfgRes.err))
    }

    function TabScroll({ basket }) {
      const [sub, setSub] = useState('video')
      const [running, setRunning] = useState(false)
      const [runMsg, setRunMsg] = useState('')
      const cfgRes = useApi('/config')
      const store = useApi('/store/list?limit=500')
      const storeMap = useMemo(() => {
        const m = {}
        for (const r of (store.data?.rows || [])) {
          m[r.bvid] = {
            tier: r.judge?.tier || '',
            commented: Boolean(r.commented),
            title: r.title || '',
            up: r.up?.name || '',
            quotes: (r.quotes || []).slice(0, 3).map((x) => x.text),
          }
        }
        return m
      }, [store.data])
      const today = store.data?.stats?.videos ?? 0
      const runRound = async () => {
        setRunning(true)
        setRunMsg('跑一轮中…（采集 + 判定 + 日报，一般 1–2 分钟）')
        const r = await jpost('/run-round')
        setRunning(false)
        setRunMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : ('跑失败：' + (errText(r) || '')))
        cfgRes.reload(); store.reload()
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: sub === 'msg' ? '刷B站 · 消息' : sub === 'set' ? '刷B站 · 设置' : '刷B站', sub: sub === 'msg' ? '未读、回复、@、私信 —— 回复先给草稿' : sub === 'set' ? '原插件的 日常 / 偏好 / 互动，全搬到这里' : '看视频、挑视频、采集成素材' },
          h('span', { 'data-wb-chip': '' }, `今日已采 ${cfgRes.data?.schedule?.todayCount ?? '?'} 条`),
          h(Btn, { sm: true, primary: true, disabled: running, onClick: runRound }, running ? '跑一轮中…' : '立即跑一轮'),
          sub === 'video' ? h(Btn, { sm: true, onClick: () => { cfgRes.reload(); store.reload() } }, '刷新') : null),
        runMsg ? h(Note, {}, runMsg) : null,
        h('div', { 'data-wb-row': '' },
          ...[['video', '视频'], ['msg', '消息'], ['set', '刷B站设置']].map(([k, l]) =>
            h('button', { key: k, 'data-wb-btn': '', 'data-sm': '', 'data-primary': sub === k ? '' : undefined, onClick: () => setSub(k) }, l)),
          sub === 'video' && basket.length ? h(Chip, {}, `创作篮 ${basket.length}`) : null),
        sub === 'video' ? h(SubVideo, { storeMap, cfg: cfgRes.data?.config, onCommented: store.reload, onKeywordsChanged: cfgRes.reload }) : null,
        sub === 'msg' ? h(SubInbox, { onCommented: store.reload, cfg: cfgRes.data?.config }) : null,
        sub === 'set' ? h(SubSettings, { onRunRound: () => store.reload(), onSaved: cfgRes.reload }) : null)
    }

    /* ═══════════════════ ③ 创作 / 出片 ═══════════════════ */
    function ProjectCard({ p, basket, onChange }) {
      const [inst, setInst] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [showShots, setShowShots] = useState(false)
      const [viewV, setViewV] = useState(0)
      const [viewPlan, setViewPlan] = useState(null)
      const [preview, setPreview] = useState('')
      const [logOpen, setLogOpen] = useState(false)
      const plan = viewV ? (viewPlan || p.plan) : p.plan
      const job = p.job
      const stage = job?.stage === 'running' ? 'rendering' : p.stage
      const [label, tone] = stageOf(stage)
      const pct = job?.stage === 'running' ? (job.pct || 0) : (['rendered', 'approved', 'published'].includes(p.stage) ? 100 : 0)
      const runId = baseName(p.runDir)
      const shots = plan?.shots || []
      const picks = plan?.picks || []
      const currentPlan = p.plan
      const versions = p.versions || []
      const curV = p.currentVersion || 1

      const showVersion = async (v) => {
        if (!v || v === curV) { setViewV(0); setViewPlan(null); return }
        setViewV(v); setBusy('v')
        const r = await jget(`/create/plan?id=${encodeURIComponent(p.id)}&v=${v}`)
        if (r.ok) setViewPlan(r.plan)
        setBusy('')
      }
      const revise = async () => {
        if (!inst.trim()) return
        setBusy('revise'); setMsg('改版中…（模型重写方案，20–60 秒）')
        const r = await jpost('/create/revise', { id: p.id, instruction: inst })
        setBusy('')
        setMsg(r.ok ? `已生成 v${r.project.currentVersion}：${r.plan.changed || ''}` : ('失败：' + (errText(r) || '')))
        if (r.ok) { setInst(''); setViewV(0); setViewPlan(null); onChange?.() }
      }
      const render = async () => {
        setBusy('render'); setMsg('开始渲染…')
        const r = await jpost('/render/start', { id: p.id, version: viewV || curV })
        setBusy('')
        setMsg(r.ok ? '已在后台渲染（配音 → 渲染 → 合音轨 → 烧字幕 → 封面）' : ('失败：' + (errText(r) || '')))
        if (r.ok) { setLogOpen(true); onChange?.() }
      }
      const promptGo = async () => {
        setBusy('prompt')
        const r = await jget(`/create/prompt?id=${encodeURIComponent(p.id)}&v=${viewV || curV}`)
        setBusy('')
        if (!r.ok) return setMsg('取提示词失败：' + (errText(r) || ''))
        const ok = await copyText(r.prompt)
        setMsg(ok ? '提示词已复制 —— 粘到 dsh 对话里继续聊' : '复制失败，可以展开手动复制')
      }
      const togglePreview = () => {
        if (!runId) return
        setPreview(preview ? '' : `/api/bili-wb/review/media?runId=${encodeURIComponent(runId)}&kind=video`)
      }

      return h('div', { 'data-wb-sec': '', 'data-wb-project': p.id },
        h('div', { 'data-wb-row': '' },
          h('div', { 'data-wb-projtitle': '', style: { flex: '1 1 240px' } }, plan?.title || p.title || '未命名'),
          h('span', { 'data-wb-badge': '', 'data-tone': tone }, label),
          h('div', { 'data-wb-grow': '' }),
          h(Chip, { sel: true }, `v${viewV || curV}（${viewV ? '查看' : '当前'}）`),
          versions.length > 1 ? versions.filter((x) => x.v !== (viewV || curV)).slice(-3).map((x) =>
            h('span', { key: x.v, 'data-wb-chip': '', style: { cursor: 'pointer' }, onClick: () => showVersion(x.v) }, `v${x.v}`)) : null),
        h('div', { 'data-wb-meta': '' },
          [plan?.stats?.estSeconds ? `${plan.stats.estSeconds} 秒` : '', p.renderVoice ? `音色 ${voiceLabel(p.renderVoice)}` : '', `${shots.length} 镜`, `引用素材 ${picks.length} 处`].filter(Boolean).join(' · ')),
        h('div', { 'data-wb-bar': '' }, h('i', { style: { width: pct + '%' } })),
        h('div', { 'data-wb-meta': '' }, job?.stage === 'running'
          ? `渲染中 ${job.pct || 0}% · ${baseName(job.runDir)}${job.frameCount ? ` · 真实帧 ${job.frameCount}` : ''}`
          : pct === 100 ? '渲染完成，等你在「审核/发布」点通过' : '还没渲染'),
        h('div', { 'data-wb-shots': '' }, ...shots.map((s, i) => h('span', { key: i, 'data-wb-shot': '' },
          h('b', {}, s.kind), ' ', s.headline || String(s.narration || '').slice(0, 12)))),
        h('div', { 'data-wb-row': '', style: { borderTop: '1px solid var(--wb-line)', paddingTop: '10px' } },
          h('span', { 'data-wb-note': '' }, (p.versions || []).filter((x) => x.v === curV)[0]?.changed || '初版'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, disabled: busy === 'prompt', onClick: promptGo }, '在对话里接着聊'),
          h(Btn, { sm: true, disabled: busy === 'v', onClick: () => showVersion(curV) }, '回到当前版')),
        h('div', { 'data-wb-row': '' },
          h('input', { 'data-wb-search': '', style: { flex: '1 1 200px', width: 'auto' }, placeholder: '接着改：第 5 条换个素材 / 标题再短点 / 别太标题党', value: inst, onChange: (e) => setInst(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') revise() } }),
          h(Btn, { sm: true, primary: true, disabled: busy === 'revise' || !inst.trim(), onClick: revise }, busy === 'revise' ? '改版中…' : '改一版')),
        h('div', { 'data-wb-row': '' },
          h(Btn, { sm: true, onClick: () => setShowShots(!showShots) }, showShots ? '收起分镜' : '看分镜'),
          h(Btn, { sm: true, disabled: busy === 'render' || job?.stage === 'running', onClick: render }, job?.stage === 'running' ? '渲染中…' : (pct === 100 ? '重新渲染' : '开始渲染')),
          h(Btn, { sm: true, disabled: !pct || !runId, onClick: togglePreview }, '预览成片'),
          h('div', { 'data-wb-grow': '' }),
          h('span', { 'data-wb-meta': '' }, `引用素材 ${picks.length} 处${basket.length ? ` · 创作篮 ${basket.length}` : ''}`)),
        showShots ? h('div', { 'data-wb-col': '' }, ...shots.map((s, i) => h('div', { key: i, 'data-wb-quote': '' },
          h('b', {}, `${i + 1}. ${s.kind}`), ' ', s.headline || '', s.body ? ` — ${s.body}` : '',
          h('div', { 'data-wb-meta': '', style: { marginTop: '3px' } },
            [s.narration, s.source ? `引用 ${s.source.bv} @${mmss(s.source.t)}` : ''].filter(Boolean).join(' · '))))) : null,
        msg ? h(Note, {}, msg) : null,
        job?.log ? h('div', { 'data-wb-col': '' },
          h('div', { 'data-wb-row': '' },
            h(Btn, { sm: true, onClick: () => setLogOpen(!logOpen) }, logOpen ? '收起渲染日志' : '看渲染日志'),
            job.error ? h('span', { 'data-wb-note': '', style: { color: '#f87171' } }, job.error.slice(0, 160)) : null),
          logOpen ? h('pre', { 'data-wb-pre': '' }, job.log.slice(-2600)) : null) : null,
        preview ? h('div', { 'data-wb-overlay': '' },
          h('button', { className: 'x', onClick: () => setPreview('') }, '✕'),
          h('video', { src: preview, controls: true, autoPlay: true })) : null)
    }

    /* ── 长任务卡：素材不够就自己去 B站 找，够了再写方案 ── */
    const TASK_STATUS = {
      queued: ['排队中', ''],
      checking: ['检查素材库', ''],
      collecting: ['逛 B站 中', 'warn'],
      short: ['素材不足，继续找', 'warn'],
      planning: ['写方案中', ''],
      ready: ['方案已生成', 'ok'],
      failed: ['已停止', 'warn'],
      paused: ['已暂停', ''],
    }
    function TaskCard({ t, onChange }) {
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [label, tone] = TASK_STATUS[t.status] || ['处理中', '']
      const last = (t.log || []).slice(-1)[0]
      const left = t.deadline ? Math.max(0, Math.ceil((Date.parse(t.deadline) - Date.now()) / 86400_000)) : 0
      const live = ['queued', 'checking', 'collecting', 'planning'].includes(t.status)
      const act = async (action) => {
        setBusy(action); setMsg('')
        const r = await jpost('/task/' + action, { id: t.id })
        setBusy('')
        if (!r.ok) setMsg(errText(r) || '操作失败')
        onChange?.()
      }
      const viewPlan = () => {
        const el = document.querySelector(`[data-wb-project="${t.projectId}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        else setMsg('方案就在下面，往下翻一下')
      }
      const time = (iso) => {
        try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
      }
      return h('div', { 'data-wb-sec': '' },
        h('div', { 'data-wb-row': '' },
          h(Chip, {}, '任务'),
          h(Chip, { ok: tone === 'ok', warn: tone === 'warn' }, label),
          h('b', {}, t.topic || t.brief || '未命名任务'),
          h('div', { 'data-wb-grow': '' }),
          t.status === 'ready' && t.projectId ? h(Btn, { sm: true, primary: true, onClick: viewPlan }, '查看方案') : null,
          live ? h(Btn, { sm: true, disabled: busy === 'pause', onClick: () => act('pause') }, '暂停') : null,
          t.status === 'paused' ? h(Btn, { sm: true, disabled: busy === 'resume', onClick: () => act('resume') }, '继续') : null,
          (t.status === 'short' || t.status === 'failed' || t.status === 'queued') ? h(Btn, {
            sm: true, primary: t.status !== 'queued', disabled: Boolean(busy), onClick: () => act('retry'),
          }, busy === 'retry' ? '启动中…' : '现在再找一轮') : null,
          h(Btn, { sm: true, disabled: Boolean(busy), onClick: () => act('delete') }, '删除')),
        h('div', { 'data-wb-meta': '' }, String(t.brief || '')),
        h('div', { 'data-wb-meta': '' },
          [
            `素材 ${t.matched ?? 0}/${t.needed ?? 3}`,
            t.attempts ? `第 ${t.attempts} 轮` : '',
            t.deadline ? `剩 ${left} 天` : '',
            t.planTitle ? `方案：${t.planTitle}` : '',
            t.lastError ? t.lastError : '',
          ].filter(Boolean).join(' · ')),
        h('div', { 'data-wb-meta': '' },
          last ? `最近：${String(last.text || '')}${last.at ? `（${time(last.at)}）` : ''}` : '还没开始'),
        t.status === 'collecting' ? h(Note, {}, '正在 B站 搜索并采集，几分钟后回来看；找不到就过几小时再找。') : null,
        t.status === 'planning' ? h(Note, {}, '素材够了，正在写分镜方案，一般 20–60 秒。') : null,
        msg ? h(Note, {}, msg) : null)
    }

    function TabCreate({ basket, setBasket }) {
      const [brief, setBrief] = useState('')
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')
      const list = useApi('/create/plans')
      const taskList = useApi('/task/list')
      const projects = list.data?.projects || []
      const taskRows = taskList.data?.tasks || []
      const activeTasks = taskRows.filter((t) => !['ready', 'failed'].includes(t.status)).length
      const anyRunning = projects.some((p) => p.job?.stage === 'running')
      usePoll(list.reload, 4000, true)
      usePoll(taskList.reload, 4000, true)

      const go = async () => {
        if (!brief.trim()) return
        setBusy('go'); setLog('已创建任务：先查素材库，不够就自己去 B站 找（进度看下面）')
        const r = await jpost('/task/create', { brief })
        setBusy('')
        if (r.ok) {
          setLog(`任务已创建${r.task?.topic ? `：${r.task.topic}` : ''}。素材不够会按关键词去「刷B站」找，够了自动写方案。`)
          setBrief(''); taskList.reload(); list.reload()
        } else setLog('失败：' + (errText(r) || ''))
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '创作 / 出片', sub: '一句需求 → 长任务：先查库，素材不够会自己去刷B站；够料再出方案' }),
        h(Sec, {},
          h('div', { 'data-wb-projtitle': '' }, '想做什么样的片子？'),
          h('input', {
            'data-wb-search': '', placeholder: '比如：做一期 iPhone 折叠屏耐用性的实测盘点，轻松点，90 秒以内',
            value: brief, onChange: (e) => setBrief(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go() },
          }),
          h('div', { 'data-wb-row': '' },
            h(Btn, { primary: true, disabled: busy === 'go' || !brief.trim(), onClick: go }, busy === 'go' ? '创建任务中…' : '让 AI 开始'),
            h('span', { 'data-wb-note': '' }, '库里有料就直接写方案；不够就自己去刷B站，可以等几天（Ctrl+Enter 发送）'),
            basket.length ? h('span', { 'data-wb-note': '' }, `创作篮里还有 ${basket.length} 条，可以在下面手动指认`) : null),
          log ? h('pre', { 'data-wb-pre': '' }, log) : null),
        taskRows.length ? h(Sec, { title: `任务${activeTasks ? `（${activeTasks} 个进行中）` : ''}` },
          h(Note, {}, '素材不够时按关键词自己去「刷B站」找；够料后自动写方案。不会自动渲染、不会自动投稿。'),
          h('div', { 'data-wb-col': '' }, ...taskRows.map((t) => h(TaskCard, {
            key: t.id, t, onChange: () => { taskList.reload(); list.reload() },
          })))) : null,
        h('div', { 'data-wb-row': '' },
          h(Note, {}, `共 ${projects.length} 个方案${anyRunning ? ' · 有项目在渲染' : ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: list.reload }, '刷新')),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读方案…') : null,
        !list.loading && !projects.length ? h(Note, {}, '还没有方案 —— 上面写一句需求，让 AI 开始') : null,
        h('div', { 'data-wb-col': '' }, ...projects.map((p) => h(ProjectCard, {
          key: p.id, p, basket, onChange: list.reload,
        }))),
        h(Sec, { title: '创作篮（手动指定素材，可选）' },
          basket.length
            ? h('div', { 'data-wb-row': '' },
              ...basket.map((bv) => h(Chip, { key: bv }, bv)),
              h(Btn, { sm: true, onClick: () => setBasket([]) }, '清空'))
            : h(Note, {}, '没选料也行 —— 上面那句需求足够它自己去库里找。'),
          h(Note, {}, '出片设置（音色 / 时长 / 是否用真实帧）在「刷B站 → 设置」和每张卡片的「开始渲染」里调。')))
    }

    /* ═══════════════════ ④ 审核 / 发布 ═══════════════════ */
    function TabReview() {
      const list = useApi('/review/list')
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [preview, setPreview] = useState('')
      const runs = list.data?.runs || []
      const publishEnabled = Boolean(list.data?.publishEnabled)
      usePoll(list.reload, 5000, true)

      const decide = async (runId, state) => {
        setBusy(runId + state)
        const r = await jpost('/review/decision', { runId, state })
        setBusy('')
        setDump(r.ok ? `已${state === 'approved' ? '通过' : '打回'}：${runId}` : ('失败：' + (errText(r) || '')))
        list.reload()
      }
      const upload = async (run, dryRun) => {
        if (!dryRun && !window.confirm('真要投稿到 B站？这会公开发布。')) return
        setBusy(run.runId + (dryRun ? 'dry' : 'real'))
        const r = await jpost('/review/upload', { runId: run.runId, dryRun, confirm: !dryRun })
        setBusy('')
        setDump(r.ok
          ? `${dryRun ? '投稿 dry-run（没有真的发）' : '已投稿'}${r.data?.bvid ? ` · BV ${r.data.bvid}` : ''}\n$ ${(r.command || []).join(' ')}\n${JSON.stringify(r.data || {}, null, 2).slice(0, 2000)}`
          : ('失败：' + (errText(r) || '')))
        list.reload()
      }
      const showStats = async (run) => {
        setBusy(run.runId + 'stats')
        const r = await jget('/review/stats?runId=' + encodeURIComponent(run.runId))
        setBusy('')
        setDump(r.ok ? JSON.stringify(r.data || {}, null, 2).slice(0, 3000) : ('失败：' + (errText(r) || '')))
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '审核 / 发布', sub: '成片必须你点通过才会发布；投稿前先 dry-run 看全文' },
          h('span', { 'data-wb-chip': '', 'data-ok': publishEnabled ? '' : undefined }, publishEnabled ? '真投稿已允许' : '真投稿未开启'),
          h(Btn, { sm: true, onClick: list.reload }, '刷新')),
        h(Err, {}, list.err),
        dump ? h('pre', { 'data-wb-pre': '' }, dump) : null,
        list.loading ? h('div', { 'data-wb-loading': '' }, '读成片…') : null,
        !list.loading && !runs.length ? h(Note, {}, '还没有成片 —— 去「创作/出片」渲染一期') : null,
        h('div', { 'data-wb-grid': '' }, ...runs.map((r) => {
          const [label, tone] = stageOf(r.stage)
          const published = r.stage === 'published' || r.review?.state === 'published'
          return h('div', { key: r.runId, 'data-wb-card': '' },
            h('div', { 'data-wb-cover': '' },
              h('span', {}, published ? '已发布成片' : r.stage === 'rendered' ? '待审成片' : r.title || r.runId),
              r.hasCover ? h('img', { src: `/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=cover`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }) : null,
              h('span', { 'data-wb-badge': '', 'data-tone': tone, style: { position: 'absolute', left: '8px', top: '8px', zIndex: 2 } }, label),
              h('span', { 'data-wb-dur': '' }, r.seconds ? `${Math.round(r.seconds)}s` : '')),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-cardtitle': '' }, r.title || r.runId),
              h('div', { 'data-wb-meta': '' }, [r.projectVersion ? `v${r.projectVersion}` : '', r.shots ? `${r.shots} 镜` : '', r.realFrames ? `真实帧 ${r.realFrames}` : '', r.builtAt ? dayOf(r.builtAt) : ''].filter(Boolean).join(' · ')),
              h('div', { 'data-wb-row': '' },
                published
                  ? h(Btn, { sm: true, primary: true, disabled: busy === r.runId + 'stats', onClick: () => showStats(r) }, '看数据')
                  : h(Btn, { sm: true, primary: true, disabled: busy === r.runId + 'approved', onClick: () => decide(r.runId, 'approved') }, '通过'),
                published ? null : h(Btn, { sm: true, disabled: busy === r.runId + 'rejected', onClick: () => decide(r.runId, 'rejected') }, '打回重做'),
                h('div', { 'data-wb-grow': '' }),
                h(Btn, { sm: true, disabled: !r.hasVideo, onClick: () => setPreview(`/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=video`) }, '预览')),
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, disabled: busy === r.runId + 'dry' || !r.hasVideo, onClick: () => upload(r, true) }, '投稿 dry-run'),
                r.stage === 'approved'
                  ? h(Btn, { sm: true, disabled: !publishEnabled || busy === r.runId + 'real', onClick: () => upload(r, false) }, '真投稿')
                  : null,
                h('div', { 'data-wb-grow': '' }),
                r.review?.state ? h('span', { 'data-wb-meta': '' }, `审核：${r.review.state}`) : null)))
        })),
        preview ? h('div', { 'data-wb-overlay': '' },
          h('button', { className: 'x', onClick: () => setPreview('') }, '✕'),
          h('video', { src: preview, controls: true, autoPlay: true })) : null)
    }

    /* ═══════════════════ ⑤ 我的 ═══════════════════ */
    function TabMine() {
      const [auth, setAuth] = useState(null)
      const [qr, setQr] = useState(false)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [log, setLog] = useState('')
      const [health, setHealth] = useState('')
      const cfgRes = useApi('/config')
      const stats = useApi('/stats')
      const cfg = cfgRes.data?.config
      const [draft, setDraft] = useState(null)

      const refreshAuth = async () => {
        const r = await jget('/status')
        if (r.ok) setAuth(r)
      }
      useEffect(() => { refreshAuth() }, [])
      useEffect(() => {
        if (cfg && draft === null) setDraft({ publishEnabled: cfg.publishEnabled, tagsText: (cfg.defaultTags || []).join(','), defaultZone: cfg.defaultZone })
      }, [cfg, draft])
      usePoll(async () => {
        const r = await jget('/status')
        if (r.ok) { setAuth(r); if (r.loggedIn) setQr(false) }
      }, 2500, qr)

      const login = async () => {
        setBusy('login'); setMsg('生成二维码…')
        const r = await jpost('/login/start')
        setBusy('')
        if (r.ok) { setQr(true); setMsg('手机 B站 扫码，确认时选「记住我 / 长期」') }
        else setMsg('生成二维码失败：' + (errText(r) || ''))
      }
      const logout = async () => {
        setBusy('logout')
        await jpost('/logout')
        setBusy(''); setQr(false); refreshAuth()
      }
      const showLog = async () => {
        setBusy('log')
        const r = await jget('/duty-log')
        setBusy(''); setLog(r.ok ? (r.text || '（空）') : ('读取失败：' + (errText(r) || '')))
      }
      const checkModel = async () => {
        setBusy('model')
        const r = await jget('/model/health')
        setBusy('')
        setHealth(JSON.stringify(r.data || { error: r.error }, null, 2))
      }
      const savePublish = async () => {
        if (!draft) return
        setBusy('save')
        const r = await jpost('/config', {
          publishEnabled: draft.publishEnabled,
          defaultTags: String(draft.tagsText || '').split(',').map((s) => s.trim()).filter(Boolean),
          defaultZone: draft.defaultZone,
        })
        setBusy('')
        setMsg(r.ok ? '发布设置已保存' : ('保存失败：' + (errText(r) || '')))
        cfgRes.reload()
      }
      const d = stats.data?.data
      const n = (o, k) => (o && Number.isFinite(Number(o[k])) ? Number(o[k]) : 0)
      const store = cfgRes.data?.store || {}
      const [storePath, setStorePath] = useState('')
      useEffect(() => { if (store.path) setStorePath(store.path) }, [store.path])
      const relocate = async () => {
        const p = String(storePath || '').trim()
        if (!p) { setMsg('先填一个素材库目录'); return }
        setBusy('store'); setMsg('切换素材库位置中…')
        const r = await jpost('/store/relocate', { path: p, copy: true })
        setBusy('')
        if (r.ok) {
          setMsg(`已切换 · ${r.path} · ${r.store?.videos ?? 0} 条${r.copied ? '（已复制现有素材）' : ''}`)
          setStorePath(r.path || p)
          cfgRes.reload(); stats.reload()
        } else setMsg('切换失败：' + (errText(r) || ''))
      }

      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '我的', sub: '登录、用户信息、账号数据、全局设置' },
          auth?.loggedIn ? null : h(Btn, { primary: true, sm: true, disabled: busy === 'login', onClick: login }, busy === 'login' ? '生成二维码…' : '扫码登录')),

        !auth?.loggedIn
          ? h('div', { 'data-wb-login': '' },
            h('div', { 'data-wb-qr': '' }, qr ? h('img', { src: API + '/qr.png?t=' + Date.now(), alt: '二维码' }) : h('div', { className: 'ph' })),
            h('div', { 'data-wb-col': '', style: { flex: 1 } },
              h('div', { 'data-wb-projtitle': '' }, '扫码登录 bili-cli'),
              h(Note, {}, '手机 B站 App 扫码，确认时选「记住我 / 长期」。登录成功后这里会变成：昵称 · UID · LV · 登出按钮。'),
              h('div', { 'data-wb-row': '' },
                h(Chip, { warn: true }, '未登录'),
                h(Btn, { sm: true, onClick: qr ? () => setQr(false) : login }, qr ? '刷新二维码' : '生成二维码'),
                msg ? h('span', { 'data-wb-note': '' }, msg) : null),
              h(Note, {}, '⚠️ 工作台统一用这一份登录；别再装老「刷B站」插件，会有两套账。')))
          : h(Sec, {},
            h('div', { 'data-wb-row': '' },
              h(Chip, { ok: true }, `已登录 · ${auth.user?.name || auth.user?.mid || ''} · LV${auth.user?.level ?? '?'}`),
              h(Chip, {}, `UID ${auth.user?.mid ?? '-'}`),
              h('div', { 'data-wb-grow': '' }),
              h(Btn, { sm: true, onClick: refreshAuth }, '刷新'),
              h(Btn, { sm: true, disabled: busy === 'logout', onClick: logout }, '登出'))),

        d ? h('div', { 'data-wb-grid': '', style: { gridTemplateColumns: 'repeat(2,minmax(0,1fr))' } },
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.plays, 'now'))), h('span', {}, `播放 · 上期 ${fmtNum(n(d.plays, 'previous'))}`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.visitors, 'now'))), h('span', {}, '访客')),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `+${fmtNum(n(d.new_fans, 'now'))}`), h('span', {}, `涨粉 · 总粉丝 ${fmtNum(d.fans?.total)}`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `${d.beats_similar_ups_percent?.play ?? '-'}%`), h('span', {}, '播放超过同类 UP'))) : null,

        h('div', { 'data-wb-split': '' },
          h(Sec, { title: '素材库与运行' },
            h('div', { 'data-wb-kv': '' },
              `库路径：${store.path || '—'}`,
              h('br'),
              `库内：${store.videos ?? '-'} 条 · ${store.mb ?? '-'} MB · ${store.files ?? '-'} 个文件`,
              h('br'),
              `定时：${cfg?.enabled ? '开' : '关'}（${cfg?.scheduleRanges || '00:00-24:00'} · 每天上限 ${cfg?.perDay || 48} · 约每 ${cfgRes.data?.schedule?.estMinutes || '?'} 分钟 1 条）`,
              h('br'),
              `模型链：${(cfg?.modelChain || []).length} 个，当前 ${(cfg?.modelChain || [])[0] || '-'}`),
            h(Field, { label: '素材库位置' },
              h('input', {
                'data-wb-input': '', style: { maxWidth: '430px' }, value: storePath,
                placeholder: '~/.dsh-bili-workbench/store',
                onChange: (e) => setStorePath(e.target.value),
              }),
              h(Btn, { sm: true, disabled: busy === 'store', onClick: relocate }, busy === 'store' ? '切换中…' : '保存并切换'),
              h(Note, {}, '默认 ~/.dsh-bili-workbench/store；新目录为空时会复制现有素材，已有数据则直接切换')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, disabled: busy === 'log', onClick: showLog }, '看运行日志'),
              h(Btn, { sm: true, onClick: () => jpost('/open-folder', { what: 'store' }) }, '打开库目录'),
              h(Btn, { sm: true, onClick: () => jpost('/open-folder', { what: 'runs' }) }, '打开成片目录'),
              h(Btn, { sm: true, disabled: busy === 'model', onClick: checkModel }, '测模型')),
            health ? h('pre', { 'data-wb-pre': '' }, health) : null,
            log ? h('pre', { 'data-wb-pre': '' }, log) : null),

          h(Sec, { title: '发布权限（真投稿）' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft?.publishEnabled), onChange: (e) => setDraft({ ...draft, publishEnabled: e.target.checked }) }),
              h('span', {}, '允许真投稿（默认关）')),
            h(Note, {}, '关着的时候，「审核/发布」只能 dry-run；打开后仍会二次确认。'),
            h(Field, { label: '默认标签' },
              h('input', { 'data-wb-input': '', value: draft?.tagsText || '', onChange: (e) => setDraft({ ...draft, tagsText: e.target.value }), placeholder: 'AI,资讯,盘点' })),
            h(Field, { label: '默认分区 ID' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', value: draft?.defaultZone ?? 0, onChange: (e) => setDraft({ ...draft, defaultZone: e.target.value }) }),
              h(Note, {}, '0 = 让 bili 自动预测')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, primary: true, disabled: busy === 'save', onClick: savePublish }, '保存发布设置'),
              msg ? h('span', { 'data-wb-note': '' }, msg) : null)),

          h(Sec, { title: '模型链' },
            h('div', { 'data-wb-kv': '' }, (cfg?.modelChain || []).map((m, i) => h('div', { key: i }, `${i + 1}. ${m}`))),
            h(Note, {}, '在「刷B站 → 设置 → 模型链」里改。失败自动换下一个。'))),
        h(Err, {}, cfgRes.err))
    }

    /* ═══════════════════ 外壳 ═══════════════════ */
    const NAV = [
      ['store', '📚', '素材库'],
      ['scroll', '🎬', '刷B站'],
      ['create', '✍️', '创作/出片'],
      ['review', '✅', '审核/发布'],
      ['mine', '👤', '我的'],
    ]

    function Shell() {
      const [tab, setTab] = useState('store')
      const [collapsed, setCollapsed] = useState(false)
      const [basket, setBasket] = useState([])
      return h('div', { 'data-wb-root': '', 'data-collapsed': collapsed ? '' : undefined },
        h('aside', { 'data-wb-rail': '' },
          h('div', { 'data-wb-brand': '' }, 'B站工作台', h('small', {}, '素材 → 出片 → 发布')),
          h('nav', { style: { display: 'flex', flexDirection: 'column' } },
            ...NAV.map(([k, ico, label]) => h('button', {
              key: k, 'data-wb-nav': '', 'aria-selected': tab === k ? 'true' : 'false',
              onClick: () => setTab(k),
            },
            h('span', { className: 'ico' }, ico),
            h('span', { 'data-wb-label': '' }, label),
            k === 'create' && basket.length ? h('span', { className: 'badge' }, String(basket.length)) : null))),
          h('div', { 'data-wb-rail-foot': '' },
            h('button', { 'data-wb-ghost': '', onClick: () => setCollapsed(!collapsed) }, collapsed ? '»' : '« 收起'))),
        h('main', { 'data-wb-main': '' },
          tab === 'store' ? h(TabStore, { basket, setBasket }) : null,
          tab === 'scroll' ? h(TabScroll, { basket }) : null,
          tab === 'create' ? h(TabCreate, { basket, setBasket }) : null,
          tab === 'review' ? h(TabReview) : null,
          tab === 'mine' ? h(TabMine) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-workbench')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-workbench: 样式')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          slots.inject('conversation.view', () => slots.register({
            name: 'conversation.view', id: 'bili-wb', order: 30, label: 'B站工作台', scope: 'session',
          }, () => h(Shell)))
        } catch (e) { /* 没有这个槽位就算了 */ }
      },
    }
  },
})
