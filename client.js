/**
 * dsh-bili-workbench —— 浏览器半端
 * ============================================================================
 * 界面以 workbench-mockup/index.html 为准：
 *   · 左侧 196px 竖排导航（可折叠）+ 右侧内容区，每页自己的标题/副标题
 *   · 登录/二维码只在「我的」
 *   · 五个模块：素材库 / 刷 B 站 / 创作出片 / 审核发布 / 我的
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
      'zh-CN-YunyangNeural': '云扬（男·新闻）',
      'zh-CN-YunjianNeural': '云健（男·体育）',
      'zh-TW-HsiaoChenNeural': '曉臻（女·台湾）',
      'zh-TW-HsiaoYuNeural': '曉雨（女·台湾）',
      'zh-TW-YunJheNeural': '雲哲（男·台湾）',
    }
    const voiceLabel = (v) => VOICES[v] || v || ''

    function useApi(path, { auto = true } = {}) {
      const [st, setSt] = useState({ loading: Boolean(auto), data: null, err: '' })
      const [tick, setTick] = useState(0)
      const pathRef = useRef(path)
      pathRef.current = path
      useEffect(() => {
        if (!path || !auto) {
          // 清空：否则“收起”后旧数据还在，卡片/详情看起来关不掉
          setSt({ loading: false, data: null, err: '' })
          return
        }
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
        let timer = null
        const tick = () => { if (!document.hidden) ref.current() }
        const start = () => {
          if (timer) return
          timer = setInterval(tick, ms)
        }
        const stop = () => {
          if (timer) { clearInterval(timer); timer = null }
        }
        const onVisible = () => {
          if (document.hidden) stop()
          else { tick(); start() }
        }
        start()
        document.addEventListener('visibilitychange', onVisible)
        return () => { stop(); document.removeEventListener('visibilitychange', onVisible) }
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
  --wb-bg:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 97%,var(--dsw-alias-label-primary,#0f1115));
  --wb-card:var(--dsw-alias-bg-layer-1,#fff);
  --wb-card2:var(--dsw-alias-interactive-bg-hover,rgba(15,17,21,.05));
  --wb-line:var(--dsw-alias-border-l1,rgba(0,0,0,.06));
  --wb-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --wb-tx:var(--dsw-alias-label-primary,#0f1115);
  --wb-dim:#4a5563;
  --wb-dim2:#5f6b7a;
  --wb-acc:#fb7299;
  --wb-acc-tx:#c7365f;
  --wb-acc-soft:#fff0f4;
  --wb-ok:#0f7a4f;
  --wb-ok-soft:#e8f6ef;
  --wb-warn:#a9620a;
  --wb-warn-soft:#fff5e6;
  --wb-bad:#c0332a;
  --wb-bad-soft:#fdecea;
  --wb-blue:#2563eb;
  --wb-blue-soft:#edf3ff;
  --wb-shadow:0 1px 2px rgba(20,23,28,.04),0 1px 3px rgba(20,23,28,.03);
  --wb-radius:14px;
  display:flex;height:100%;min-height:0;position:relative;overflow:hidden;
  background:var(--wb-bg);color:var(--wb-tx);
  font:14px/1.55 "Inter","PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;
}
body[data-ds-dark-theme] [data-wb-root]{color-scheme:dark}
body[data-ds-dark-theme] [data-wb-root]{
  --wb-dim:#cfd3d6;
  --wb-dim2:#adb2b8;
  --wb-acc-tx:#ff8db0;
  --wb-acc-soft:rgba(251,114,153,.16);
  --wb-ok:#4ade80;
  --wb-ok-soft:rgba(34,197,94,.14);
  --wb-warn:#fbbf24;
  --wb-warn-soft:rgba(245,158,11,.14);
  --wb-bad:#f87171;
  --wb-bad-soft:rgba(239,68,68,.14);
  --wb-blue:#7aa7ff;
  --wb-blue-soft:rgba(59,130,246,.16);
}
body[data-ds-dark-theme] [data-wb-btn][data-primary]{color:#151517;}
[data-wb-root] *{box-sizing:border-box}

/* ---------- 左栏 ---------- */
[data-wb-rail]{width:216px;flex:none;background:var(--wb-card);border-right:1px solid var(--wb-line);
  display:flex;flex-direction:column;padding:18px 14px 14px;gap:2px;min-height:0;transition:width .16s ease;}
[data-wb-brand]{font-size:14px;font-weight:750;padding:2px 8px 18px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;}
[data-wb-brand] small{display:block;font-size:11px;font-weight:500;color:var(--wb-dim2);margin-top:3px;}
[data-wb-nav]{display:flex;align-items:center;gap:10px;width:100%;height:42px;padding:0 11px;margin:0;
  border:0;border-radius:10px;background:transparent;color:var(--wb-dim);font:inherit;font-size:13.5px;
  font-weight:600;text-align:left;cursor:pointer;position:relative;white-space:nowrap;transition:background .15s,color .15s;}
[data-wb-nav]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-nav][aria-selected="true"]{background:var(--wb-acc-soft);color:var(--wb-acc-tx);font-weight:700;}
[data-wb-nav][aria-selected="true"]::before{content:"";position:absolute;left:-14px;top:11px;bottom:11px;width:3px;border-radius:0 3px 3px 0;background:var(--wb-acc);}
[data-wb-nav] .ico{width:18px;height:18px;flex:none;display:grid;place-items:center;font-size:0;}
[data-wb-nav] .ico svg{width:18px;height:18px;}
[data-wb-nav] [data-wb-label]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-wb-nav] .badge{margin-left:auto;font-size:10px;padding:0 6px;border-radius:999px;background:var(--wb-acc);color:#151517;}
[data-wb-rail-foot]{margin-top:auto;padding:12px 4px 0;border-top:1px solid var(--wb-line);}
[data-wb-ghost]{display:inline-flex;align-items:center;justify-content:center;gap:5px;width:100%;height:32px;padding:0 10px;
  border-radius:9px;border:1px solid var(--wb-line);background:transparent;color:var(--wb-dim);font:inherit;font-size:12px;cursor:pointer;}
[data-wb-ghost]:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-root][data-collapsed] [data-wb-rail]{width:62px;padding:16px 6px;}
[data-wb-root][data-collapsed] [data-wb-label],
[data-wb-root][data-collapsed] [data-wb-brand] small{display:none;}
[data-wb-root][data-collapsed] [data-wb-brand]{font-size:0;padding:4px 0 14px;text-align:center;}
[data-wb-root][data-collapsed] [data-wb-brand]::after{content:"WB";font-size:13px;}
[data-wb-root][data-collapsed] [data-wb-nav]{justify-content:center;padding:10px 0;}

/* ---------- 主区与页头 ---------- */
[data-wb-main]{flex:1;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:20px 24px 44px;scroll-behavior:smooth;scrollbar-gutter:stable;}
[data-wb-page]{display:flex;flex-direction:column;gap:16px;max-width:1180px;min-width:0;}
[data-wb-head]{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin:0;}
[data-wb-title]{font-size:22px;line-height:1.25;font-weight:750;letter-spacing:-.015em;}
[data-wb-sub]{font-size:12.5px;color:var(--wb-dim2);margin-top:4px;}
[data-wb-grow]{flex:1;min-width:0;}
[data-wb-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
[data-wb-col]{display:flex;flex-direction:column;gap:10px;min-width:0;}

/* 关键修复：负 margin 抵消 main 的 20px 上内边距，sticky 贴到滚动区最顶 */
[data-wb-sticky-header]{position:sticky;top:-20px;z-index:30;background:var(--wb-card);
  margin:-20px -24px 0;padding:20px 24px 10px;border-bottom:1px solid var(--wb-line);
  box-shadow:0 2px 8px rgba(20,23,28,.06);}
[data-wb-sticky-header][data-wb-static]{position:static;margin:0;padding:0 0 12px;border-bottom:0;box-shadow:none;background:transparent;}
[data-wb-subtabs]{flex-wrap:wrap;}
[data-wb-sticky-header] > [data-wb-subtabs]{margin-top:8px;}
[data-wb-keyword-bar]{padding:10px 12px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card);gap:6px;}
[data-wb-keyword-bar] [data-wb-note]{margin-right:2px;}
[data-wb-save-row]{padding:12px 2px 0;border-top:1px solid var(--wb-line);margin-top:2px;}

/* ---------- 按钮 / 标签 ---------- */
[data-wb-btn]{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;
  border-radius:10px;border:1px solid var(--wb-line2);background:var(--wb-card);color:var(--wb-tx);
  font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,color .15s,transform .12s;}
[data-wb-btn]:hover{background:var(--wb-card2);border-color:var(--wb-dim2);}
[data-wb-btn]:active{transform:translateY(1px);}
[data-wb-btn][data-primary]{background:var(--wb-acc-tx);border-color:var(--wb-acc-tx);color:#fff;}
[data-wb-btn][data-primary]:hover{filter:brightness(.94);}
[data-wb-btn][data-sm]{height:32px;padding:0 11px;font-size:12.5px;border-radius:9px;}
[data-wb-btn][disabled]{opacity:.45;cursor:not-allowed;transform:none;}
[data-wb-chip]{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:999px;
  border:1px solid var(--wb-line);background:var(--wb-card);color:var(--wb-dim);font-size:11.5px;font-weight:600;white-space:nowrap;}
[data-wb-chip][data-sel]{background:var(--wb-acc-soft);border-color:color-mix(in srgb,var(--wb-acc) 35%,transparent);color:var(--wb-acc-tx);}
[data-wb-chip][data-ok]{background:var(--wb-ok-soft);border-color:color-mix(in srgb,var(--wb-ok) 30%,transparent);color:var(--wb-ok);}
[data-wb-chip][data-warn]{background:var(--wb-warn-soft);border-color:color-mix(in srgb,var(--wb-warn) 30%,transparent);color:var(--wb-warn);}
[data-wb-tier]{font-size:11px;padding:2px 8px;border-radius:6px;font-weight:700;white-space:nowrap;display:inline-block;border:1px solid transparent;}
[data-wb-tier="值得看"],[data-wb-tier][data-tone="worth"]{background:var(--wb-ok-soft);color:var(--wb-ok);border-color:color-mix(in srgb,var(--wb-ok) 30%,transparent);}
[data-wb-tier="可以看"],[data-wb-tier][data-tone="ok"]{background:var(--wb-blue-soft);color:var(--wb-blue);border-color:color-mix(in srgb,var(--wb-blue) 30%,transparent);}
[data-wb-tier="跳过"],[data-wb-tier][data-tone="skip"]{background:var(--wb-card2);color:var(--wb-dim);border-color:var(--wb-line);}
[data-wb-badge]{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;
  border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-dim);font-size:11px;font-weight:700;white-space:nowrap;}
[data-wb-badge][data-tone="worth"]{background:var(--wb-ok-soft);color:var(--wb-ok);border-color:color-mix(in srgb,var(--wb-ok) 30%,transparent);}
[data-wb-badge][data-tone="ok"]{background:var(--wb-blue-soft);color:var(--wb-blue);border-color:color-mix(in srgb,var(--wb-blue) 30%,transparent);}
[data-wb-badge][data-tone="skip"]{background:var(--wb-card2);color:var(--wb-dim);border-color:var(--wb-line);}
[data-wb-cmt]{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--wb-warn-soft);color:var(--wb-warn);
  border:1px solid color-mix(in srgb,var(--wb-warn) 30%,transparent);white-space:nowrap;flex:none;}

/* ---------- 表单 ---------- */
[data-wb-input]{width:100%;box-sizing:border-box;height:34px;padding:0 10px;border-radius:8px;font-size:12.5px;
  border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font-family:inherit;outline:0;}
[data-wb-input]:focus{background:var(--wb-card);border-color:var(--wb-acc);box-shadow:0 0 0 3px var(--wb-acc-soft);}
[data-wb-input][data-area]{height:auto;min-height:84px;padding:9px 11px;line-height:1.6;resize:vertical;}
[data-wb-input][data-num]{width:84px;text-align:center;}
[data-wb-search]{width:100%;height:36px;padding:0 12px;border-radius:10px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-tx);font:inherit;font-size:13px;outline:0;}
[data-wb-search]:focus{background:var(--wb-card);border-color:var(--wb-acc);box-shadow:0 0 0 3px var(--wb-acc-soft);}
[data-wb-searchwrap]{max-width:560px;margin:0 auto 8px;position:relative;width:100%;}
[data-wb-searchwrap] .kbd{position:absolute;right:12px;top:11px;font-size:11px;color:var(--wb-dim2);}
[data-wb-field]{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--wb-dim);flex-wrap:wrap;min-width:0;}
[data-wb-field-body]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;flex:1 1 auto;}
[data-wb-field-label]{flex:none;}
[data-wb-field] input,[data-wb-field] select{max-width:100%;}
[data-wb-toggle]{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12.5px;color:var(--wb-dim);}
[data-wb-toggle] input{width:15px;height:15px;accent-color:var(--wb-acc);}

/* ---------- 素材库双列 ---------- */
[data-wb-store-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;align-items:start;}
[data-wb-store-grid] [data-wb-mat]{grid-template-columns:120px minmax(0,1fr);gap:10px;padding:10px;}
[data-wb-store-grid] [data-wb-mat] [data-wb-thumb]{width:120px;}
[data-wb-store-grid] [data-wb-cardtitle]{min-height:38px;}
[data-wb-store-grid] [data-wb-why]{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
@media(max-width:820px){[data-wb-store-grid]{grid-template-columns:1fr;}[data-wb-store-grid] [data-wb-mat]{grid-template-columns:120px minmax(0,1fr);}[data-wb-store-grid] [data-wb-mat] [data-wb-thumb]{width:120px;}
[data-wb-store-grid] [data-wb-cardtitle]{min-height:38px;}
[data-wb-store-grid] [data-wb-why]{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}}
/* ---------- 卡片 ---------- */
[data-wb-card]{display:flex;flex-direction:column;overflow:hidden;border-radius:var(--wb-radius);border:1px solid var(--wb-line);background:var(--wb-card);box-shadow:var(--wb-shadow);min-width:0;}
[data-wb-card]:hover{border-color:var(--wb-line2);}
[data-wb-sec]{display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:var(--wb-card);box-shadow:var(--wb-shadow);min-width:0;}
[data-wb-h]{font-size:11px;font-weight:750;letter-spacing:.04em;color:var(--wb-dim2);}
[data-wb-sec-title]{font-size:13.5px;font-weight:750;letter-spacing:0;color:var(--wb-tx);}
[data-wb-projtitle]{font-size:14.5px;font-weight:700;}
[data-wb-note]{font-size:11.5px;line-height:1.6;color:var(--wb-dim2);}
[data-wb-meta]{font-size:12px;line-height:1.5;color:var(--wb-dim2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}
[data-wb-why]{font-size:12.5px;color:var(--wb-dim);line-height:1.55;}
[data-wb-pre]{margin:0;padding:10px 12px;border-radius:9px;font-size:11.5px;line-height:18px;white-space:pre-wrap;word-break:break-word;background:var(--wb-card2);color:var(--wb-dim);max-height:280px;overflow:auto;}
[data-wb-err]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:var(--wb-bad-soft);border:1px solid color-mix(in srgb,var(--wb-bad) 30%,transparent);color:var(--wb-bad);word-break:break-word;}
[data-wb-okmsg]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:9px;background:var(--wb-ok-soft);border:1px solid color-mix(in srgb,var(--wb-ok) 30%,transparent);color:var(--wb-ok);}
[data-wb-loading]{font-size:12px;color:var(--wb-dim2);}
[data-wb-grid]{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));}
[data-wb-cover]{position:relative;aspect-ratio:16/9;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,.85);font-family:ui-monospace,Consolas,monospace;background:linear-gradient(135deg,#4c6ef5,#845ef7 55%,#0ca678);}
[data-wb-cover] img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}
[data-wb-cover] [data-wb-tier]{position:absolute;left:8px;top:8px;z-index:2;}
[data-wb-cover] [data-wb-dur]{position:absolute;right:7px;bottom:7px;font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;font-family:ui-monospace,monospace;z-index:2;}
[data-wb-body]{padding:11px 13px 13px;display:flex;flex-direction:column;gap:6px;min-width:0;}
[data-wb-cardtitle]{font-size:14.5px;font-weight:650;line-height:1.42;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}
[data-wb-mat]{display:grid;grid-template-columns:168px minmax(0,1fr);gap:14px;padding:14px;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:var(--wb-card);box-shadow:var(--wb-shadow);align-items:start;}
[data-wb-mat]:hover{border-color:var(--wb-line2);}
[data-wb-mat] [data-wb-thumb]{width:168px;flex:none;border-radius:10px;overflow:hidden;background:var(--wb-card2);position:relative;aspect-ratio:16/9;}
[data-wb-mat] [data-wb-thumb] img{width:100%;height:100%;object-fit:cover;display:block;}
[data-wb-mat] .body{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;}
[data-wb-quotes]{display:flex;flex-direction:column;gap:5px;}
[data-wb-quote]{font-size:12.5px;padding:7px 9px;border-radius:8px;background:var(--wb-card2);border:1px solid var(--wb-line);line-height:1.55;}
[data-wb-quote] b{color:var(--wb-acc-tx);font-family:ui-monospace,monospace;font-weight:700;margin-right:6px;}
[data-wb-frames]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-frames] img{width:84px;height:47px;object-fit:cover;border-radius:6px;border:1px solid var(--wb-line);}
[data-wb-bar]{height:6px;border-radius:999px;background:var(--wb-card2);overflow:hidden;}
[data-wb-bar] i{display:block;height:100%;background:linear-gradient(90deg,var(--wb-acc),#ff9fba);transition:width .3s;}
[data-wb-shots]{display:flex;gap:6px;flex-wrap:wrap;}
[data-wb-shot]{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--wb-card2);border:1px solid var(--wb-line);color:var(--wb-dim);}
[data-wb-shot] b{color:var(--wb-tx);}

/* ---------- 素材格子（表情包 / 贴纸共用） ---------- */
[data-wb-asset-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:10px;}
[data-wb-asset-cell]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px 8px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card);min-width:0;}
[data-wb-asset-cell]:hover{border-color:var(--wb-line2);background:var(--wb-card2);}
[data-wb-asset-cell] img{width:56px;height:56px;object-fit:contain;display:block;}
[data-wb-asset-cell] span{font-size:10.5px;line-height:1.35;color:var(--wb-dim2);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wb-asset-cell][data-clickable]{cursor:pointer;}
@media(max-width:820px){[data-wb-asset-grid]{grid-template-columns:repeat(auto-fill,minmax(76px,1fr));}[data-wb-asset-cell] img{width:48px;height:48px;}}

/* ---------- 素材卡 fact ---------- */
[data-wb-fact]{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--wb-line);background:var(--wb-card2);color:var(--wb-dim);font-size:11px;font-weight:600;white-space:nowrap;}
button[data-wb-fact]{cursor:pointer;}
button[data-wb-fact]:hover{border-color:var(--wb-line2);color:var(--wb-tx);}
[data-wb-fact][data-quiet]{background:transparent;border-style:dashed;color:var(--wb-dim2);}

/* ---------- 弹窗 ---------- */
[data-wb-overlay]{position:fixed;inset:0;z-index:100;background:rgba(12,15,20,.52);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;}
[data-wb-overlay] .x{position:absolute;top:14px;right:18px;font-size:22px;color:#fff;background:transparent;border:0;cursor:pointer;}
[data-wb-overlay] video{max-width:96%;max-height:88%;border-radius:12px;background:#000;}
[data-wb-modal]{width:min(880px,100%);max-height:min(84vh,760px);overflow:auto;background:var(--wb-card);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.12);padding:20px 22px;}
[data-wb-modal-head]{display:flex;align-items:flex-start;gap:12px;}
[data-wb-modal-head] h3{flex:1;font-size:16px;font-weight:750;line-height:1.4;}
[data-wb-modal-close]{width:32px;height:32px;flex:none;border:0;border-radius:9px;background:var(--wb-card2);color:var(--wb-dim);display:grid;place-items:center;cursor:pointer;}
[data-wb-modal-close]:hover{background:var(--wb-line);color:var(--wb-tx);}
[data-wb-modal-body]{margin-top:12px;display:flex;flex-direction:column;gap:12px;}
[data-wb-modal-foot]{display:flex;align-items:center;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--wb-line);}
[data-wb-detail-hero]{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;align-items:start;}
[data-wb-detail-cover]{position:relative;width:220px;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--wb-card2);}
[data-wb-detail-cover] img{width:100%;height:100%;object-fit:cover;}
[data-wb-detail-cover] [data-wb-dur]{position:absolute;right:6px;bottom:6px;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.72);color:#fff;font:10.5px/1.5 ui-monospace,monospace;}
[data-wb-detail-stats]{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:12px;color:var(--wb-dim2);}
[data-wb-detail-stats] b{color:var(--wb-tx);font-weight:650;font-variant-numeric:tabular-nums;}
[data-wb-detail-section]{padding-top:12px;border-top:1px solid var(--wb-line);}
[data-wb-detail-section]:first-child{padding-top:0;border-top:0;}
[data-wb-detail-section] h4{font-size:11px;font-weight:750;letter-spacing:.05em;color:var(--wb-dim2);margin-bottom:7px;}
[data-wb-detail-grid]{display:grid;grid-template-columns:1.25fr 1fr;gap:14px;}
[data-wb-danmaku-list]{display:flex;flex-wrap:wrap;gap:6px;}
[data-wb-danmaku]{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;background:var(--wb-card2);color:var(--wb-dim);font-size:11.5px;}
[data-wb-danmaku] b{color:var(--wb-dim2);font-weight:600;font-variant-numeric:tabular-nums;}
[data-wb-detail-frames]{display:flex;flex-wrap:wrap;gap:8px;}
[data-wb-detail-frames img]{width:104px;height:58px;object-fit:cover;border-radius:6px;border:1px solid var(--wb-line);}
[data-wb-comment-row]{font-size:12px;line-height:1.6;color:var(--wb-dim);padding:5px 0;border-bottom:1px dashed var(--wb-line);}
[data-wb-comment-row]:last-child{border-bottom:0;}
[data-wb-comment-row] b{color:var(--wb-dim2);font-weight:650;}

/* ---------- 设置双栏 ---------- */
[data-wb-settings-layout]{display:grid;grid-template-columns:236px minmax(0,1fr);gap:16px;align-items:start;}
[data-wb-settings-side]{position:sticky;top:0;display:flex;flex-direction:column;gap:10px;}
[data-wb-settings-summary]{padding:14px 16px;}
[data-wb-settings-summary] h3{font-size:12px;font-weight:750;color:var(--wb-dim2);letter-spacing:.03em;margin:0 0 8px;}
[data-wb-summary-row]{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--wb-line);font-size:12px;}
[data-wb-summary-row]:last-child{border-bottom:0;}
[data-wb-summary-row] span{color:var(--wb-dim2);}
[data-wb-summary-row] b{font-weight:650;color:var(--wb-tx);font-variant-numeric:tabular-nums;}
[data-wb-settings-nav]{padding:7px;display:flex;flex-direction:column;gap:2px;}
[data-wb-settings-nav] button{display:flex;align-items:center;height:32px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--wb-dim);font:inherit;font-size:12.5px;font-weight:600;text-align:left;cursor:pointer;}
[data-wb-settings-nav] button:hover{background:var(--wb-card2);color:var(--wb-tx);}
[data-wb-settings-nav] button[data-sel]{background:var(--wb-acc-soft);color:var(--wb-acc-tx);}
[data-wb-settings-main]{display:flex;flex-direction:column;gap:14px;min-width:0;}
[data-wb-settings-main] [data-wb-sec]{padding:18px 20px;gap:14px;}
[data-wb-settings-main] [data-wb-sec-title]{font-size:14px;font-weight:750;color:var(--wb-tx);letter-spacing:0;display:flex;align-items:center;gap:8px;margin:0 0 2px;}
[data-wb-settings-main] [data-wb-sec-title]::before{content:"";width:3px;height:14px;border-radius:2px;background:var(--wb-acc);flex:none;}
[data-wb-settings-main] [data-wb-field]{flex-direction:column;align-items:stretch;gap:5px;}
[data-wb-settings-main] [data-wb-field-label]{font-size:12px;font-weight:650;color:var(--wb-tx);}
[data-wb-settings-main] [data-wb-field-body]{gap:8px;flex:0 0 auto;}
[data-wb-settings-main] [data-wb-field-body] input:not([data-num]),
[data-wb-settings-main] [data-wb-field-body] select{flex:1;width:auto;max-width:none !important;}
[data-wb-settings-main] [data-wb-field-body] input[data-num]{width:84px;max-width:84px;}
[data-wb-settings-main] [data-wb-field-body] [data-wb-note]{flex-basis:100%;margin:0;}

/* ---------- 审核横向卡 ---------- */
[data-wb-review]{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;padding:14px;align-items:start;}
[data-wb-review-cover]{position:relative;width:220px;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--wb-card2);}
[data-wb-review-cover] img{width:100%;height:100%;object-fit:cover;}
[data-wb-review-cover] [data-wb-badge]{position:absolute;left:8px;top:8px;}
[data-wb-review-cover] [data-wb-dur]{position:absolute;right:7px;bottom:7px;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.72);color:#fff;font:10.5px/1.5 ui-monospace,monospace;}
[data-wb-review-body]{min-width:0;display:flex;flex-direction:column;gap:6px;}
[data-wb-review-actions]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px;}
[data-wb-review-more]{margin-top:4px;}
[data-wb-review-more] summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:650;color:var(--wb-dim);width:max-content;}
[data-wb-review-more] summary::-webkit-details-marker{display:none;}
[data-wb-review-more] summary:hover{color:var(--wb-tx);}
[data-wb-review-more] .more{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}

/* ---------- 其他 ---------- */
[data-wb-split]{display:grid;grid-template-columns:1fr 1fr;gap:14px;min-width:0;}
[data-wb-login]{display:flex;gap:18px;align-items:flex-start;padding:16px;border:1px solid color-mix(in srgb,var(--wb-blue) 40%,transparent);border-radius:var(--wb-radius);background:var(--wb-blue-soft);}
[data-wb-qr]{width:150px;height:150px;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden;}
[data-wb-qr] img{width:100%;height:100%;object-fit:contain;}
[data-wb-qr] .ph{width:118px;height:118px;border-radius:4px;background:repeating-conic-gradient(#0b1020 0 25%,#fff 0 50%) 0 0/16px 16px;}
[data-wb-stat]{padding:14px 16px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card);}
[data-wb-stat] b{display:block;font-size:22px;line-height:1.2;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums;}
[data-wb-stat] span{font-size:11.5px;color:var(--wb-dim2);}
[data-wb-empty]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:42px 20px;border:1px dashed var(--wb-line2);border-radius:var(--wb-radius);background:var(--wb-card2);text-align:center;}
[data-wb-empty-ico]{font-size:36px;line-height:1;opacity:.55;}
[data-wb-empty-title]{font-size:14px;font-weight:700;color:var(--wb-tx);}
[data-wb-empty-hint]{font-size:12px;line-height:1.7;color:var(--wb-dim2);max-width:440px;}
[data-wb-empty] [data-wb-btn]{margin-top:4px;}
[data-wb-kv]{font-size:11.5px;line-height:19px;color:var(--wb-dim2);word-break:break-all;}
[data-wb-divider]{height:1px;background:var(--wb-line);margin:2px 0;}
[data-wb-composer]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--wb-acc) 35%,transparent);border-radius:11px;background:var(--wb-acc-soft);}
[data-wb-account]{display:flex;align-items:center;gap:14px;padding:16px 18px;border:1px solid var(--wb-line);border-radius:var(--wb-radius);background:var(--wb-card);}
[data-wb-avatar]{width:46px;height:46px;border-radius:50%;flex:none;display:grid;place-items:center;background:var(--wb-acc-soft);color:var(--wb-acc-tx);font-size:16px;font-weight:750;}
[data-wb-stat-grid]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;}
[data-wb-memory-grid]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;}
[data-wb-memory-col]{padding:14px;border:1px solid var(--wb-line);border-radius:12px;background:var(--wb-card2);min-width:0;}
[data-wb-memory-item]{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px dashed var(--wb-line);font-size:12.5px;line-height:1.55;}
[data-wb-memory-item]:last-child{border-bottom:0;}
[data-wb-memory-item] span{flex:1;min-width:0;}
[data-wb-memory-item] button{width:26px;height:26px;flex:none;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--wb-dim2);font-size:15px;line-height:1;cursor:pointer;}
[data-wb-memory-item] button:hover{background:var(--wb-bad-soft);color:var(--wb-bad);}
[data-wb-event-row]{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--wb-line);font-size:12.5px;}
[data-wb-event-row]:last-child{border-bottom:0;}
[data-wb-event-row] .text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-wb-event-row] time{font-size:11px;color:var(--wb-dim2);flex:none;}

/* ---------- 响应式 ---------- */
@media(max-width:1180px){
  [data-wb-grid]{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));}
}
@media(max-width:980px){
  [data-wb-split]{grid-template-columns:1fr;}
  [data-wb-settings-layout]{grid-template-columns:1fr;}
  [data-wb-settings-side]{position:static;}
  [data-wb-settings-summary]{display:none;}
  [data-wb-settings-nav]{flex-direction:row;flex-wrap:wrap;}
  [data-wb-settings-nav] button{height:30px;}
  [data-wb-detail-hero],[data-wb-review]{grid-template-columns:1fr;}
  [data-wb-detail-cover],[data-wb-review-cover]{width:100%;}
  [data-wb-detail-grid]{grid-template-columns:1fr;}
  [data-wb-stat-grid]{grid-template-columns:repeat(2,minmax(0,1fr));}
  [data-wb-memory-grid]{grid-template-columns:1fr;}
}
@media(max-width:820px){
  [data-wb-rail]{width:62px;padding:16px 6px;}
  [data-wb-label],[data-wb-brand] small{display:none;}
  [data-wb-brand]{font-size:0;text-align:center;}
  [data-wb-brand]::after{content:"WB";font-size:13px;}
  [data-wb-nav]{justify-content:center;padding:10px 0;}
  [data-wb-main]{padding:16px 16px 36px;}
  [data-wb-sticky-header]{margin:-16px -16px 0;padding:16px 16px 10px;top:-16px;}
  [data-wb-mat]{grid-template-columns:120px minmax(0,1fr);}
  [data-wb-mat] [data-wb-thumb]{width:120px;}
}
@media(max-width:720px){
  [data-wb-title]{font-size:20px;}
  [data-wb-mat]{grid-template-columns:1fr;}
  [data-wb-mat] [data-wb-thumb]{width:100%;}
  [data-wb-review-cover]{max-height:200px;}
}
@media(prefers-reduced-motion:reduce){
  *{scroll-behavior:auto !important;transition:none !important;animation:none !important;}
}
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
    const Field = ({ label, children }) => h('div', { 'data-wb-field': '' },
      h('span', { 'data-wb-field-label': '' }, label),
      h('div', { 'data-wb-field-body': '' }, children))
    const Note = ({ children }) => h('div', { 'data-wb-note': '' }, children)
    const Empty = ({ icon = '📭', title, hint, children }) => h('div', { 'data-wb-empty': '' },
      h('div', { 'data-wb-empty-ico': '' }, icon),
      title ? h('div', { 'data-wb-empty-title': '' }, title) : null,
      hint ? h('div', { 'data-wb-empty-hint': '' }, hint) : null,
      children || null)
    const Sec = ({ title, children, style, ...rest }) => h('div', { 'data-wb-sec': '', style, ...rest },
      title ? h('div', { 'data-wb-h': '', 'data-wb-sec-title': '' }, title) : null, children)
    const Err = ({ children }) => children ? h('div', { 'data-wb-err': '' }, children) : null
    const OkMsg = ({ children }) => children ? h('div', { 'data-wb-okmsg': '' }, children) : null

    /* 技术详情折叠块：命令行 / 原始 JSON 默认收起，点开才看 */
    function TechDetails({ text }) {
      const [open, setOpen] = useState(false)
      if (!text) return null
      return h('div', { 'data-wb-col': '' },
        h('button', {
          'data-wb-ghost': '', style: { width: 'auto', padding: '3px 10px', fontSize: '11.5px', alignSelf: 'flex-start' },
          onClick: () => setOpen(!open),
        }, open ? '收起技术详情 ▾' : '查看技术详情 ▸'),
        open ? h('pre', { 'data-wb-pre': '' }, text) : null)
    }
    const firstLine = (s) => String(s || '').split('\n')[0]

    /* ═══════════════════ ① 素材库 ═══════════════════ */
    function StoreRow({ r, onDetail }) {
      const quotes = r.quotes || []
      const memes = r.memes || []
      const comments = r.hotComments || []
      const metaText = [r.up?.name, fmtDur(r.duration), r.stat ? `播放 ${fmtNum(r.stat.view)}` : ''].filter(Boolean).join(' · ')
      const fullMeta = [...[r.up?.name, fmtDur(r.duration), r.stat ? `播放 ${fmtNum(r.stat.view)} · 点赞 ${fmtNum(r.stat.like)}` : '', `采集于 ${dayOf(r.fetchedAt)}`].filter(Boolean)].join(' · ')
      return h('div', { 'data-wb-mat': '', 'data-wb-bv': r.bvid },
        h('div', { 'data-wb-thumb': '' },
          h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
          r.judge?.tier ? h('span', { style: { position: 'absolute', left: 6, top: 6, zIndex: 2 } }, h(Tier, { t: r.judge.tier })) : null,
          r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
        h('div', { className: 'body' },
          h('div', { 'data-wb-cardtitle': '', style: { minWidth: 0 } }, r.title || '(无标题)'),
          h('div', { 'data-wb-meta': '', title: fullMeta }, metaText),
          r.judge ? h('div', { 'data-wb-why': '', title: r.judge.why || '' }, r.judge.why || '还没有 AI 评级')
            : h('div', { 'data-wb-note': '' }, '还没判定 —— 去「刷 B 站 → 设置」跑一轮'),
          h('div', { 'data-wb-row': '' },
            quotes.length
              ? h('button', { 'data-wb-fact': '', onClick: () => onDetail(r.bvid) }, `${quotes.length} 条金句`)
              : h('span', { 'data-wb-fact': '', 'data-quiet': '' }, '暂无片段'),
            memes.length ? h('span', { 'data-wb-fact': '' }, `${memes.length} 个热梗`) : null,
            comments.length ? h('span', { 'data-wb-fact': '' }, `${comments.length} 条热评`) : null),
          h('div', { 'data-wb-row': '' },
            h(Btn, { sm: true, onClick: () => onDetail(r.bvid) }, '查看详情'),
            r.commented ? h('span', { 'data-wb-chip': '', 'data-ok': '' }, '已评论') : null,
            h('div', { 'data-wb-grow': '' }))))
    }

    /* ── 分页小组件 ── */
    function Pager({ page, total, pageSize, onChange }) {
      const pages = Math.max(1, Math.ceil((total || 0) / (pageSize || 1)))
      if (total === 0) return null
      return h('div', { 'data-wb-row': '', style: { alignItems: 'center', gap: 8 } },
        h('span', { 'data-wb-meta': '' }, `共 ${pages} 页 · 第 ${page} 页`),
        h(Btn, { sm: true, disabled: page <= 1, onClick: () => onChange(page - 1) }, '＜ 上一页'),
        h(Btn, { sm: true, disabled: page >= pages, onClick: () => onChange(page + 1) }, '下一页 ＞'))
    }

    /* ── 素材库 · 表情包子页 ── */
    function MemePane({ list, page, setPage, pkg, setPkg }) {
      const memes = list.data?.memes || []
      const total = list.data?.total ?? memes.length
      const pkgs = useMemo(() => {
        const m = new Map()
        for (const x of memes) m.set(x.package, (m.get(x.package) || 0) + 1)
        return [['全部', memes.length], ...[...m.entries()]]
      }, [memes])
      const rows = memes
      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读表情包…') : null,
        !list.loading && !rows.length ? h(Empty, {
          icon: '😂',
          title: list.data?.missing ? `未找到素材目录：${list.data?.dir || 'assets-src/memes'}` : '还没有表情包',
          hint: list.data?.missing ? '可设置环境变量 BILI_ASSETS 指向素材目录后重启。' : 'assets-src/memes/ 下还没有索引。',
        }) : null,
        h('div', { 'data-wb-row': '' },
          ...pkgs.map(([k, n]) => h('button', {
            key: k, 'data-wb-chip': '', 'data-sel': pkg === k ? '' : undefined,
            onClick: () => { setPkg(k); setPage(1) }, style: { cursor: 'pointer' },
          }, `${k} ${n}`))),
        h('div', { 'data-wb-asset-grid': '' },
          ...rows.map((x) => h('div', {
            key: x.file, 'data-wb-asset-cell': '', title: x.text || x.package || x.file,
          },
          h('img', {
            src: `${API}/assets/media?path=${encodeURIComponent('memes/' + x.file)}`,
            alt: x.text || '', loading: 'lazy',
          }),
          h('span', {}, x.text || x.package || '')))),
        h(Pager, { page, total, pageSize: 40, onChange: setPage }))
    }

    /* ── 素材库 · BGM 子页 ── */
    function BgmPane({ list, page, setPage, mood, setMood }) {
      const bgm = list.data?.bgm || []
      const total = list.data?.total ?? bgm.length
      const moods = useMemo(() => {
        const m = new Map()
        for (const x of bgm) m.set(x.mood, (m.get(x.mood) || 0) + 1)
        return [['全部', bgm.length], ...[...m.entries()]]
      }, [bgm])
      const rows = bgm
      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读 BGM 库…') : null,
        !list.loading && !rows.length ? h(Empty, {
          icon: '🎵',
          title: list.data?.missing ? `未找到素材目录：${list.data?.dir || 'assets-src/bgm'}` : '还没有 BGM',
          hint: list.data?.missing ? '可设置环境变量 BILI_ASSETS 指向素材目录后重启。' : 'assets-src/bgm/ 下还没有索引。',
        }) : null,
        h('div', { 'data-wb-row': '' },
          ...moods.map(([k, n]) => h('button', {
            key: k, 'data-wb-chip': '', 'data-sel': mood === k ? '' : undefined,
            onClick: () => { setMood(k); setPage(1) }, style: { cursor: 'pointer' },
          }, `${k} ${n}`))),
        h('div', { 'data-wb-col': '' }, ...rows.map((b) => h('div', { key: b.file, 'data-wb-card': '', style: { padding: '10px 12px' } },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, b.title || b.file),
            b.mood ? h('span', { 'data-wb-badge': '' }, b.mood) : null,
            b.duration_seconds ? h('span', { 'data-wb-meta': '' }, fmtDur(b.duration_seconds)) : null),
          h('div', { 'data-wb-meta': '' }, [b.artist, b.license].filter(Boolean).join(' · ')),
          h('audio', { controls: true, preload: 'none', style: { width: '100%', height: 32 }, src: `${API}/assets/media?path=${encodeURIComponent('bgm/' + b.file)}` })))),
        h(Pager, { page, total, pageSize: 20, onChange: setPage }))
    }

    /* ── 一键采音色弹窗 ── */
    function HarvestVoiceModal({ open, onClose, onDone }) {
      const [bv, setBv] = useState('')
      const [range, setRange] = useState('10-30')
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)
      const [harvesting, setHarvesting] = useState(false)
      const [msg, setMsg] = useState(null) // { ok, text }
      const pollRef = useRef(null)
      const pollTriesRef = useRef(0)
      useEffect(() => () => clearInterval(pollRef.current), [])
      if (!open) return null
      // 后台任务轮询：提交后立即返回 taskId，每 4 秒查一次状态；关弹窗任务继续
      const pollStatus = async (taskId) => {
        pollTriesRef.current += 1
        if (pollTriesRef.current > 450) {
          clearInterval(pollRef.current); pollRef.current = null
          setHarvesting(false)
          setMsg({ ok: false, text: '采集超过 30 分钟仍未返回；后台可能还在跑，稍后到「音色」里刷新看看' })
          return
        }
        const r = await jget('/assets/voice/harvest/status?taskId=' + encodeURIComponent(taskId))
        if (!r.ok) return
        if (r.state === 'done') {
          clearInterval(pollRef.current); pollRef.current = null
          setHarvesting(false)
          setMsg({ ok: true, text: `采好了：${r.file}，参考文本已写入同名 .txt` })
          onDone?.()
        } else if (r.state === 'failed') {
          clearInterval(pollRef.current); pollRef.current = null
          setHarvesting(false)
          setMsg({ ok: false, text: '❌ ' + firstLine(r.error || '采集失败') })
        }
      }
      const submit = async () => {
        const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(range)
        if (!m) { setMsg({ ok: false, text: '起止秒格式：10-40' }); return }
        setBusy(true); setMsg(null)
        const r = await jpost('/assets/voice/harvest', {
          bv: bv.trim(), from: Number(m[1]), to: Number(m[2]), name: name.trim(),
        })
        setBusy(false)
        if (r.ok && r.taskId) {
          setHarvesting(true)
          setMsg({ ok: true, text: '采集中…（可关掉弹窗，后台继续）' })
          pollTriesRef.current = 0
          clearInterval(pollRef.current)
          pollRef.current = setInterval(() => pollStatus(r.taskId), 4000)
        } else setMsg({ ok: false, text: errText(r) || '提交采集失败' })
      }
      return h('div', {
        'data-wb-overlay': '',
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      },
        h('button', { className: 'x', onClick: () => onClose() }, '✕'),
        h('div', { 'data-wb-sec': '', style: { width: 'min(460px, 94%)', margin: 0 } },
          h('div', { 'data-wb-cardtitle': '' }, '采新音色'),
          h('div', { 'data-wb-note': '' }, '给一个 B站 视频和秒数区间（3-60 秒，建议 20 秒左右），自动下载 → 分离人声 → 截字幕最密的 ≤9.5 秒做参考音。需要视频有字幕。'),
          h(Field, { label: 'BV 号' },
            h('input', { 'data-wb-input': '', placeholder: 'BV1xxxxxxxxxx', value: bv, onChange: (e) => setBv(e.target.value) })),
          h(Field, { label: '起止秒' },
            h('input', { 'data-wb-input': '', placeholder: '10-40', value: range, onChange: (e) => setRange(e.target.value) })),
          h(Field, { label: '音色名（英文 / 数字 / 连字符）' },
            h('input', { 'data-wb-input': '', placeholder: 'my-voice-01', value: name, onChange: (e) => setName(e.target.value) })),
          msg ? h(msg.ok ? OkMsg : Err, {}, msg.text) : null,
          harvesting ? h(Note, {}, '采集中…（可关掉弹窗，后台继续；下次打开音色栏刷新可见）') : null,
          h('div', { 'data-wb-row': '', style: { justifyContent: 'flex-end' } },
            h(Btn, { sm: true, onClick: onClose }, harvesting ? '关掉，后台继续' : '关闭'),
            h(Btn, { sm: true, primary: true, onClick: submit, disabled: busy || harvesting || !bv.trim() || !name.trim() },
              busy ? '提交中…' : harvesting ? '采集中…' : '开始采集'))))
    }

    /* ── 导入本地 wav 音色弹窗 ── */
    function ImportVoiceModal({ open, onClose, onDone }) {
      const [path, setPath] = useState('')
      const [name, setName] = useState('')
      const [promptText, setPromptText] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      if (!open) return null
      const submit = async () => {
        setBusy(true); setMsg(null)
        const r = await jpost('/assets/voice/import', { path: path.trim(), name: name.trim(), promptText: promptText.trim() })
        setBusy(false)
        if (r.ok) { setMsg({ ok: true, text: `已导入：${r.file}` }); onDone?.() }
        else setMsg({ ok: false, text: errText(r) || '导入失败' })
      }
      return h('div', {
        'data-wb-overlay': '',
        onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose() },
      },
        h('button', { className: 'x', onClick: () => { if (!busy) onClose() } }, '✕'),
        h('div', { 'data-wb-sec': '', style: { width: 'min(460px, 94%)', margin: 0 } },
          h('div', { 'data-wb-cardtitle': '' }, '导入本地 wav'),
          h('div', { 'data-wb-note': '' }, '把本机一个 .wav 参考音拷进素材库。填完整路径（如 D:\\audio\\me.wav）。'),
          h(Field, { label: 'wav 文件完整路径' },
            h('input', { 'data-wb-input': '', placeholder: 'D:\\audio\\me.wav', value: path, onChange: (e) => setPath(e.target.value) })),
          h(Field, { label: '音色名（英文 / 数字 / 连字符）' },
            h('input', { 'data-wb-input': '', placeholder: 'my-voice-01', value: name, onChange: (e) => setName(e.target.value) })),
          h(Field, { label: '参考文本（可选）' },
            h('input', { 'data-wb-input': '', placeholder: '这段音频说的话，供声音克隆参考', value: promptText, onChange: (e) => setPromptText(e.target.value) })),
          msg ? h(msg.ok ? OkMsg : Err, {}, msg.text) : null,
          h('div', { 'data-wb-row': '', style: { justifyContent: 'flex-end' } },
            h(Btn, { sm: true, onClick: onClose, disabled: busy }, '关闭'),
            h(Btn, { sm: true, primary: true, onClick: submit, disabled: busy || !path.trim() || !name.trim() }, busy ? '导入中…' : '导入'))))
    }

    /* ── 素材库 · 音色子页 ── */
    function VoicePane({ importOpen, setImportOpen, harvestOpen, setHarvestOpen }) {
      const list = useApi('/assets/voices')
      const [delArm, setDelArm] = useState('')
      const [busy, setBusy] = useState('')
      const del = async (file) => {
        if (delArm !== file) { setDelArm(file); return }
        setBusy(file)
        const r = await jpost('/assets/delete', { kind: 'voice', file })
        setBusy(''); setDelArm('')
        if (r.ok) list.reload()
      }
      const voices = list.data?.voices || []
      return h('div', { 'data-wb-page': '' },
        h(HarvestVoiceModal, { open: harvestOpen, onClose: () => setHarvestOpen(false), onDone: () => list.reload() }),
        h(ImportVoiceModal, { open: importOpen, onClose: () => setImportOpen(false), onDone: () => list.reload() }),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读音色库…') : null,
        !list.loading && !voices.length ? h(Empty, {
          icon: '🎙️',
          title: list.data?.missing ? `未找到素材目录：${list.data?.dir || 'assets-src/voices'}` : '还没有音色',
          hint: list.data?.missing
            ? '可设置环境变量 BILI_ASSETS 指向素材目录后重启；或点「导入本地 wav」放进一个参考音。'
            : '音色 wav 放在 assets-src/voices/ 下（同名 .txt 是参考文本，_clone- 前缀是克隆音）。',
        }) : null,
        h('div', { 'data-wb-col': '' }, ...voices.map((v) => h('div', { key: v.file, 'data-wb-card': '', style: { padding: '10px 12px' } },
          h('div', { 'data-wb-row': '' },
            h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, v.name),
            v.hasClone ? h(Chip, { ok: true }, '已克隆') : h(Chip, {}, '仅参考音'),
            `${(v.bytes / 1024 / 1024).toFixed(1)} MB` ? h('span', { 'data-wb-meta': '' }, `${(v.bytes / 1024 / 1024).toFixed(1)} MB`) : null),
          h('div', { 'data-wb-note': '' }, v.promptText ? String(v.promptText).slice(0, 60) : '（没有参考文本）'),
          h('div', { 'data-wb-row': '', style: { alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
            h('audio', { controls: true, preload: 'none', style: { height: 32 }, src: `${API}/assets/media?path=${encodeURIComponent('voices/' + v.file)}` }),
            v.hasClone ? h('audio', { controls: true, preload: 'none', style: { height: 32 }, src: `${API}/assets/media?path=${encodeURIComponent('voices/_clone-' + v.file)}` }) : null,
            h('div', { 'data-wb-grow': '' }),
            h(Btn, {
              sm: true,
              style: delArm === v.file ? { color: '#f87171', borderColor: 'rgba(248,113,113,.5)' } : undefined,
              onClick: () => del(v.file),
            }, busy === v.file ? '删除中…' : delArm === v.file ? '确认删除？' : '删除'))))))
    }

    /* ── 素材库 · 片段子页 ── */
    function ClipPane({ list }) {
      const [delArm, setDelArm] = useState('')
      const [busy, setBusy] = useState('')
      const del = async (file) => {
        if (delArm !== file) { setDelArm(file); return }
        setBusy(file)
        const r = await jpost('/assets/delete', { kind: 'clip', file })
        setBusy(''); setDelArm('')
        if (r.ok) list.reload()
      }
      const clips = list.data?.clips || []
      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读片段库…') : null,
        !list.loading && !clips.length ? h(Empty, {
          icon: '🎞️',
          title: list.data?.missing ? `未找到素材目录：${list.data?.dir || 'assets-src/clips'}` : '还没有片段',
          hint: list.data?.missing
            ? '可设置环境变量 BILI_ASSETS 指向素材目录后重启。'
            : '在「刷 B 站」看到好片段可以采下来，或者用出片流程自动补素材。',
        }) : null,
        h('div', { 'data-wb-grid': '' }, ...clips.map((c) => h('div', { key: c.file, 'data-wb-card': '' },
          h('div', { 'data-wb-body': '' },
            h('div', { 'data-wb-row': '' },
              h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, c.title || c.file),
              c.dur ? h('span', { 'data-wb-dur': '' }, fmtDur(c.dur)) : null),
            h('div', { 'data-wb-meta': '' }, [c.bv, c.up, c.license].filter(Boolean).join(' · ')),
            h('video', { controls: true, preload: 'none', style: { maxWidth: 280, width: '100%', borderRadius: 8 }, src: `${API}/assets/media?path=${encodeURIComponent('clips/' + c.file)}` }),
            h('div', { 'data-wb-row': '' },
              c.url ? h('a', { href: c.url, target: '_blank', rel: 'noreferrer', 'data-wb-meta': '' }, '原视频 ↗') : null,
              h('div', { 'data-wb-grow': '' }),
              h(Btn, {
                sm: true,
                style: delArm === c.file ? { color: '#f87171', borderColor: 'rgba(248,113,113,.5)' } : undefined,
                onClick: () => del(c.file),
              }, busy === c.file ? '删除中…' : delArm === c.file ? '确认删除？' : '删除')))))))
    }

    /* ── 素材库 · 贴纸子页（OpenMoji） ── */
    const STICKER_FILE = (emoji) => [...emoji].map((c) => c.codePointAt(0).toString(16).toUpperCase()).join('-') + '.png'
    const STICKER_EMOJI = (file) => {
      try {
        const segs = file.replace(/\.png$/i, '').split('-').map((s) => parseInt(s, 16)).filter((n) => n > 0)
        return segs.length ? String.fromCodePoint(...segs) : ''
      } catch { return '' }
    }
    function StickerPane({ list, page, setPage }) {
      const [q, setQ] = useState('')
      const [chk, setChk] = useState({ state: 'idle', emoji: '', file: '' }) // idle|noemoji|checking|ok|missing
      const files = list.data?.files || []
      const total = list.data?.total ?? files.length
      const isEmoji = (s) => {
        try {
          return /\p{Extended_Pictographic}/u.test(s) && /^[#*\u200d\ufe0f\p{Extended_Pictographic}]+$/u.test(s)
        } catch { return false }
      }
      // 输入 emoji → 转文件名 → 请求后端确认库里存在，避免破图
      const doSearch = async (raw) => {
        const s = String(raw || '').trim()
        if (!s) { setChk({ state: 'idle', emoji: '', file: '' }); return }
        if (!isEmoji(s)) { setChk({ state: 'noemoji', emoji: s, file: '' }); return }
        const file = STICKER_FILE(s)
        setChk({ state: 'checking', emoji: s, file })
        const r = await jget('/assets/stickers?emoji=' + encodeURIComponent(file))
        setChk(r.ok && r.exists
          ? { state: 'ok', emoji: s, file }
          : { state: 'missing', emoji: s, file })
      }
      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读贴纸库…') : null,
        h('form', {
          'data-wb-row': '', onSubmit: (e) => { e.preventDefault(); doSearch(q) },
        },
          h('input', {
            'data-wb-search': '', style: { flex: '1 1 220px', maxWidth: '300px', width: 'auto' },
            value: q, onChange: (e) => setQ(e.target.value),
            placeholder: '粘贴一个 emoji，回车定位，如 🎉',
          }),
          h(Btn, { sm: true, type: 'submit' }, '定位'),
          h(Note, {}, '也可以直接点下面的贴纸')),
        chk.state === 'noemoji' ? h(Err, {}, '请粘贴一个 emoji') : null,
        chk.state === 'checking' ? h('div', { 'data-wb-loading': '' }, '查库里有没有…') : null,
        chk.state === 'ok' ? h('div', { 'data-wb-asset-cell': '', style: { maxWidth: 170, marginTop: 4 } },
          h('img', {
            src: `${API}/assets/media?path=${encodeURIComponent('stickers/openmoji/png-618x618-color/' + chk.file)}`,
            alt: chk.file, style: { width: 96, height: 96 },
          }),
          h('span', {}, `${chk.emoji} ${chk.file}`)) : null,
        chk.state === 'missing' ? h(Err, {}, '库里没有这个 emoji 贴纸') : null,
        !list.loading && !files.length ? h(Empty, {
          icon: '🧩',
          title: list.data?.missing ? `未找到素材目录：${list.data?.dir || 'assets-src/stickers'}` : '还没有贴纸',
          hint: list.data?.missing ? '可设置环境变量 BILI_ASSETS 指向素材目录后重启。' : 'assets-src/stickers/ 下还没有贴纸文件。',
        }) : null,
        h('div', { 'data-wb-asset-grid': '' }, ...files.map((f) => {
          const emoji = STICKER_EMOJI(f)
          return h('div', {
            key: f, 'data-wb-asset-cell': '', 'data-clickable': '', title: emoji || f,
            onClick: () => { setQ(emoji || ''); doSearch(emoji) },
          },
          h('img', {
            src: `${API}/assets/media?path=${encodeURIComponent('stickers/openmoji/png-618x618-color/' + f)}`,
            alt: emoji || f, loading: 'lazy', decoding: 'async',
          }),
          h('span', {}, emoji || f.replace(/\.png$/i, '')))
        })),
        h(Pager, { page, total, pageSize: 60, onChange: setPage }))
    }

    /* ── 本地文件导入（字体 / 视频 / 音频） ── */
    function UploadAssetModal({ kind, onClose, onDone }) {
      const cfg = {
        font: { title: '导入本地字体', accept: '.ttf,.otf,.woff,.woff2', hint: '支持 ttf / otf / woff / woff2，导入后可在「字体」里预览' },
        video: { title: '导入本地视频', accept: 'video/*', hint: '支持 mp4 / mov / webm / mkv，导入后进「片段」' },
        audio: { title: '导入本地音频', accept: 'audio/*', hint: '支持 mp3 / wav / m4a / flac / ogg，导入后进「BGM」' },
      }[kind] || { title: '导入本地素材', accept: '', hint: '' }
      const [file, setFile] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      useEffect(() => {
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose() }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [busy])
      const submit = async () => {
        if (!file) return
        setBusy(true); setMsg('上传中…')
        try {
          const r = await fetch(`${API}/assets/upload?kind=${encodeURIComponent(kind)}`, {
            method: 'POST',
            headers: { 'x-filename': encodeURIComponent(file.name) },
            body: file,
          })
          const j = await r.json()
          if (j.ok) { setMsg('已导入：' + j.file); onDone?.(j) }
          else setMsg('失败：' + (j.error || '未知错误'))
        } catch (e) { setMsg('失败：' + String(e?.message ?? e)) }
        setBusy(false)
      }
      return h('div', {
        'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.title,
        onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose() },
      },
        h('div', { 'data-wb-modal': '', style: { width: 'min(500px, 94%)' } },
          h('div', { 'data-wb-modal-head': '' },
            h('h3', { style: { flex: 1 } }, cfg.title),
            h('button', { 'data-wb-modal-close': '', 'aria-label': '关闭', onClick: () => { if (!busy) onClose() } }, '✕')),
          h('div', { 'data-wb-modal-body': '' },
            h('input', {
              type: 'file', accept: cfg.accept,
              onChange: (e) => setFile(e.target.files?.[0] || null),
              style: { width: '100%', padding: '12px', border: '1px dashed var(--wb-line2)', borderRadius: 10, background: 'var(--wb-card2)', color: 'var(--wb-tx)' },
            }),
            h(Note, {}, cfg.hint),
            h(Note, {}, '文件会复制到项目 assets-src 下，原文件不动；同名文件自动加 -1。'),
            msg ? h(Note, {}, msg) : null),
          h('div', { 'data-wb-modal-foot': '' },
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, disabled: busy, onClick: onClose }, '关闭'),
            h(Btn, { sm: true, primary: true, disabled: busy || !file, onClick: submit }, busy ? '上传中…' : '导入'))))
    }

    /* ── 素材库 · 字体子页 ── */
    function FontPane({ list, onImport }) {
      const fonts = list.data?.fonts || []
      const [arm, setArm] = useState('')
      const del = async (file) => {
        if (arm !== file) { setArm(file); return }
        const r = await jpost('/assets/delete', { kind: 'font', file })
        setArm('')
        if (r.ok) list.reload()
      }
      const css = fonts.map((f) => `@font-face{font-family:${JSON.stringify(f.family)};src:url('${API}/assets/media?path=${encodeURIComponent('fonts/' + f.file)}');}`).join(String.fromCharCode(10))
      return h('div', { 'data-wb-page': '' },
        h('style', {}, css),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读字体库…') : null,
        !list.loading && !fonts.length ? h(Empty, {
          icon: '🔤',
          title: '还没有字体',
          hint: '导入 ttf / otf / woff 后，这里会用字体本身渲染一段预览；渲染端接入后可用于字幕和花字。',
        }, h(Btn, { sm: true, onClick: onImport }, '导入字体')) : null,
        h('div', { 'data-wb-col': '' }, ...fonts.map((f) => h('div', { key: f.file, 'data-wb-card': '', style: { padding: '14px 16px' } },
          h('div', { 'data-wb-row': '' },
            h('b', { style: { fontSize: 14 } }, f.name || f.file),
            h('span', { 'data-wb-meta': '' }, `${(f.bytes / 1024 / 1024).toFixed(1)} MB`),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => del(f.file) }, arm === f.file ? '确认删除？' : '删除')),
          h('div', {
            style: { fontFamily: JSON.stringify(f.family), fontSize: 22, lineHeight: 1.7, margin: '8px 0 4px', wordBreak: 'break-word' },
          }, '今天也要好好吃饭 0123 ABC 字体预览'),
          h('div', { 'data-wb-meta': '' }, f.file)))),
        h(Note, {}, '字体文件在 assets-src/fonts/；当前仅做预览，渲染的字幕/花字字体接入在下一阶段。'))
    }

    /* ── 素材库 · AI 生成物（视频 / 图片） ── */
    const GEN_MODE_META = {
      t2i: { kind: 'image', label: '文生图', hint: '描述你想要的画面：主体、动作、场景、构图、光线。', needRef: false },
      i2i: { kind: 'image', label: '图生图', hint: '在选中的图上改：换风格、换场景、换表情，尽量保留角色。', needRef: true },
      t2v: { kind: 'video', label: '文生视频', hint: '描述一个镜头：主体做一个动作，3–5 秒，不要写多段剧情。', needRef: false },
      i2v: { kind: 'video', label: '图生视频', hint: '让选中的图动起来：写清一个动作和镜头运动，别让它换脸。', needRef: true },
    }
    const GEN_JOB_LABEL = {
      queued: '排队中', running: '生成中', done: '已完成', failed: '失败',
      cancelled: '已取消', interrupted: '已中断',
    }

    function GenJobStrip({ jobs, onCancel, onRetry }) {
      const rows = (jobs || []).filter((j) => ['queued', 'running'].includes(j.status)
        || ['failed', 'interrupted', 'cancelled'].includes(j.status)).slice(0, 4)
      if (!rows.length) return null
      return h('div', { 'data-wb-card': '', style: { padding: '12px 14px', marginBottom: 12 } },
        h('div', { 'data-wb-row': '', style: { marginBottom: 8 } },
          h('b', { style: { fontSize: 13 } }, '生成任务'),
          h('div', { 'data-wb-grow': '' }),
          h('span', { 'data-wb-meta': '' }, '后台运行，关页面不会丢')),
        h('div', { 'data-wb-col': '', style: { gap: 8 } },
          ...rows.map((j) => h('div', {
            key: j.id, 'data-wb-row': '',
            style: { gap: 8, padding: '8px 10px', borderRadius: 9, background: 'var(--wb-card2)' },
          },
            h('span', {
              'data-wb-chip': '',
              'data-sel': ['queued', 'running'].includes(j.status) ? '' : undefined,
              style: j.status === 'failed' ? { color: '#c7365f' } : undefined,
            }, GEN_JOB_LABEL[j.status] || j.status),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', {
                style: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: j.prompt || j.title,
              }, j.title || j.prompt || j.id),
              h('div', { 'data-wb-meta': '' },
                [j.model, j.stage, j.error].filter(Boolean).join(' · ').slice(0, 120))),
            ['queued', 'running'].includes(j.status)
              ? h(Btn, { sm: true, onClick: () => onCancel?.(j) }, '取消')
              : h(Btn, { sm: true, onClick: () => onRetry?.(j) }, '重试')))))
    }

    function GenerateModal({ open, initial, onClose, onDone }) {
      const [mode, setMode] = useState(initial?.mode || 't2i')
      const [prompt, setPrompt] = useState(initial?.prompt || '')
      const [ref, setRef] = useState(initial?.ref || '')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const needRef = mode === 'i2i' || mode === 'i2v'
      const cfg = useApi(open ? '/config' : '')
      const imgs = useApi(open && needRef ? '/assets/generated?kind=image' : '')
      useEffect(() => {
        if (!open) return
        setMode(initial?.mode || 't2i')
        setPrompt(initial?.prompt || '')
        setRef(initial?.ref || '')
        setMsg('')
      }, [open, initial])
      useEffect(() => {
        if (!open) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [open, busy, onClose])
      if (!open) return null
      const g = cfg.data?.config?.generation || {}
      const model = g[mode] || ''
      const meta = GEN_MODE_META[mode]
      const items = imgs.data?.items || []
      const refFile = String(ref || '').split('/').pop()
      const hasRefOption = items.some((it) => it.file === refFile)
      const submit = async () => {
        if (!prompt.trim() || (needRef && !ref)) return
        setBusy(true); setMsg('')
        const r = await jpost('/generate/jobs', {
          kind: meta.kind, mode, model, prompt: prompt.trim(),
          refImages: needRef && ref ? [ref] : [],
          parentId: initial?.parentId || '',
        })
        setBusy(false)
        if (!r.ok) {
          const e = String(r.error || '')
          setMsg(/404|unknown POST/i.test(e) ? '宿主还没重载生成队列；重载/重启 dsh 后再试' : (e || '提交失败'))
          return
        }
        onDone?.(r.job)
        onClose?.()
      }
      return h('div', {
        'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '生成素材',
        onClick: (e) => { if (e.target === e.currentTarget && !busy) onClose?.() },
      },
        h('div', { 'data-wb-modal': '', style: { width: 'min(560px, 96%)' } },
          h('div', { 'data-wb-modal-head': '' },
            h('h3', {}, '生成素材'),
            h('button', { 'data-wb-modal-close': '', 'aria-label': '关闭', onClick: () => { if (!busy) onClose?.() } }, '✕')),
          h('div', { 'data-wb-modal-body': '' },
            h('div', { 'data-wb-row': '', style: { gap: 6, flexWrap: 'wrap' } },
              ...Object.entries(GEN_MODE_META).map(([k, v]) =>
                h('button', {
                  key: k, 'data-wb-btn': '', 'data-sm': '', 'data-primary': mode === k ? '' : undefined,
                  onClick: () => { setMode(k); if (!v.needRef) setRef('') },
                }, v.label))),
            h('div', {},
              h('div', { style: { fontSize: 12, fontWeight: 650, marginBottom: 6 } }, '一句话描述'),
              h('textarea', {
                value: prompt, rows: 4,
                onChange: (e) => setPrompt(e.target.value),
                placeholder: meta.hint,
                style: {
                  width: '100%', resize: 'vertical', padding: '10px 12px', border: '1px solid var(--wb-line2)',
                  borderRadius: 10, background: 'var(--wb-card2)', color: 'var(--wb-tx)', fontSize: 13, lineHeight: 1.65,
                },
              })),
            needRef ? h('div', {},
              h('div', { style: { fontSize: 12, fontWeight: 650, marginBottom: 6 } }, '基于哪张图'),
              h('select', {
                value: ref, onChange: (e) => setRef(e.target.value),
                style: { width: '100%', padding: '9px 10px', border: '1px solid var(--wb-line2)', borderRadius: 9, background: 'var(--wb-card2)', color: 'var(--wb-tx)' },
              },
                h('option', { value: '' }, imgs.loading ? '读图片…' : '选一张 AI 图片'),
                !hasRefOption && ref ? h('option', { value: ref }, refFile) : null,
                ...items.map((it) => h('option', { key: it.file, value: `generated/images/${it.file}` }, it.title || it.file)))) : null,
            h('div', { 'data-wb-meta': '' },
              `将使用：${model || '未配置（去设置 → 生成服务）'} · 按设置里的默认模型生成`),
            msg ? h(Err, {}, msg) : null),
          h('div', { 'data-wb-modal-foot': '' },
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, disabled: busy, onClick: () => { if (!busy) onClose?.() } }, '取消'),
            h(Btn, {
              sm: true, primary: true,
              disabled: busy || !prompt.trim() || (needRef && !ref) || !model,
              onClick: submit,
            }, busy ? '提交中…' : '开始生成'))))
    }

    function GeneratedPane({ list, kind, onGenerate }) {
      const items = list.data?.items || []
      const [msg, setMsg] = useState('')
      const statusLabel = { draft: '草稿', adopted: '已采用', failed: '失败', interrupted: '已中断' }
      const sub = kind === 'video' ? 'videos' : 'images'
      const jobsApi = useApi('/generate/jobs?limit=40')
      const jobs = (jobsApi.data?.jobs || []).filter((j) => j.kind === kind)
      // 宿主还没重载时没有这个路由：404 只代表任务条暂不可用，不该把整个 tab 染红
      const jobsErr = jobsApi.err && !/404|unknown GET/i.test(String(jobsApi.err)) ? jobsApi.err : ''
      const active = jobs.some((j) => ['queued', 'running'].includes(j.status))
      usePoll(jobsApi.reload, 3000, active)
      usePoll(list.reload, 5000, active)
      const cancelJob = async (j) => {
        const r = await jpost(`/generate/jobs/${j.id}/cancel`)
        if (!r.ok) setMsg(r.error || '取消失败')
        jobsApi.reload()
        setTimeout(() => list.reload(), 500)
      }
      const retryJob = async (j) => {
        const r = await jpost(`/generate/jobs/${j.id}/retry`)
        if (!r.ok) setMsg(r.error || '重试失败')
        jobsApi.reload()
      }
      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        h(Err, {}, jobsErr),
        list.loading ? h('div', { 'data-wb-loading': '' }, `读 AI ${kind === 'video' ? '视频' : '图片'}…`) : null,
        h(GenJobStrip, { jobs, onCancel: cancelJob, onRetry: retryJob }),
        !list.loading && !items.length ? h(Empty, {
          icon: kind === 'video' ? '🎞️' : '🖼️',
          title: `还没有 AI 生成${kind === 'video' ? '视频' : '图片'}`,
          hint: `点右上角「生成${kind === 'video' ? '视频' : '图片'}」，写一句话就能开始。`,
        }) : null,
        h('div', { 'data-wb-grid': '', style: { gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))' } },
          ...items.map((it) => h('div', { key: it.id, 'data-wb-card': '' },
            h('div', { style: { background: '#000', aspectRatio: '16/9', display: 'grid', placeItems: 'center', overflow: 'hidden' } },
              kind === 'video'
                ? h('video', {
                  src: `${API}/assets/media?path=${encodeURIComponent(`generated/${sub}/${it.file}`)}`,
                  controls: true, preload: 'none',
                  style: { width: '100%', height: '100%', objectFit: 'cover' },
                })
                : h('img', {
                  src: `${API}/assets/media?path=${encodeURIComponent(`generated/${sub}/${it.file}`)}`,
                  alt: '', loading: 'lazy',
                  style: { width: '100%', height: '100%', objectFit: 'cover' },
                })),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, it.title || it.file),
                h('span', { 'data-wb-chip': '' }, statusLabel[it.status] || it.status)),
              it.prompt ? h('div', {
                'data-wb-note': '',
                style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
              }, it.prompt) : null,
              h('div', { 'data-wb-meta': '' },
                [it.provider, it.model, it.seed !== null && it.seed !== undefined ? `seed ${it.seed}` : '',
                  it.seconds ? `${it.seconds}s` : '', dayOf(it.createdAt)].filter(Boolean).join(' · ')),
              h('div', { 'data-wb-row': '' },
                kind === 'image' ? h(Btn, {
                  sm: true, primary: true,
                  onClick: () => onGenerate?.({
                    mode: 'i2v', ref: `generated/images/${it.file}`, parentId: it.id, prompt: it.prompt || '',
                  }),
                }, '生成视频') : null,
                h(Btn, {
                  sm: true,
                  onClick: () => onGenerate?.({
                    mode: kind === 'image' ? 'i2i' : 't2v',
                    ref: kind === 'image' ? `generated/images/${it.file}` : '',
                    parentId: it.id, prompt: it.prompt || '',
                  }),
                }, kind === 'image' ? '继续改' : '再生成'),
                h(Btn, {
                  sm: true, disabled: !it.prompt,
                  onClick: async () => {
                    const ok = await copyText(it.prompt || '')
                    setMsg(ok ? '提示词已复制' : '复制失败')
                  },
                }, '复制提示词'),
                h('div', { 'data-wb-grow': '' }),
                h('span', { 'data-wb-meta': '' }, it.file)))))),
        msg ? h(Note, {}, msg) : null,
        h(Note, {}, '生成任务在后台跑，完成后自动出现在这里；视频默认 3–5 秒，失败可在任务条里重试。'))
    }

    /* ── 素材库 · 子 tab 分栏 ── */
    function TabStore() {
      const [sub, setSub] = useState('video')
      const [q, setQ] = useState('')
      const [view, setView] = useState('list')
      const [videoPage, setVideoPage] = useState(1)
      const [importOpen, setImportOpen] = useState(false)
      const [harvestOpen, setHarvestOpen] = useState(false)
      const [memePage, setMemePage] = useState(1)
      const [memePkg, setMemePkg] = useState('全部')
      const [bgmPage, setBgmPage] = useState(1)
      const [bgmMood, setBgmMood] = useState('全部')
      const [stickerPage, setStickerPage] = useState(1)
      const [uploadKind, setUploadKind] = useState('')
      const [genOpen, setGenOpen] = useState(null)
      const storeList = useApi('/store/list?limit=300')
      const voiceList = useApi(sub === 'voice' ? '/assets/voices' : '')
      const clipList = useApi(sub === 'clip' ? '/assets/clips' : '')
      const fontList = useApi(sub === 'font' ? '/assets/fonts' : '')
      const aiVideoList = useApi(sub === 'aivideo' ? '/assets/generated?kind=video' : '')
      const aiImageList = useApi(sub === 'aiimage' ? '/assets/generated?kind=image' : '')
      const memePkgQ = memePkg === '全部' ? '' : '&pkg=' + encodeURIComponent(memePkg)
      const memeList = useApi(sub === 'meme' ? `/assets/memes?page=${memePage}&pageSize=40${memePkgQ}` : '')
      const bgmMoodQ = bgmMood === '全部' ? '' : '&mood=' + encodeURIComponent(bgmMood)
      const bgmList = useApi(sub === 'bgm' ? `/assets/bgm?page=${bgmPage}&pageSize=20${bgmMoodQ}` : '')
      const stickerList = useApi(sub === 'sticker' ? `/assets/stickers?page=${stickerPage}&pageSize=60` : '')
      return h('div', { 'data-wb-page': '' },
        h('div', { 'data-wb-sticky-header': '' },
          h(PageHead, { title: '素材库', sub: '从 B 站收集的素材：AI 评级、金句片段与关键帧' },
            ...(sub === 'video'
              ? [
                h(Btn, { key: 'refresh', sm: true, onClick: storeList.reload }, '刷新'),
                h(Btn, { key: 'view', sm: true, onClick: () => setView(view === 'list' ? 'cards' : 'list') }, view === 'list' ? '卡片视图' : '列表视图'),
              ]
              : sub === 'voice'
                ? [
                  h(Btn, { key: 'import', sm: true, onClick: () => setImportOpen(true) }, '导入本地 wav'),
                  h(Btn, { key: 'harvest', sm: true, primary: true, onClick: () => setHarvestOpen(true) }, '+ 采新音色'),
                ]
                : sub === 'font'
                  ? [
                    h(Btn, { key: 'import-font', sm: true, primary: true, onClick: () => setUploadKind('font') }, '导入字体'),
                    h(Btn, { key: 'refresh', sm: true, onClick: fontList.reload }, '刷新'),
                  ]
                  : sub === 'clip'
                    ? [
                      h(Btn, { key: 'import-video', sm: true, primary: true, onClick: () => setUploadKind('video') }, '导入视频'),
                      h(Btn, { key: 'refresh', sm: true, onClick: clipList.reload }, '刷新'),
                    ]
                    : sub === 'bgm'
                      ? [
                        h(Btn, { key: 'import-audio', sm: true, primary: true, onClick: () => setUploadKind('audio') }, '导入音频'),
                        h(Btn, { key: 'refresh', sm: true, onClick: bgmList.reload }, '刷新'),
                      ]
                      : sub === 'aivideo'
                        ? [
                          h(Btn, { key: 'refresh', sm: true, onClick: aiVideoList.reload }, '刷新'),
                          h(Btn, { key: 'gen', sm: true, primary: true, onClick: () => setGenOpen({ mode: 't2v' }) }, '+ 生成视频'),
                        ]
                        : sub === 'aiimage'
                          ? [
                            h(Btn, { key: 'refresh', sm: true, onClick: aiImageList.reload }, '刷新'),
                            h(Btn, { key: 'gen', sm: true, primary: true, onClick: () => setGenOpen({ mode: 't2i' }) }, '+ 生成图片'),
                          ]
                          : [
                        h(Btn, {
                          key: 'refresh', sm: true,
                          onClick: sub === 'meme' ? memeList.reload : stickerList.reload,
                        }, '刷新'),
                      ])),
          h('div', { 'data-wb-row': '', 'data-wb-subtabs': '' },
            ...[['video', '视频'], ['voice', '音色'], ['font', '字体'], ['clip', '片段'], ['meme', '表情包'], ['bgm', 'BGM'], ['sticker', '贴纸'], ['aivideo', 'AI 视频'], ['aiimage', 'AI 图片']].map(([k, l]) =>
              h('button', { key: k, 'data-wb-btn': '', 'data-sm': '', 'data-primary': sub === k ? '' : undefined, onClick: () => setSub(k) }, l)),
            h('div', { 'data-wb-grow': '' }),
            h(Chip, {}, sub === 'video'
              ? `${storeList.data?.stats?.videos ?? '-'} 条 · ${storeList.data?.stats?.mb ?? '-'} MB`
              : sub === 'voice' ? '参考音 + 克隆音'
                : sub === 'font' ? `字体 ${fontList.data?.fonts?.length ?? 0} 个`
                : sub === 'clip' ? '片段 / 名场面'
                  : sub === 'meme' ? `表情 ${memeList.data?.total ?? 0} 个`
                    : sub === 'bgm' ? `BGM ${bgmList.data?.total ?? 0} 首`
                      : sub === 'aivideo' ? `AI 视频 ${aiVideoList.data?.items?.length ?? 0} 个`
                        : sub === 'aiimage' ? `AI 图片 ${aiImageList.data?.items?.length ?? 0} 张`
                          : `贴纸 ${stickerList.data?.total ?? 0} 个`)),
        ),
        sub === 'video' ? h('div', { 'data-wb-row': '' },
          h('input', {
            'data-wb-search': '', style: { flex: '1 1 240px', maxWidth: '420px', width: 'auto' },
            placeholder: '搜索标题、评级理由或金句', value: q,
            onChange: (e) => { setQ(e.target.value); setVideoPage(1) },
          }),
          h(Note, {}, '按标题 / 评级理由 / 金句搜索')) : null,
        sub === 'video' ? h(TabStoreVideo, { list: storeList, q, view, videoPage, setVideoPage }) : null,
        sub === 'voice' ? h(VoicePane, { importOpen, setImportOpen, harvestOpen, setHarvestOpen }) : null,
        sub === 'font' ? h(FontPane, { list: fontList, onImport: () => setUploadKind('font') }) : null,
        sub === 'clip' ? h(ClipPane, { list: clipList }) : null,
        sub === 'meme' ? h(MemePane, { list: memeList, page: memePage, setPage: setMemePage, pkg: memePkg, setPkg: setMemePkg }) : null,
        sub === 'bgm' ? h(BgmPane, { list: bgmList, page: bgmPage, setPage: setBgmPage, mood: bgmMood, setMood: setBgmMood }) : null,
        sub === 'sticker' ? h(StickerPane, { list: stickerList, page: stickerPage, setPage: setStickerPage }) : null,
        sub === 'aivideo' ? h(GeneratedPane, { list: aiVideoList, kind: 'video', onGenerate: setGenOpen }) : null,
        sub === 'aiimage' ? h(GeneratedPane, { list: aiImageList, kind: 'image', onGenerate: setGenOpen }) : null,
        h(GenerateModal, {
          open: Boolean(genOpen),
          initial: genOpen,
          onClose: () => setGenOpen(null),
          onDone: () => { aiVideoList.reload(); aiImageList.reload() },
        }),
        uploadKind ? h(UploadAssetModal, {
          kind: uploadKind,
          onClose: () => setUploadKind(''),
          onDone: () => {
            if (uploadKind === 'font') fontList.reload()
            else if (uploadKind === 'video') clipList.reload()
            else if (uploadKind === 'audio') bgmList.reload()
          },
        }) : null)
    }

    function TabStoreVideo({ list, q, view, videoPage, setVideoPage }) {
      const [open, setOpen] = useState('')
      const detail = useApi(open ? '/store/item?bv=' + encodeURIComponent(open) : '', { auto: Boolean(open) })
      useEffect(() => {
        if (!open) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape') setOpen('') }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [open])
      const rows = (list.data?.rows || []).filter((r) => {
        if (!q.trim()) return true
        const k = q.trim().toLowerCase()
        return [r.title, r.up?.name, r.judge?.why, ...(r.quotes || []).map((x) => x.text)]
          .some((s) => String(s || '').toLowerCase().includes(k))
      })
      // 客户端分页：数据已全量在手，每页 20 条
      const vTotal = rows.length
      const vPages = Math.max(1, Math.ceil(vTotal / 20))
      const vPage = Math.min(videoPage, vPages)
      const pagedRows = rows.slice((vPage - 1) * 20, vPage * 20)
      const rec = detail.data?.record
      const sub = detail.data?.subtitles

      return h('div', { 'data-wb-page': '' },
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读素材库…') : null,
        !list.loading && !rows.length ? h(Empty, {
          icon: q.trim() ? '🔍' : '📚',
          title: q.trim() ? '没搜到' : '素材库还是空的',
          hint: q.trim() ? '换个词试试，或者清空搜索框看全部。' : '去「刷 B 站」采几条，或在视频卡片上点「拆解视频」。',
        }) : null,

        view === 'list'
          ? h('div', { 'data-wb-store-grid': '' }, ...pagedRows.map((r) => h(StoreRow, {
            key: r.bvid, r,
            onDetail: (bv) => setOpen(bv),
          })))
          : h('div', { 'data-wb-grid': '' }, ...pagedRows.map((r) => h('div', { key: r.bvid, 'data-wb-card': '' },
            h('div', { 'data-wb-cover': '' },
              h('img', { src: API + '/store/media?kind=cover&bv=' + r.bvid, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } }),
              r.judge?.tier ? h(Tier, { t: r.judge.tier }) : null,
              r.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(r.duration)) : null),
            h('div', { 'data-wb-body': '' },
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '', style: { flex: 1 } }, r.title || '(无标题)'),
                r.commented ? h('span', { 'data-wb-chip': '', 'data-ok': '' }, '已评论') : null),
              h('div', { 'data-wb-meta': '' }, [r.up?.name, `${(r.quotes || []).length} 条片段`].filter(Boolean).join(' · ')),
              (r.quotes || [])[0] ? h('div', { 'data-wb-note': '' }, `${mmss(r.quotes[0].t)}「${String(r.quotes[0].text).slice(0, 26)}」`) : null,
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, onClick: () => setOpen(r.bvid) }, '查看详情')))))),

        vTotal > 20 ? h(Pager, { page: vPage, total: vTotal, pageSize: 20, onChange: setVideoPage }) : null,
        open ? h('div', {
          'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '素材详情',
          onClick: (e) => { if (e.target === e.currentTarget) setOpen('') },
        },
          h('div', { 'data-wb-modal': '' },
            h('div', { 'data-wb-modal-head': '' },
              h('div', { 'data-wb-grow': '' },
                h('h3', {}, rec?.title || '素材详情'),
                rec ? h('div', { 'data-wb-meta': '', style: { marginTop: 4 } },
                  [rec.up?.name, fmtDur(rec.duration), dayOf(rec.fetchedAt)].filter(Boolean).join(' · ')) : null),
              h('button', {
                'data-wb-modal-close': '', 'aria-label': '关闭详情', onClick: () => setOpen(''),
              }, '✕')),
            h('div', { 'data-wb-modal-body': '' },
              detail.loading ? h('div', { 'data-wb-loading': '' }, '读取详情…') : null,
              detail.err ? h(Err, {}, detail.err) : null,
              rec ? [
                h('div', { 'data-wb-detail-hero': '' },
                  h('div', { 'data-wb-detail-cover': '' },
                    h('img', {
                      src: API + '/store/media?kind=cover&bv=' + rec.bvid, alt: '', loading: 'lazy',
                      onError: (e) => { e.target.style.display = 'none' },
                    }),
                    rec.duration ? h('span', { 'data-wb-dur': '' }, fmtDur(rec.duration)) : null),
                  h('div', { 'data-wb-col': '', style: { gap: 8 } },
                    h('div', { 'data-wb-row': '' },
                      rec.judge ? h(Tier, { t: rec.judge.tier }) : null,
                      rec.commented ? h('span', { 'data-wb-chip': '', 'data-ok': '' }, '已评论') : null),
                    rec.judge ? h('div', { 'data-wb-why': '' }, rec.judge.why || '还没有 AI 评级') : null,
                    h('div', { 'data-wb-detail-stats': '' },
                      h('span', {}, '播放 ', h('b', {}, fmtNum(rec.stat?.view))),
                      h('span', {}, '点赞 ', h('b', {}, fmtNum(rec.stat?.like))),
                      h('span', {}, '片段 ', h('b', {}, (rec.quotes || []).length)),
                      h('span', {}, '时长 ', h('b', {}, fmtDur(rec.duration)))))),
                h('div', { 'data-wb-detail-grid': '' },
                  h('section', { 'data-wb-detail-section': '' },
                    h('h4', {}, `可用片段 · ${(rec.quotes || []).length}`),
                    (rec.quotes || []).length
                      ? h('div', { 'data-wb-quotes': '' }, ...rec.quotes.map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
                        h('b', {}, mmss(x.t)), x.text,
                        x.kind ? h('span', { 'data-wb-meta': '', style: { marginLeft: '6px' } }, `· ${x.kind}`) : null)))
                      : h('div', { 'data-wb-note': '' }, '暂无可用片段：没有字幕，或信息量不足。')),
                  h('section', { 'data-wb-detail-section': '' },
                    h('h4', {}, `热梗 · ${(rec.memes || []).length}`),
                    (rec.memes || []).length
                      ? h('div', { 'data-wb-note': '' }, rec.memes.slice(0, 8).join(' · '))
                      : h('div', { 'data-wb-note': '' }, '没有抽到热梗。'),
                    h('h4', { style: { marginTop: 12 } }, '热门弹幕'),
                    (rec.hotDanmaku || []).length
                      ? h('div', { 'data-wb-danmaku-list': '' }, ...rec.hotDanmaku.slice(0, 8).map((x, i) => h('span', { key: i, 'data-wb-danmaku': '' }, x.text, h('b', {}, x.count))))
                      : h('div', { 'data-wb-note': '' }, '没有热门弹幕。'))),
                h('section', { 'data-wb-detail-section': '' },
                  h('h4', {}, `热评 · ${(rec.hotComments || []).length}`),
                  (rec.hotComments || []).length
                    ? h('div', {}, ...rec.hotComments.slice(0, 6).map((x, i) => h('div', { key: i, 'data-wb-comment-row': '' },
                      h('b', {}, `${x.user || '匿名'} · ${fmtNum(x.like)} 赞`), h('br'), String(x.text || '').slice(0, 180))))
                    : h('div', { 'data-wb-note': '' }, '没有热评。')),
                (rec.frames || []).length ? h('section', { 'data-wb-detail-section': '' },
                  h('h4', {}, '关键帧'),
                  h('div', { 'data-wb-detail-frames': '' }, ...rec.frames.slice(0, 6).map((f, i) => h('img', {
                    key: i,
                    src: `${API}/store/media?kind=frame&bv=${rec.bvid}&name=${encodeURIComponent(String(f.file || '').split('/').pop())}`,
                    alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' },
                  })))) : null,
                sub?.items?.length ? h('section', { 'data-wb-detail-section': '' },
                  h('h4', {}, `逐字稿（共 ${sub.total} 句，显示前 ${sub.items.length}）`),
                  h('pre', { 'data-wb-pre': '' }, sub.items.map((x) => `${mmss(x.from)} ${x.content}`).join(String.fromCharCode(10)))) : null,
              ] : null),
            h('div', { 'data-wb-modal-foot': '' },
              h('span', { 'data-wb-meta': '' }, rec
                ? `${(rec.quotes || []).length} 条金句 · ${(rec.memes || []).length} 个热梗 · ${(rec.hotComments || []).length} 条热评`
                : ''),
              h('div', { 'data-wb-grow': '' }),
              rec ? h('a', {
                'data-wb-btn': '', 'data-sm': '', target: '_blank', rel: 'noreferrer',
                href: rec.url || ('https://www.bilibili.com/video/' + rec.bvid),
              }, '打开原视频') : null,
              h(Btn, { sm: true, primary: true, onClick: () => setOpen('') }, '关闭')))) : null)
    }

    /* ═══════════════════ ② 刷 B 站 ═══════════════════ */
    /** 评论 / 回复 / 私信共用：先生成草稿，再看原文，再决定预演（不真发）还是正式发送 */
    function InteractComposer({ kind, target, onClose, onSent }) {
      const [text, setText] = useState('')
      const [gen, setGen] = useState(true)
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [tech, setTech] = useState('')
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
          setDump(r.dryRun ? '✅ 已预演发送，未真的发出去' : '✅ 已发送')
          setTech([((r.command || []).join(' ')), (r.data ? JSON.stringify(r.data, null, 2) : '')].filter(Boolean).join('\n'))
          if (!r.dryRun) onSent?.()
        } else {
          setDump('❌ 失败：' + firstLine(errText(r)))
          setTech('')
        }
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
            h('span', {}, '正式发送（不勾=只预演，不会真的发出去）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, primary: true, disabled: gen || busy === 'send' || !text.trim(), onClick: send }, busy === 'send' ? '发送中…' : '发送'),
          h(Btn, { sm: true, disabled: gen || busy === 'p', onClick: async () => { setBusy('p'); await genText(); setBusy('') } }, '重新生成')),
        dump ? h('div', { 'data-wb-okmsg': dump.startsWith('✅') ? '' : undefined, 'data-wb-err': dump.startsWith('❌') ? '' : undefined }, dump) : null,
        dump ? h(TechDetails, { text: tech }) : null)
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
            commented ? h('span', { 'data-wb-chip': '', 'data-ok': '' }, '已评论') : null,
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => onComment(it) }, '评论'),
            h(Btn, { sm: true, primary: true, onClick: () => onWatch(bv) }, '拆解视频'),
            h(Btn, { sm: true, onClick: () => window.open(it.url || ('https://www.bilibili.com/video/' + bv), '_blank') }, '打开'))))
    }

    function SubVideo({ storeMap, cfg, onCommented, searchKey, items, loading, err }) {
      const [detail, setDetail] = useState('')
      const [comment, setComment] = useState(null)
      const watch = useApi(detail ? '/video?bv=' + encodeURIComponent(detail) : '', { auto: Boolean(detail) })
      const d = watch.data?.data
      useEffect(() => {
        if (!detail) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape') setDetail('') }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [detail])
      const openComment = (it) => {
        const rec = storeMap[it.bvid] || {}
        setComment({
          label: it.title || it.bvid,
          ctx: { title: it.title || '', up: it.author?.name || it.up?.name || '', quotes: rec.quotes || [] },
          ids: { bv: it.bvid },
        })
      }
      return h('div', { 'data-wb-col': '' },
        comment ? h(InteractComposer, {
          key: comment.ids?.bv || 'comment',
          kind: 'comment', target: comment,
          onClose: () => setComment(null),
          onSent: () => { setComment(null); onCommented?.() },
        }) : null,
        h(Err, {}, err),
        loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        detail ? h('div', {
          'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '视频拆解',
          onClick: (e) => { if (e.target === e.currentTarget) setDetail('') },
        },
          h('button', { className: 'x', onClick: () => setDetail('') }, '✕'),
          h('div', { 'data-wb-modal': '' },
            watch.loading ? h('div', { 'data-wb-loading': '' }, '读取视频…') : null,
            watch.err ? h(Err, {}, watch.err) : null,
            d ? [
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '' }, d.title || detail),
                h('div', { 'data-wb-grow': '' }),
                h(Btn, { sm: true, onClick: () => setDetail('') }, '收起')),
              h('div', { 'data-wb-meta': '' }, [d.owner?.name, d.stat ? `播放 ${fmtNum(d.stat.view)} · 点赞 ${fmtNum(d.stat.like)}` : '', fmtDur(d.duration)].filter(Boolean).join(' · ')),
              d.ai_summary ? h('div', { 'data-wb-why': '' }, d.ai_summary) : null,
              d.transcript?.text ? h('pre', { 'data-wb-pre': '' }, String(d.transcript.text).slice(0, 2500)) : h(Note, {}, '这条没有字幕；已落库，但创作时引用不到原句。'),
            ] : null)) : null,
        h('div', { 'data-wb-row': '' }, h(Note, {}, searchKey ? `搜索：${searchKey}` : '综合热门 · 按播放排序')),
        h('div', { 'data-wb-grid': '' }, ...items.map((it) => h(VideoCard, {
          key: it.bvid, it,
          tier: storeMap[it.bvid]?.tier || '',
          commented: Boolean(storeMap[it.bvid]?.commented),
          onWatch: setDetail,
          onComment: openComment,
        }))),
        !loading && !items.length ? h(Note, {}, searchKey ? '没搜到，换个词' : '热门拉不到（看看 bili 是否登录）') : null)
    }

    function SubInbox({ onCommented, cfg, inbox }) {
      const cfgRes = useApi('/config')
      const cfgLoc = cfgRes.data?.config || cfg
      const ownerTasks = useApi('/owner/tasks')
      const [composer, setComposer] = useState(null)
      const [taskOpen, setTaskOpen] = useState('')
      const [taskMsg, setTaskMsg] = useState('')
      const items = inbox.data?.items || []
      const c = inbox.data?.counts || {}
      const ownerUid = String(cfg?.ownerUid || '')
      const isOwner = (m) => Boolean(ownerUid && m.user?.mid && String(m.user.mid) === ownerUid)
      const taskStatus = (t) => ({ done: '完成', failed: '失败', stored: '已记录', chat: '已回复', 'need-bv': '等 BV' }[t.status] || t.status || '?')
      const taskDelivery = (t) => (t.delivery || []).map((x) => ({ comment: '评论', dm: '私信', stored: '仅记录' }[x] || x)).join(' + ') || '仅记录'
      const checkOwner = async () => {
        setTaskMsg('检查 @ 中…（看视频 + 总结，可能要半分钟）')
        const r = await jpost('/owner/check')
        setTaskMsg(r.ok ? '检查完了' : '检查失败：' + String(r.log || '').slice(-200))
        ownerTasks.reload()
      }
      const task = (ownerTasks.data?.tasks || []).find((t) => t.id === taskOpen)

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
        h(Note, {}, '默认由 AI 写草稿；发出前一定先给你看原文，默认只预演，不会真的发出去。'),
        h('div', { 'data-wb-sec': '' },
          h('div', { 'data-wb-row': '' },
            h('b', {}, '主人请求'),
            h('span', { 'data-wb-meta': '' }, `主人在评论区 @ 它看视频 / 看评论 / 要总结 · 自动检查 ${cfg?.ownerTasksEnabled === false ? '关' : '开'}`),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: checkOwner }, '立即检查 @')),
          h(Note, {}, '长内容默认私信交付，不塞评论区；说「别发评论区」就只私信，说「回评论区」就压成 ≤45 字。'),
          taskMsg ? h(Note, {}, taskMsg) : null,
          ...(ownerTasks.data?.tasks || []).slice(0, 6).map((t) => h('div', { key: t.id, 'data-wb-row': '' },
            h(Chip, { ok: t.status === 'done' }, taskStatus(t)),
            h('b', {}, t.title || t.bvid || '主人请求'),
            h('span', { 'data-wb-meta': '' }, `${dayOf(t.at)} · ${taskDelivery(t)}`),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => setTaskOpen(t.id) }, '查看'))),
          !(ownerTasks.data?.tasks || []).length ? h(Note, {}, '还没有主人请求。在主人在视频评论里 @ 它，这里会出现。') : null),
        task ? h('div', { 'data-wb-overlay': '', onClick: (e) => { if (e.target === e.currentTarget) setTaskOpen('') } },
          h('button', { className: 'x', onClick: () => setTaskOpen('') }, '✕'),
          h('div', { 'data-wb-sec': '', style: { width: 'min(860px, 96%)', maxHeight: '88%', overflow: 'auto', margin: 0 } },
            h('div', { 'data-wb-row': '' },
              h('b', {}, task.title || task.bvid || '主人请求'),
              h('div', { 'data-wb-grow': '' }),
              h(Chip, { ok: task.status === 'done' }, taskStatus(task))),
            h('div', { 'data-wb-meta': '' }, [dayOf(task.at), task.bvid, task.mode, taskDelivery(task)].filter(Boolean).join(' · ')),
            h('div', { 'data-wb-why': '' }, '主人说：' + String(task.message || '')),
            h('pre', { 'data-wb-pre': '' }, task.summary || task.short || task.error || '（没有内容）'),
            task.error ? h(Note, {}, '错误：' + task.error) : null)) : null,
        h(Err, {}, inbox.err),
        inbox.loading ? h('div', { 'data-wb-loading': '' }, '读取中…') : null,
        composer ? h(InteractComposer, {
          key: composer.kind + (composer.ids?.rpid || composer.ids?.uid || composer.label || ''),
          kind: composer.kind, target: composer,
          onClose: () => setComposer(null),
          onSent: () => { setComposer(null); inbox.reload(); onCommented?.() },
        }) : null,
        !inbox.loading && !items.length ? h(Empty, {
          icon: '💬',
          title: '没有新消息',
          hint: inbox.data?.note || '有人回复、@ 你或私信你时，会出现在这里。',
        }) : null,
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
      const canonRes = useApi('/canon/state')
      const voiceAssets = useApi('/assets/voices')
      const cfg = cfgRes.data?.config
      const sched = cfgRes.data?.schedule || {}
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState('')
      const [genMsg, setGenMsg] = useState('')
      const [genBusy, setGenBusy] = useState('')
      const [llmMsg, setLlmMsg] = useState('')
      const [llmBusy, setLlmBusy] = useState('')
      const [llmModels, setLlmModels] = useState(null)
      usePoll(voiceAssets.reload, 10000, true)

      useEffect(() => {
        if (cfg && draft === null) {
          setDraft({
            ...cfg,
            keywordsText: (cfg.keywords || []).join('\n'),
            modelChainText: (cfg.modelChain || []).join('\n'),
            visionChainText: (cfg.visionChain || []).join('\n'),
            ownerUidsText: (cfg.ownerUids || []).join('\n'),
            tagsText: (cfg.defaultTags || []).join(','),
            mentions: (cfg.mentions || []).map((m) => ({ ...m })),
          })
        }
      }, [cfg, draft])

      // 脏检查：draft 还原成 config 形状后与服务器 cfg 深比较，有未保存修改时亮橙点
      // 注意：必须在上方提前 return 之前调用（Hook 不能放在条件 return 之后）
      const dirty = useMemo(() => {
        if (!cfg || !draft) return false
        try {
          const d = { ...draft }
          d.keywords = String(d.keywordsText || '').split('\n').map((s) => s.trim()).filter(Boolean)
          d.modelChain = String(d.modelChainText || '').split('\n').map((s) => s.trim()).filter(Boolean)
          d.visionChain = String(d.visionChainText || '').split('\n').map((s) => s.trim()).filter(Boolean)
          d.ownerUids = String(d.ownerUidsText || '').split('\n').map((s) => s.trim()).filter(Boolean)
          d.defaultTags = String(d.tagsText || '').split(',').map((s) => s.trim()).filter(Boolean)
          delete d.keywordsText; delete d.modelChainText; delete d.visionChainText; delete d.ownerUidsText; delete d.tagsText
          return JSON.stringify(d) !== JSON.stringify(cfg)
        } catch { return false }
      }, [draft, cfg])

      if (cfgRes.loading || !draft) return h('div', { 'data-wb-loading': '' }, '读设置中…')

      const set = (k, v) => setDraft({ ...draft, [k]: v })
      const setMention = (i, k, v) => setDraft({
        ...draft,
        mentions: (draft.mentions || []).map((m, idx) => (idx === i ? { ...m, [k]: v } : m)),
      })
      const addMention = () => setDraft({ ...draft, mentions: [...(draft.mentions || []), { target: '', call: '' }] })
      const delMention = (i) => setDraft({ ...draft, mentions: (draft.mentions || []).filter((_, idx) => idx !== i) })
      const save = async () => {
        setBusy('save'); setMsg('保存中…')
        const r = await jpost('/config', {
          enabled: draft.enabled, scheduleRanges: draft.scheduleRanges, perDay: draft.perDay,
          keywords: String(draft.keywordsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          llmKey: draft.llmKey,
          personaPrompt: draft.personaPrompt, reportLevel: draft.reportLevel, favFolderId: draft.favFolderId,
          memoryEnabled: draft.memoryEnabled !== false,
          selfVideosEnabled: draft.selfVideosEnabled !== false,
          selfVideosUrl: draft.selfVideosUrl || '',
          selfVideosRefreshHours: draft.selfVideosRefreshHours,
          autoComment: draft.autoComment, autoReply: draft.autoReply,
          ownerUid: draft.ownerUid, ownerCall: draft.ownerCall,
          ownerTasksEnabled: draft.ownerTasksEnabled !== false,
          ownerTaskPollMinutes: draft.ownerTaskPollMinutes,
          ownerTaskPerDay: draft.ownerTaskPerDay,
          ownerTaskAllowDm: draft.ownerTaskAllowDm !== false,
          ownerTaskMaxAgeHours: draft.ownerTaskMaxAgeHours,
          ownerUids: String(draft.ownerUidsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          publicMentionsEnabled: draft.publicMentionsEnabled !== false,
          publicMentionPerDay: draft.publicMentionPerDay,
          mentionVision: draft.mentionVision !== false,
          mentionName: draft.mentionName, mentions: (draft.mentions || []).filter((m) => String(m.target || '').trim()),
          replyPerDay: draft.replyPerDay,
          dmWatch: draft.dmWatch, dmWatchMinutes: draft.dmWatchMinutes,
          voice: draft.voice, modelChain: String(draft.modelChainText || '').split('\n').map((s) => s.trim()).filter(Boolean),
          visionChain: String(draft.visionChainText || '').split('\n').map((s) => s.trim()).filter(Boolean),
        })
        setBusy('')
        if (r.ok) {
          setMsg('已保存')
          setDraft({ ...r.config, keywordsText: (r.config.keywords || []).join('\n'), modelChainText: (r.config.modelChain || []).join('\n'), visionChainText: (r.config.visionChain || []).join('\n'), tagsText: (r.config.defaultTags || []).join(',') })
          cfgRes.reload(); onSaved?.()
        } else setMsg('保存失败：' + (errText(r) || ''))
      }
      const run = async () => {
        setBusy('run'); setMsg('跑一轮中…（采集 + 判定 + 抽句 / 弹幕 / 热梗 / 热评 + 日报，可能一两分钟）')
        const r = await jpost('/run-round')
        setBusy('')
        setMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : '跑失败：' + (errText(r) || ''))
      }
      const refreshCanon = async () => {
        setBusy('canon'); setMsg('拉取合集…')
        const r = await jpost('/canon/refresh', { url: draft.selfVideosUrl || '' })
        setBusy('')
        if (r.ok) {
          setMsg(`已更新《${r.status?.title || ''}》· ${r.status?.epCount || 0} 集`)
          canonRes.reload()
          cfgRes.reload()
        } else setMsg('拉取失败：' + (errText(r) || r.error || ''))
      }

      return h('div', { 'data-wb-settings-layout': '' },
        h('aside', { 'data-wb-settings-side': '' },
          h('div', { 'data-wb-sec': '', 'data-wb-settings-summary': '' },
            h('h3', {}, '当前状态'),
            h('div', { 'data-wb-summary-row': '' }, h('span', {}, '定时采集'), h('b', {}, draft.enabled ? '开' : '关')),
            h('div', { 'data-wb-summary-row': '' }, h('span', {}, '每天上限'), h('b', {}, `${draft.perDay || 48} 条`)),
            h('div', { 'data-wb-summary-row': '' }, h('span', {}, '上次采集'), h('b', {}, sched.lastRunAt ? new Date(sched.lastRunAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—')),
            h('div', { 'data-wb-summary-row': '' }, h('span', {}, '模型链'), h('b', {}, `${String(draft.modelChainText || '').split(String.fromCharCode(10)).filter(Boolean).length} 个`)),
            h('div', { 'data-wb-summary-row': '' }, h('span', {}, '长期记忆'), h('b', {}, draft.memoryEnabled === false ? '关' : '开'))),
          h('nav', { 'data-wb-settings-nav': '' },
            ...[['set-schedule', '定时采集'], ['set-persona', '人设与偏好'], ['set-interact', '互动'], ['set-models', '模型顺序'], ['set-generation', '生成服务']].map(([id, label], i) =>
              h('button', {
                key: id, 'data-sel': i === 0 ? '' : undefined,
                onClick: (ev) => {
                  const nav = ev.currentTarget.parentElement
                  if (nav) [...nav.querySelectorAll('button')].forEach((b) => b.toggleAttribute('data-sel', b === ev.currentTarget))
                  const el = document.getElementById(id)
                  const main = document.querySelector('[data-wb-main]')
                  const head = document.querySelector('[data-wb-sticky-header]')
                  if (!el || !main) return
                  const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - (head?.offsetHeight || 0) - 12
                  main.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
                },
              }, label))),
          h(Note, {}, '改完点底部「保存设置」。切换分组不会丢失未保存内容。')),
        h('div', { 'data-wb-settings-main': '' },
          h(Sec, { id: 'set-schedule', title: '定时采集' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.enabled), onChange: (e) => set('enabled', e.target.checked) }),
              h('span', {}, '开启定时采集')),
            h(Field, { label: '时段' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '240px' }, value: draft.scheduleRanges, onChange: (e) => set('scheduleRanges', e.target.value) }),
              h(Note, {}, '全天写 00:00-24:00；可多段，如 09:00-12:00, 20:00-23:30')),
            h(Field, { label: '每天上限' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 500, value: draft.perDay, onChange: (e) => set('perDay', e.target.value) }),
              h('span', {}, '条')),
            h(Field, { label: '来源' },
              h('span', {}, '综合热门 + 关注关键词（按时间自动混合）')),
            h(Note, {}, `今天已采 ${sched.todayCount ?? '?'} / 目标 ${sched.target ?? '?'} 条 · ${sched.inWindow === false ? '不在时段内' : '在时段内'}${sched.estMinutes ? ` · 约每 ${sched.estMinutes} 分钟 1 条` : ''} · 每条约 10 帧由 AI 挑`),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, disabled: busy === 'run', onClick: run }, busy === 'run' ? '跑一轮中…' : '立即跑一轮'),
              h(Note, {}, '不等定时，现在就采一轮'))),

          h(Sec, { id: 'set-persona', title: '人设与偏好' },
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '关注关键词（一行一个；和视频页标签同步，采集时与热门混合）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 4, value: draft.keywordsText, onChange: (e) => set('keywordsText', e.target.value) })),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '人设（判定 / 方案 / 评论都用它）'),
              h('textarea', { 'data-wb-input': '', 'data-area': '', rows: 6, value: draft.personaPrompt || '', onChange: (e) => set('personaPrompt', e.target.value), placeholder: '例：叫我老弟，说话像贴吧老哥，犀利不客气，控制在 40 字内' })),
            h('div', { 'data-wb-col': '' },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', 'data-wb-act': 'memory-toggle', checked: draft.memoryEnabled !== false, onChange: (e) => set('memoryEnabled', e.target.checked) }),
                h('span', {}, '开启长期记忆：评论、回复、出方案时自动参考你的偏好和历史')),
              h(Note, {}, '人设决定「它是谁」，长期记忆决定「它记不记得住」。记了什么、删掉哪条，去「我的 → 记忆」看。')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '自己的视频（B站合集）'),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.selfVideosEnabled !== false, onChange: (e) => set('selfVideosEnabled', e.target.checked) }),
                h('span', {}, '把合集里的日常短片当身份背景，评论 / 回复 / 方案可以自然引用')),
              h('div', { 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '460px' }, value: draft.selfVideosUrl || '',
                  onChange: (e) => set('selfVideosUrl', e.target.value),
                  placeholder: 'https://space.bilibili.com/<UID>/lists/<合集ID>',
                }),
                h(Btn, { sm: true, disabled: busy === 'canon', onClick: refreshCanon }, busy === 'canon' ? '拉取中…' : '更新合集')),
              h(Note, {}, canonRes.data?.ok
                ? `已缓存《${canonRes.data.title}》${canonRes.data.epCount} 集 · ${canonRes.data.fetchedAt ? new Date(canonRes.data.fetchedAt).toLocaleString('zh-CN') : ''}`
                : '还没缓存：填合集链接后点「更新合集」'),
              h(Note, {}, '只取最近和相关几条放进提示词，不写进记忆；之后每 6 小时自动检查是否过期。')),
            h(Field, { label: '日报粒度' },
              h('select', { 'data-wb-input': '', style: { width: '120px' }, value: draft.reportLevel, onChange: (e) => set('reportLevel', e.target.value) },
                h('option', { value: 'full' }, '完整'),
                h('option', { value: 'brief' }, '薄版'),
                h('option', { value: 'off' }, '不写'))),
            h(Field, { label: '自动收藏到' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.favFolderId || '', onChange: (e) => set('favFolderId', e.target.value), placeholder: '收藏夹 ID / 名称（留空不收藏）' }))),

          h(Sec, { id: 'set-interact', title: '互动' },
            h(Field, { label: '主人 UID' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '180px' }, value: draft.ownerUid || '', onChange: (e) => set('ownerUid', e.target.value), placeholder: '例如 123456789（你的 UID）' }),
              h(Note, {}, '只有这个 UID 的指令会被当主人；其他人问统计/配置会收到一句礼貌拒绝，不会拿到数据')),
            h(Field, { label: '其它主人 UID' },
              h('textarea', {
                'data-wb-input': '', 'data-area': '', rows: Math.max(2, (draft.ownerUidsText || '').split('\n').length),
                value: draft.ownerUidsText || '', onChange: (e) => set('ownerUidsText', e.target.value),
                placeholder: '一行一个（多账号：大号 / 小号 / 家人），最多 5 个',
              }),
              h(Note, {}, '这些 UID 和上面的主人 UID 一样算主人，可以 @ 它看视频、下指令。')),
            h(Field, { label: '称呼' },
              h('input', { 'data-wb-input': '', style: { maxWidth: '120px' }, value: draft.ownerCall || '', onChange: (e) => set('ownerCall', e.target.value), placeholder: '老弟' }),
              h(Note, {}, '评论里会自然称呼这个称呼')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '主人指令（看视频 / 看评论 / 要总结）'),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.ownerTasksEnabled !== false, onChange: (e) => set('ownerTasksEnabled', e.target.checked) }),
                h('span', {}, '主人在评论区 @ 它就执行')),
              h('div', { 'data-wb-row': '' },
                h('span', {}, '每'),
                h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 60, style: { width: '70px' }, value: draft.ownerTaskPollMinutes ?? 3, onChange: (e) => set('ownerTaskPollMinutes', e.target.value) }),
                h('span', {}, '分钟检查一次；每天最多'),
                h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 1, max: 50, style: { width: '70px' }, value: draft.ownerTaskPerDay ?? 10, onChange: (e) => set('ownerTaskPerDay', e.target.value) }),
                h('span', {}, '个')),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.ownerTaskAllowDm !== false, onChange: (e) => set('ownerTaskAllowDm', e.target.checked) }),
                h('span', {}, '长总结用私信发我（不塞评论区）')),
              h(Note, {}, '任务默认只私信 / 工作台，不往评论区塞；说「回评论区」才回 ≤45 字短版。私信需要先在「我的」里扫码登录 bili-cli；没登录时长内容只留在工作台。')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '别人 @ 它（公开）'),
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: draft.publicMentionsEnabled !== false, onChange: (e) => set('publicMentionsEnabled', e.target.checked) }),
                h('span', {}, '普通观众 @ 也先看视频再回答（只在评论区短答，不私信、不写记忆）')),
              h('div', { 'data-wb-row': '' },
                h('span', {}, '每天最多'),
                h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 0, max: 100, style: { width: '70px' }, value: draft.publicMentionPerDay ?? 20, onChange: (e) => set('publicMentionPerDay', e.target.value) }),
                h('span', {}, '条（0=关）')),
              h('Note', {}, '陌生人的 @ 必须带视频上下文（在那个视频下 @，或消息里有 BV/链接）才处理，避免被随便 @ 消耗额度。')),
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: draft.mentionVision !== false, onChange: (e) => set('mentionVision', e.target.checked) }),
              h('span', {}, '@ 任务抽 4 帧看画面（没有视觉模型时自动退回纯字幕）')),
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft.autoComment), onChange: (e) => set('autoComment', e.target.checked) }),
              h('span', {}, '自动评论并 @ 主人（每条视频留一条）')),
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '额外 @（可多人）'),
              h(Note, {}, `自动评论会 @ 这些人，并按「称呼」自然喊出来。B站一条评论最多 @ 3 人（含主人 UID），所以这里最多再加 ${draft.ownerUid ? 2 : 3} 个；主人 UID 会自动 @，不用重复加。`),
              ...(draft.mentions || []).map((m, i) => h('div', { key: i, 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '200px' }, value: m.target || '',
                  onChange: (e) => setMention(i, 'target', e.target.value), placeholder: 'UID 或昵称',
                }),
                h('input', {
                  'data-wb-input': '', style: { maxWidth: '130px' }, value: m.call || '',
                  onChange: (e) => setMention(i, 'call', e.target.value), placeholder: '称呼，如 爸爸',
                }),
                h(Btn, { sm: true, onClick: () => delMention(i) }, '移除'))),
              (draft.mentions || []).length < (draft.ownerUid ? 2 : 3)
                ? h('div', { 'data-wb-row': '' }, h(Btn, { sm: true, onClick: addMention }, '+ 加一个人'))
                : h(Note, {}, '已达到 3 个 @ 上限')),
            h('div', { 'data-wb-row': '', style: { marginTop: '4px' } },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.autoReply), onChange: (e) => set('autoReply', e.target.checked) }),
                h('span', {}, '有人回复就自动回（主人指令优先）'))),
            h(Field, { label: '每天最多回复' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 0, max: 200, value: draft.replyPerDay, onChange: (e) => set('replyPerDay', e.target.value) }),
              h('span', {}, '条（0=不限）')),
            h('div', { 'data-wb-row': '' },
              h('label', { 'data-wb-toggle': '' },
                h('input', { type: 'checkbox', checked: Boolean(draft.dmWatch), onChange: (e) => set('dmWatch', e.target.checked) }),
                h('span', {}, '私信监听（默认关，每')),
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', min: 3, max: 240, value: draft.dmWatchMinutes, onChange: (e) => set('dmWatchMinutes', e.target.value) }),
              h('span', {}, '分钟看一眼）'))),

          h(Sec, { id: 'set-models', title: '模型顺序' },
            h('textarea', {
              'data-wb-input': '', 'data-area': '', rows: Math.max(4, (draft.modelChainText || '').split('\n').length),
              value: draft.modelChainText, onChange: (e) => set('modelChainText', e.target.value),
            }),
            h(Note, {}, '一行一个；失败自动切换下一个，429 退避重试。连续 3 次整链失败后会停止请求上游，直到你保存模型链或点「重置熔断」。'),
            h('div', { 'data-wb-row': '' },
              h(Btn, {
                sm: true, disabled: llmBusy === 'list',
                onClick: async () => {
                  setLlmBusy('list'); setLlmMsg('拉取中…')
                  const r = await jget('/llm/models')
                  setLlmBusy('')
                  if (r.ok) {
                    setLlmModels(r.models || [])
                    setLlmMsg(`端点 ${r.base} · ${(r.models || []).length} 个模型（点下方按钮填入）`)
                  } else {
                    setLlmModels(null)
                    setLlmMsg(`拉取失败：${r.error || ''}`)
                  }
                },
              }, llmBusy === 'list' ? '拉取中…' : '从端点拉取模型'),
              h(Btn, {
                sm: true, disabled: !llmModels?.length,
                onClick: () => {
                  set('modelChainText', (llmModels || []).map((m) => m.id).join('\n'))
                  setLlmMsg('已填入全部模型，记得点保存')
                },
              }, '全部填入'),
              h(Btn, {
                sm: true, disabled: llmBusy === 'reset',
                onClick: async () => {
                  setLlmBusy('reset')
                  const r = await jpost('/llm/reset-breaker', {})
                  setLlmBusy('')
                  setLlmMsg(r.ok ? '熔断已重置，可以重新试上游' : `重置失败：${errText(r) || ''}`)
                },
              }, llmBusy === 'reset' ? '重置中…' : '重置熔断'),
              llmMsg ? h('span', { 'data-wb-note': '' }, llmMsg) : null),
            llmModels?.length
              ? h('div', { 'data-wb-kv': '' }, llmModels.map((m, i) => h('div', { key: i },
                `${m.id}${(m.modalities || []).length > 1 ? ` · ${(m.modalities || []).join('/')}` : ''}${m.reasoning ? ' · 推理' : ''}`)))
              : null,
            h('div', { 'data-wb-col': '' },
              h('div', { 'data-wb-h': '' }, '识图子智能体（独立模型链）'),
              h('textarea', {
                'data-wb-input': '', 'data-area': '', rows: Math.max(3, (draft.visionChainText || '').split('\n').length),
                value: draft.visionChainText || '', onChange: (e) => set('visionChainText', e.target.value),
              }),
              h('Note', {}, '一行一个，只放**支持图片**的模型。@ 任务会先用这条链把画面转成文字，主链只吃文字——主链轮到纯文本模型也不影响。留空用默认 5 个视觉模型。'),
              h('div', { 'data-wb-row': '' },
                h(Btn, {
                  sm: true, disabled: !llmModels?.length,
                  onClick: () => {
                    const vis = (llmModels || [])
                      .filter((m) => (m.modalities || []).includes('image'))
                      // 声明支持图但本机不可用的（地区限制等）不自动填入
                      .filter((m) => !/^crouton-/.test(m.id))
                      .map((m) => m.id)
                    set('visionChainText', vis.join('\n'))
                    setLlmMsg(`已填入 ${vis.length} 个支持图片的模型，记得点保存`)
                  },
                }, '填入可识图的模型'))),
            h(Field, { label: '默认音色' },
              h('select', { 'data-wb-input': '', style: { width: '220px' }, value: draft.voice, onChange: (e) => set('voice', e.target.value) },
                h('optgroup', { label: 'Edge TTS（普通话）' },
                  h('option', { value: 'zh-CN-YunxiNeural' }, '云希（男·青年）'),
                  h('option', { value: 'zh-CN-XiaoxiaoNeural' }, '晓晓（女·通用/新闻）'),
                  h('option', { value: 'zh-CN-XiaoyiNeural' }, '晓伊（女·年轻/卡通）'),
                  h('option', { value: 'zh-CN-YunxiaNeural' }, '云夏（少年/卡通）'),
                  h('option', { value: 'zh-CN-YunyangNeural' }, '云扬（男·新闻）'),
                  h('option', { value: 'zh-CN-YunjianNeural' }, '云健（男·体育）')),
                h('optgroup', { label: 'Edge TTS（台湾国语）' },
                  h('option', { value: 'zh-TW-HsiaoChenNeural' }, '曉臻（女·台湾）'),
                  h('option', { value: 'zh-TW-HsiaoYuNeural' }, '曉雨（女·台湾）'),
                  h('option', { value: 'zh-TW-YunJheNeural' }, '雲哲（男·台湾）')),
                h('optgroup', { label: '克隆音色（素材库）' },
                  ...(voiceAssets.data?.voices || []).map((v) => h('option', { key: v.name, value: v.name }, `${v.name}${v.hasClone ? ' · 已克隆' : ' · 参考音'}`)))),
              h(Btn, { sm: true, onClick: voiceAssets.reload }, '刷新音色'))),
          h(Sec, { id: 'set-generation', title: '生成服务' },
            h(Field, { label: '服务地址' },
              h('input', {
                'data-wb-input': '',
                value: draft.generation?.baseUrl || '',
                placeholder: 'http://127.0.0.1:30001/v1',
                onChange: (e) => setDraft({ ...draft, generation: { ...(draft.generation || {}), baseUrl: e.target.value } }),
              }),
              h(Note, {}, '本地 fal.ai 代理或任意 OpenAI 兼容端点；模型选择在创作页。')),
            h('div', { 'data-wb-row': '' },
              h(Btn, {
                sm: true, disabled: genBusy === 'conn',
                onClick: async () => {
                  setGenBusy('conn'); setGenMsg('连接中…')
                  const r = await jget('/generate/models')
                  setGenBusy('')
                  setGenMsg(r.ok ? `连接成功：${r.models?.length || 0} 个模型` : `连接失败：${r.error || ''}`)
                },
              }, genBusy === 'conn' ? '测试中…' : '测试连接'),
              h(Btn, {
                sm: true, disabled: genBusy === 'gen',
                onClick: async () => {
                  if (!window.confirm('会用最便宜的文生图模型真实生成 1 张 512×512，约 $0.003，继续？')) return
                  setGenBusy('gen'); setGenMsg('测试生成中…')
                  const r = await jpost('/generate/test', { model: 'fal-flux-schnell', confirm: true })
                  setGenBusy('')
                  setGenMsg(r.ok ? `测试成功：${r.url}` : `测试失败：${errText(r) || ''}`)
                },
              }, genBusy === 'gen' ? '测试中…' : '测试生成（约 $0.003）'),
              genMsg ? h('span', { 'data-wb-note': '' }, genMsg) : null),
            h(Note, {}, '测试连接只读 /v1/models；测试生成会真实计费，只测最便宜的文生图。')),

          h(Err, {}, cfgRes.err),
          h('div', { 'data-wb-row': '', 'data-wb-save-row': '' },
            h(Note, {}, sched.lastRunAt ? `上次：${new Date(sched.lastRunAt).toLocaleString('zh-CN')} · ${sched.lastResult || ''}` : '还没跑过'),
            h('div', { 'data-wb-grow': '' }),
            dirty ? h('span', { 'data-wb-note': '', style: { color: 'var(--wb-warn)', fontWeight: 700 } }, '● 未保存') : null,
            msg ? h('span', { 'data-wb-note': '' }, msg) : null,
            h(Btn, { primary: true, sm: true, disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存设置')),
        ))
    }

    function TabScroll() {
      const [sub, setSub] = useState('video')
      const [running, setRunning] = useState(false)
      const [runMsg, setRunMsg] = useState('')
      const cfgRes = useApi('/config')
      const store = useApi('/store/list?limit=500')
      // —— 视频子页头部状态（自 SubVideo 提升，与标题/Tab 同一个吸顶块）——
      const [q, setQ] = useState('')
      const [key, setKey] = useState('')
      const [editTags, setEditTags] = useState(false)
      const pressRef = useRef(null)
      const suppressRef = useRef(false)
      const hot = useApi(sub === 'video' && !key ? '/hot?size=24' : '', { auto: sub === 'video' && !key })
      const search = useApi(sub === 'video' && key ? `/search?q=${encodeURIComponent(key)}&size=24` : '', { auto: Boolean(key) && sub === 'video' })
      const items = key ? (search.data?.items || []) : (hot.data?.items || [])
      const itemsLoading = key ? search.loading : hot.loading
      const itemsErr = key ? search.err : hot.err
      const keywords = cfgRes.data?.config?.keywords || []
      const cancelPress = () => {
        if (pressRef.current) { clearTimeout(pressRef.current); pressRef.current = null }
      }
      const startPress = () => {
        cancelPress()
        pressRef.current = setTimeout(() => { suppressRef.current = true; setEditTags(true) }, 550)
      }
      useEffect(() => () => { if (pressRef.current) clearTimeout(pressRef.current) }, [])
      const saveKeywords = async (next) => {
        const r = await jpost('/config', { keywords: next })
        if (!r.ok) return false
        cfgRes.reload()
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
      // —— 消息子页头部状态（自 SubInbox 提升）——
      const inbox = useApi(sub === 'msg' ? '/inbox' : '')
      const inboxCfg = cfgRes.data?.config
      const c = inbox.data?.counts || {}
      const today = store.data?.stats?.videos ?? 0
      const runRound = async () => {
        setRunning(true)
        setRunMsg('跑一轮中…（采集 + 判定 + 日报，一般 1–2 分钟）')
        const r = await jpost('/run-round')
        setRunning(false)
        setRunMsg(r.ok ? `跑完了（${r.seconds}s）· 库里 ${r.stats?.videos ?? '?'} 条` : ('跑失败：' + (errText(r) || '')))
        cfgRes.reload(); store.reload()
      }
      const storeMap = useMemo(() => {
        const m = {}
        for (const r of (store.data?.rows || [])) m[r.bvid] = r
        return m
      }, [store.data])
      const keywordBar = sub === 'video' ? h('div', { 'data-wb-row': '', 'data-wb-keyword-bar': '' },
        h('span', { 'data-wb-note': '', style: { marginRight: 2 } }, '关注关键词'),
        h('span', {
          'data-wb-chip': '', 'data-sel': key ? undefined : '', style: { cursor: 'pointer' },
          onClick: () => { if (editTags) return; setKey(''); setQ('') },
        }, '热门'),
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
        h('span', {
          'data-wb-chip': '', style: { cursor: 'pointer' }, onClick: () => { if (!editTags) addKeyword() },
        }, '+ 关键词'),
        editTags ? h('span', { 'data-wb-note': '' }, '点标签右上角 × 删除 · 点空白处退出') : null) : null
      return h('div', {
        'data-wb-page': '',
        onClick: (e) => {
          if (!editTags) return
          if (e.target?.closest?.('[data-wb-tag]')) return
          setEditTags(false)
        },
      },
        h('div', { 'data-wb-sticky-header': '', 'data-wb-static': sub === 'set' ? '' : undefined },
          h(PageHead, {
            title: sub === 'msg' ? '刷 B 站 · 消息' : sub === 'set' ? '刷 B 站 · 设置' : '刷 B 站',
            sub: sub === 'msg'
              ? '未读、回复、@、私信 —— 回复先给草稿'
              : sub === 'set'
                ? '定时采集、人设、互动与模型顺序'
                : '边刷边挑：热门、搜索、消息与自动采集设置',
          },
            h('span', { 'data-wb-chip': '' }, `今日已采 ${cfgRes.data?.schedule?.todayCount ?? '?'} 条`),
            h(Btn, { sm: true, primary: true, disabled: running, onClick: runRound }, running ? '跑一轮中…' : '立即跑一轮'),
            sub === 'video' ? h(Btn, { sm: true, onClick: () => { cfgRes.reload(); store.reload() } }, '刷新') : null),
          h('div', { 'data-wb-row': '', 'data-wb-subtabs': '' },
            ...[['video', '视频'], ['msg', '消息'], ['set', '设置']].map(([k, l]) =>
              h('button', { key: k, 'data-wb-btn': '', 'data-sm': '', 'data-primary': sub === k ? '' : undefined, onClick: () => setSub(k) }, l)),
            h('div', { 'data-wb-grow': '' }),
            sub === 'video' ? h('input', {
              'data-wb-search': '', style: { flex: '1 1 180px', maxWidth: '240px', width: 'auto' }, placeholder: '搜视频、UP 或关键词（回车）', value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') setKey(q.trim()) },
            }) : null,
            sub === 'msg' ? h(Chip, {}, `回复 ${c.replies ?? 0}`) : null,
            sub === 'msg' ? h(Chip, {}, `@ ${c.mentions ?? 0}`) : null,
            sub === 'msg' ? h(Chip, {}, `私信 ${c.private_messages ?? 0}`) : null,
            sub === 'msg' ? h(Chip, {}, `赞 ${c.likes ?? 0}`) : null,
            sub === 'msg' ? h(Btn, { sm: true, onClick: async () => {
              const cur = Boolean(inboxCfg?.autoReply)
              const r = await jpost('/config', { autoReply: !cur })
              if (r && r.ok) cfgRes.reload()
            } }, `自动回复 ${inboxCfg?.autoReply ? '开' : '关'}`) : null,
            sub === 'msg' ? h(Btn, { sm: true, onClick: inbox.reload }, '刷新') : null),
          runMsg ? h(Note, {}, runMsg) : null),
        sub === 'video' ? keywordBar : null,
        sub === 'video' ? h(SubVideo, { storeMap, cfg: cfgRes.data?.config, onCommented: store.reload, searchKey: key, items, loading: itemsLoading, err: itemsErr }) : null,
        sub === 'msg' ? h(SubInbox, { onCommented: store.reload, cfg: cfgRes.data?.config, inbox }) : null,
        sub === 'set' ? h(SubSettings, { onRunRound: () => store.reload(), onSaved: cfgRes.reload }) : null)
    }

    /* ═══════════════════ ③ 创作 / 出片 ═══════════════════ */
    const BpInput = ({ label, value, onChange, area, rows = 2, placeholder, style }) => h('label', {
      style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--wb-dim2)', minWidth: 0, ...style },
    },
      h('span', {}, label),
      h(area ? 'textarea' : 'input', {
        value: value ?? '', rows: area ? rows : undefined,
        onChange: (e) => onChange(e.target.value),
        placeholder: placeholder || '',
        'data-wb-input': '', 'data-area': area ? '' : undefined,
        style: { fontSize: 12.5, resize: area ? 'vertical' : undefined },
      }))

    /* ── 创作方案蓝图：确认 / 删除 / AI 改 / 替换 / 预览 ── */
    function BlueprintPanel({ p, onClose, onChanged }) {
      const [bp, setBp] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [open, setOpen] = useState('script')
      const [instr, setInstr] = useState({})
      const [audio, setAudio] = useState('')
      const [modal, setModal] = useState(null)
      const voices = useApi('/assets/voices')
      const models = useApi('/generate/models')

      const load = async () => {
        setLoading(true)
        const r = await jget('/create/blueprint?id=' + encodeURIComponent(p.id))
        setLoading(false)
        if (r.ok) setBp(r.blueprint)
        else setMsg(errText(r) || '读取蓝图失败')
        onChanged?.()
      }
      useEffect(() => { load() }, [p.id])

      const secs = bp?.sections || []
      const get = (id) => secs.find((s) => s.id === id)
      const patch = (id, fn) => setBp((cur) => cur ? ({
        ...cur, sections: cur.sections.map((s) => s.id === id ? fn(s) : s),
      }) : cur)
      const setContent = (id, key, value) => patch(id, (s) => ({ ...s, content: { ...s.content, [key]: value } }))
      const setShot = (idx, key, value) => {
        const sb = get('storyboard')
        const shots = [...(sb?.content?.shots || [])]
        shots[idx] = { ...shots[idx], [key]: value }
        patch('storyboard', (s) => ({ ...s, content: { ...s.content, shots } }))
      }
      const setNarration = (idx, value) => setBp((cur) => {
        if (!cur) return cur
        return {
          ...cur,
          sections: cur.sections.map((s) => {
            if (s.id === 'script') {
              const lines = [...(s.content?.lines || [])]
              lines[idx] = value
              return { ...s, content: { ...s.content, lines } }
            }
            if (s.id === 'storyboard') {
              const shots = [...(s.content?.shots || [])]
              if (shots[idx]) shots[idx] = { ...shots[idx], narration: value }
              return { ...s, content: { ...s.content, shots } }
            }
            return s
          }),
        }
      })
      const removeShot = (idx) => setBp((cur) => {
        if (!cur) return cur
        return {
          ...cur,
          sections: cur.sections.map((s) => {
            if (s.id !== 'storyboard') return s
            const shots = (s.content?.shots || []).map((x, i) => i === idx ? { ...x, enabled: x.enabled === false } : x)
            return { ...s, content: { ...s.content, shots } }
          }),
        }
      })

      const save = async (quiet) => {
        if (!bp) return false
        setBusy('save')
        const r = await jpost('/create/blueprint', { id: p.id, blueprint: bp })
        setBusy('')
        if (r.ok) {
          setBp(r.blueprint)
          if (!quiet) setMsg('已保存')
          onChanged?.()
          return true
        }
        setMsg('保存失败：' + (errText(r) || ''))
        return false
      }
      const approve = async () => {
        if (!bp) return
        if (!(await save(true))) return
        setBusy('approve')
        const r = await jpost('/create/blueprint/approve', { id: p.id, blueprint: bp })
        setBusy('')
        if (r.ok) { setBp(r.blueprint); setMsg('方案已确认，可以开始渲染'); onChanged?.() }
        else setMsg('确认失败：' + (errText(r) || ''))
      }
      const toggle = (s) => {
        patch(s.id, (x) => ({ ...x, enabled: !x.enabled }))
        setMsg(s.enabled
          ? (s.core
            ? `「${s.title}」已标记不参与；它是生成核心，关掉后会拦住渲染。内容不会丢，随时可以恢复。`
            : `「${s.title}」已标记不参与，内容不会丢；记得保存。`)
          : `「${s.title}」已恢复参与；记得保存。`)
      }
      const revise = async (s) => {
        const text = String(instr[s.id] || '').trim()
        if (!text) return
        setBusy('revise:' + s.id)
        const r = await jpost('/create/blueprint/revise', { id: p.id, sectionId: s.id, instruction: text })
        setBusy('')
        if (r.ok) {
          setBp((cur) => {
            if (!cur) return cur
            return {
              ...cur,
              sections: cur.sections.map((x) => {
                if (x.id === s.id) return { ...x, content: r.content }
                if (s.id === 'script' && x.id === 'storyboard' && Array.isArray(r.content?.lines)) {
                  const shots = (x.content?.shots || []).map((row, i) => ({ ...row, narration: r.content.lines[i] ?? row.narration }))
                  return { ...x, content: { ...x.content, shots } }
                }
                if (s.id === 'storyboard' && x.id === 'script' && Array.isArray(r.content?.shots)) {
                  const lines = (x.content?.lines || []).map((line, i) => r.content.shots[i]?.narration ?? line)
                  return { ...x, content: { ...x.content, lines } }
                }
                return x
              }),
            }
          })
          setInstr({ ...instr, [s.id]: '' })
          setMsg('AI 已改「' + s.title + '」，确认后保存')
        } else setMsg('AI 改失败：' + (errText(r) || r.error || ''))
      }
      const playVoice = async () => {
        const v = get('voice')?.content
        if (!v?.voiceId) return
        setBusy('voice'); setMsg('生成试听…')
        const r = await jpost('/tts/preview', { voice: v.voiceId, text: '大家好，这是当前音色的试听。' })
        setBusy('')
        if (r.ok) {
          setAudio(`${API}/assets/media?path=${encodeURIComponent(r.path)}&t=${Date.now()}`)
          setMsg(r.note || '试听已生成')
        } else setMsg('试听失败：' + (errText(r) || r.error || ''))
      }
      const saveModels = async () => {
        const c = get('models')?.content
        if (!c) return
        setBusy('models')
        const r = await jpost('/config', { generation: { t2i: c.t2i, i2i: c.i2i, t2v: c.t2v, i2v: c.i2v } })
        setBusy('')
        setMsg(r.ok ? '模型已保存到设置' : '保存模型失败：' + (errText(r) || ''))
      }

      const summaryOf = (s) => {
        if (s.id === 'brief') return [s.content?.title, s.content?.duration ? s.content.duration + ' 秒' : '', s.content?.aspect].filter(Boolean).join(' · ')
        if (s.id === 'script') {
          const lines = s.content?.lines || []
          const voiced = lines.filter((x) => String(x || '').trim()).length
          const mode = s.content?.audioMode === 'dialogue' ? '对白' : s.content?.audioMode === 'silent' ? '静音' : '旁白'
          return `${voiced}/${lines.length} 句${mode} · ${s.content?.wordCount || 0} 字`
        }
        if (s.id === 'storyboard') return `${(s.content?.shots || []).length} 镜`
        if (s.id === 'characters') return s.content?.selected ? `已选：${s.content.selected}` : '未绑定角色（可跳过）'
        if (s.id === 'voice') return [s.content?.voiceId, s.content?.mode === 'clone' ? '克隆' : 'Edge'].filter(Boolean).join(' · ')
        if (s.id === 'assets') return `${(s.content?.picks || []).length} 条素材`
        if (s.id === 'models') return [s.content?.t2i, s.content?.i2v].filter(Boolean).join(' / ')
        if (s.id === 'compliance') return s.content?.aiDeclaration || ''
        return ''
      }

      const renderSection = (s) => {
        const c = s.content || {}
        if (s.id === 'brief') return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 } },
          h(BpInput, { label: '标题', value: c.title, onChange: (v) => setContent('brief', 'title', v) }),
          h(BpInput, { label: '副标题', value: c.subtitle, onChange: (v) => setContent('brief', 'subtitle', v) }),
          h(BpInput, { label: '角度', value: c.angle, onChange: (v) => setContent('brief', 'angle', v) }),
          h(BpInput, { label: '时长（秒）', value: c.duration, onChange: (v) => setContent('brief', 'duration', v) }),
          h(BpInput, { label: '画幅', value: c.aspect, onChange: (v) => setContent('brief', 'aspect', v) }),
          h(BpInput, { label: '平台', value: c.platform, onChange: (v) => setContent('brief', 'platform', v) }),
          h(BpInput, { label: '语言', value: c.language, onChange: (v) => setContent('brief', 'language', v) }),
          h(BpInput, { label: '语气', value: c.tone, onChange: (v) => setContent('brief', 'tone', v) }),
          h(BpInput, { label: '预算上限', value: c.budget, onChange: (v) => setContent('brief', 'budget', v) }),
          h(BpInput, { label: '一句话需求', value: c.brief, onChange: (v) => setContent('brief', 'brief', v), area: true, rows: 3, style: { gridColumn: '1/-1' } }))

        if (s.id === 'script') return h('div', { 'data-wb-col': '' },
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 } },
            h(BpInput, { label: 'Logline', value: c.logline, onChange: (v) => setContent('script', 'logline', v) }),
            h(BpInput, { label: '开场钩子', value: c.hook, onChange: (v) => setContent('script', 'hook', v) }),
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--wb-dim2)' } },
              h('span', {}, '声音方案'),
              h('select', {
                'data-wb-input': '', value: c.audioMode || 'voiceover',
                onChange: (e) => setContent('script', 'audioMode', e.target.value),
              },
                h('option', { value: 'voiceover' }, '旁白解说'),
                h('option', { value: 'dialogue' }, '角色对白（无画外音）'),
                h('option', { value: 'silent' }, '无对白（花字 / 音效）')))),
          h('div', { 'data-wb-h': '', style: { marginTop: 4 } }, '对白 / 台词（按镜，留空=这镜不配音）'),
          ...(c.lines || []).map((line, i) => h(BpInput, {
            key: i, label: `第 ${i + 1} 句`, value: line, area: true, rows: 2,
            onChange: (v) => setNarration(i, v),
          })),
          h(BpInput, { label: '屏幕文字（一行一条）', value: (c.onScreen || []).join('\n'), area: true, rows: 3, onChange: (v) => setContent('script', 'onScreen', v.split('\n').map((x) => x.trim()).filter(Boolean)) }),
          h(BpInput, { label: '收尾 CTA', value: c.cta, onChange: (v) => setContent('script', 'cta', v) }))

        if (s.id === 'storyboard') return h('div', {},
          h('div', { 'data-wb-meta': '', style: { marginBottom: 6 } }, '旁白决定配音时长；引用格式 BV号 @秒，例如 BV1xx411c7mD @12s'),
          h('div', { style: { maxHeight: 420, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 } },
            ...(c.shots || []).map((row, i) => h('div', { key: i, style: { padding: '8px 10px', border: '1px solid var(--wb-line)', borderRadius: 9, background: 'var(--wb-card2)', opacity: row.enabled === false ? .5 : 1 } },
              h('div', { 'data-wb-row': '' },
                h('b', { style: { width: 22 } }, String(i + 1)),
                h('select', {
                  'data-wb-input': '', value: row.kind || 'item', style: { width: 92 },
                  onChange: (e) => setShot(i, 'kind', e.target.value),
                }, ...['title', 'item', 'data', 'outro', 'scene', 'broll'].map((k) => h('option', { key: k, value: k }, k))),
                h('input', {
                  'data-wb-input': '', value: row.visual || '', placeholder: '画面 / 标题',
                  style: { flex: '1 1 220px' }, onChange: (e) => setShot(i, 'visual', e.target.value),
                }),
                h('input', {
                  'data-wb-input': '', type: 'number', min: 2, max: 30, value: row.duration || 4,
                  style: { width: 64 }, onChange: (e) => setShot(i, 'duration', Number(e.target.value)),
                }),
                h(Chip, { warn: row.enabled === false }, row.enabled === false ? '不参与' : '参与'),
                h(Btn, { sm: true, onClick: () => removeShot(i), title: row.enabled === false ? '恢复这一镜' : '标记为不参与' },
                  row.enabled === false ? '恢复' : '不参与')),
              h('div', { 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', value: row.narration || '', placeholder: '对白 / 台词（留空=静音）',
                  style: { flex: '1 1 300px' }, onChange: (e) => setNarration(i, e.target.value),
                }),
                h('input', {
                  'data-wb-input': '', value: row.camera || '', placeholder: '运镜',
                  style: { width: 110 }, onChange: (e) => setShot(i, 'camera', e.target.value),
                }),
                h('input', {
                  'data-wb-input': '', value: row.asset || '', placeholder: 'BV @秒',
                  style: { width: 150 }, onChange: (e) => setShot(i, 'asset', e.target.value),
                }),
                h('input', {
                  'data-wb-input': '', value: row.transition || '', placeholder: '转场',
                  style: { width: 86 }, onChange: (e) => setShot(i, 'transition', e.target.value),
                })),
              h('div', { 'data-wb-row': '' },
                h('input', {
                  'data-wb-input': '', value: row.onScreenText || '', placeholder: '花字 / 屏幕文字',
                  style: { flex: '1 1 240px' }, onChange: (e) => setShot(i, 'onScreenText', e.target.value),
                }),
                h('input', {
                  'data-wb-input': '', value: row.ui || '', placeholder: 'UI 操作（录屏时点哪里）',
                  style: { flex: '1 1 240px' }, onChange: (e) => setShot(i, 'ui', e.target.value),
                }),
                h('select', {
                  'data-wb-input': '', value: row.audio || 'silent', style: { width: 96 },
                  onChange: (e) => setShot(i, 'audio', e.target.value),
                },
                  h('option', { value: 'dialogue' }, '对白'),
                  h('option', { value: 'voiceover' }, '旁白'),
                  h('option', { value: 'sfx' }, '音效'),
                  h('option', { value: 'silent' }, '静音')))))))
        if (s.id === 'characters') {
          const items = c.items || []
          return h('div', { 'data-wb-col': '' },
            items.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(86px,1fr))', gap: 10 } },
              ...items.map((it) => h('div', {
                key: it.id, onClick: () => setContent('characters', 'selected', it.id),
                style: {
                  padding: 8, border: '2px solid ' + (c.selected === it.id ? 'var(--wb-acc)' : 'var(--wb-line)'),
                  borderRadius: 10, textAlign: 'center', cursor: 'pointer', background: 'var(--wb-card2)',
                },
              },
                it.file ? h('img', { src: `${API}/assets/media?path=${encodeURIComponent(it.file)}`, alt: '', style: { width: '100%', height: 64, objectFit: 'contain' } }) : h('div', { style: { height: 64 } }, '🎭'),
                h('div', { 'data-wb-meta': '', style: { marginTop: 4 } }, it.name || it.id)))) : h(Note, {}, '还没有角色参考图；可在 assets-src/characters/ 下添加三视图后刷新。'),
            h('div', { 'data-wb-row': '' },
              h(Btn, {
                sm: true,
                onClick: () => {
                  const it = items.find((x) => x.id === c.selected)
                  setModal({ kind: 'character', title: it?.name || '角色三视图', item: it })
                },
              }, '看三视图'),
              h('div', { 'data-wb-grow': '' }),
              h('span', { 'data-wb-meta': '' }, c.selected ? `已选 ${c.selected}` : '未绑定（可跳过）')),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 } },
              h(BpInput, { label: '画风', value: c.style, onChange: (v) => setContent('characters', 'style', v) }),
              h(BpInput, { label: '配色', value: c.palette, onChange: (v) => setContent('characters', 'palette', v) }),
              h(BpInput, { label: '字体', value: c.font, onChange: (v) => setContent('characters', 'font', v) })))
        }
        if (s.id === 'voice') {
          const edge = Object.entries(VOICES)
          const clones = voices.data?.voices || []
          return h('div', { 'data-wb-col': '' },
            h('div', { 'data-wb-row': '' },
              h('select', {
                'data-wb-input': '', value: c.voiceId || '', style: { flex: '1 1 220px' },
                onChange: (e) => {
                  const v = e.target.value
                  setContent('voice', 'voiceId', v)
                  setContent('voice', 'mode', VOICES[v] ? 'edge' : 'clone')
                },
              },
                h('optgroup', { label: 'Edge TTS' }, ...edge.map(([k, label]) => h('option', { key: k, value: k }, label))),
                h('optgroup', { label: '克隆音色' }, ...clones.map((v) => h('option', { key: v.name, value: v.name }, `${v.name}${v.hasClone ? ' · 已克隆' : ' · 参考音'}`)))),
              h(Btn, { sm: true, disabled: busy === 'voice', onClick: playVoice }, busy === 'voice' ? '生成中…' : '试听')),
            audio ? h('audio', { controls: true, autoPlay: true, src: audio, style: { width: '100%', height: 34 } }) : null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10 } },
              h(BpInput, { label: '语速', value: c.speed, onChange: (v) => setContent('voice', 'speed', v) }),
              h(BpInput, { label: '发音表 / 多音字', value: c.pronunciation, onChange: (v) => setContent('voice', 'pronunciation', v) }),
              h(BpInput, { label: 'BGM', value: c.bgm, onChange: (v) => setContent('voice', 'bgm', v) }),
              h(BpInput, { label: 'SFX', value: c.sfx, onChange: (v) => setContent('voice', 'sfx', v) }),
              h(BpInput, { label: '响度', value: c.loudness, onChange: (v) => setContent('voice', 'loudness', v) })))
        }
        if (s.id === 'assets') return h('div', { 'data-wb-col': '' },
          h('div', { 'data-wb-meta': '' }, `已选 ${(c.picks || []).length} 条；素材引用在「分镜与镜头表」里改。`),
          ...(c.picks || []).map((x, i) => h('div', { key: i, 'data-wb-row': '', style: { padding: '7px 9px', border: '1px solid var(--wb-line)', borderRadius: 8 } },
            h('b', {}, x.bv), h('span', { 'data-wb-meta': '', style: { flex: 1 } }, [x.use, x.why].filter(Boolean).join(' · ')),
            h(Btn, {
              sm: true, onClick: () => {
                const picks = (c.picks || []).filter((_, j) => j !== i)
                setContent('assets', 'picks', picks)
              },
            }, '移除'))),
          (c.missing || []).length ? h(Note, {}, '缺素材：' + c.missing.join('、')) : null,
          h(BpInput, { label: '版权 / 来源备注', value: c.notes, onChange: (v) => setContent('assets', 'notes', v), area: true, rows: 2 }))
        if (s.id === 'models') {
          const list = models.data?.models || []
          const groups = [['t2i', '文生图', 'text2image'], ['i2i', '图生图', 'image2image'], ['t2v', '文生视频', 'text2video'], ['i2v', '图生视频', 'image2video']]
          return h('div', { 'data-wb-col': '' },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 } },
              ...groups.map(([key, label, task]) => h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--wb-dim2)' } },
                h('span', {}, label),
                h('select', {
                  'data-wb-input': '', value: c[key] || '', onChange: (e) => setContent('models', key, e.target.value),
                }, ...list.filter((m) => m.task === task).map((m) => h('option', { key: m.id, value: m.id }, m.id)))))),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 } },
              h(BpInput, { label: '分辨率', value: c.resolution, onChange: (v) => setContent('models', 'resolution', v) }),
              h(BpInput, { label: 'FPS', value: c.fps, onChange: (v) => setContent('models', 'fps', v) }),
              h(BpInput, { label: '画幅', value: c.aspect, onChange: (v) => setContent('models', 'aspect', v) }),
              h(BpInput, { label: '运动强度', value: c.motion, onChange: (v) => setContent('models', 'motion', v) }),
              h(BpInput, { label: '重试预算', value: c.retryBudget, onChange: (v) => setContent('models', 'retryBudget', v) }),
              h(BpInput, { label: '预算上限', value: c.budget, onChange: (v) => setContent('models', 'budget', v) })),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, disabled: busy === 'models', onClick: saveModels }, busy === 'models' ? '保存中…' : '保存模型到设置'),
              models.loading ? h('span', { 'data-wb-meta': '' }, '读模型…') : null,
              models.data?.error ? h('span', { 'data-wb-meta': '' }, models.data.error) : null))
        }
        if (s.id === 'compliance') return h('div', { 'data-wb-col': '' },
          h(Note, {}, '合规建议保持参与：AI 声明和模型说明会随成片交付。标成不参与时内容仍保留，但不会写进方案。'),
          h(BpInput, { label: 'AI 声明', value: c.aiDeclaration, onChange: (v) => setContent('compliance', 'aiDeclaration', v) }),
          h(BpInput, { label: '模型说明', value: c.modelNote, onChange: (v) => setContent('compliance', 'modelNote', v) }),
          h(BpInput, { label: '素材版权', value: c.rights, onChange: (v) => setContent('compliance', 'rights', v) }),
          h(BpInput, { label: '隐私检查', value: c.privacy, onChange: (v) => setContent('compliance', 'privacy', v) }),
          h(BpInput, { label: '声音 / 肖像授权', value: c.consent, onChange: (v) => setContent('compliance', 'consent', v) }),
          h(BpInput, { label: 'BGM / 字体 / 贴图许可', value: c.copyright, onChange: (v) => setContent('compliance', 'copyright', v) }),
          h(BpInput, { label: '平台规则', value: c.platform, onChange: (v) => setContent('compliance', 'platform', v) }))
        return h(Note, {}, '这一节暂无编辑器')
      }

      if (loading) return h(Sec, {}, h('div', { 'data-wb-loading': '' }, '读方案蓝图…'))
      if (!bp) return h(Sec, {}, h(Err, {}, msg || '蓝图不可用'), h(Btn, { sm: true, onClick: load }, '重试'))
      return h(Sec, { title: '方案蓝图' },
        h('div', { 'data-wb-row': '' },
          h(Chip, { ok: Boolean(bp.approvedAt) }, bp.approvedAt ? '已确认' : '待确认'),
          h('span', { 'data-wb-meta': '' }, '先确认结构，再开始生成/渲染'),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, disabled: busy === 'save', onClick: () => save(false), 'data-wb-act': 'save-blueprint' }, busy === 'save' ? '保存中…' : '保存蓝图'),
          h(Btn, { sm: true, primary: true, disabled: busy === 'approve', onClick: approve, 'data-wb-act': 'confirm-blueprint' }, bp.approvedAt ? '重新确认' : '确认方案'),
          h(Btn, { sm: true, onClick: onClose }, '收起')),
        h('div', { 'data-wb-meta': '', style: { margin: '6px 0 10px' } },
          '每一节都可以标成「不参与」，内容不会丢，随时能恢复。简报 / 脚本 / 分镜 / 模型 / 合规是核心节；核心节不参与会拦住渲染。'),
        ...secs.map((s) => h('div', {
          key: s.id, 'data-wb-card': '', style: { padding: '11px 13px', marginBottom: 8, opacity: s.enabled ? 1 : .55 },
        },
          h('div', { 'data-wb-row': '' },
            h('b', { style: { fontSize: 13 } }, s.title),
            h(Chip, { warn: !s.enabled }, s.enabled ? (s.core ? '核心 · 参与' : '参与') : '不参与渲染'),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, { sm: true, onClick: () => toggle(s) }, s.enabled ? '不参与' : '恢复参与'),
            h(Btn, { sm: true, onClick: () => setOpen(open === s.id ? '' : s.id) }, open === s.id ? '收起' : '展开')),
          open === s.id ? h('div', { 'data-wb-col': '', style: { marginTop: 8 } },
            renderSection(s),
            h('div', { 'data-wb-row': '', style: { marginTop: 4 } },
              h('input', {
                'data-wb-input': '', placeholder: `让 AI 只改「${s.title}」：例如更严肃 / 缩短 / 换运镜`,
                value: instr[s.id] || '', onChange: (e) => setInstr({ ...instr, [s.id]: e.target.value }),
                style: { flex: '1 1 260px' },
              }),
              h(Btn, { sm: true, primary: true, disabled: busy === 'revise:' + s.id, onClick: () => revise(s) }, busy === 'revise:' + s.id ? '改这节中…' : 'AI 改这节'),
              (s.id === 'storyboard' || s.id === 'script' || s.id === 'assets') ? h(Btn, {
                sm: true, onClick: () => setModal({ kind: s.id, title: s.title, data: s.content }),
              }, '预览') : null)) : h('div', { 'data-wb-meta': '', style: { marginTop: 3 } }, summaryOf(s)))),
        msg ? h(Note, {}, msg) : null,
        h('div', { 'data-wb-row': '' },
          h(Btn, { sm: true, primary: true, disabled: busy === 'save', onClick: () => save(false), 'data-wb-act': 'save-blueprint' }, busy === 'save' ? '保存中…' : '保存蓝图'),
          h(Btn, { sm: true, onClick: approve, 'data-wb-act': 'confirm-blueprint' }, '确认方案'),
          h('div', { 'data-wb-grow': '' }),
          h('span', { 'data-wb-meta': '' }, bp.approvedAt ? `确认于 ${dayOf(bp.approvedAt)}` : '未确认')),
        modal ? h('div', {
          'data-wb-overlay': '', onClick: (e) => { if (e.target === e.currentTarget) setModal(null) },
        },
          h('div', { 'data-wb-modal': '', style: { width: 'min(820px,96%)' } },
            h('div', { 'data-wb-modal-head': '' },
              h('h3', {}, modal.title || '预览'),
              h('button', { 'data-wb-modal-close': '', onClick: () => setModal(null) }, '✕')),
            h('div', { 'data-wb-modal-body': '' },
              modal.kind === 'character' ? (modal.item?.refs?.length
                ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 } },
                  ...modal.item.refs.map((f) => h('img', { key: f, src: `${API}/assets/media?path=${encodeURIComponent(f)}`, alt: '', style: { width: '100%', borderRadius: 8, background: 'var(--wb-card2)' } })))
                : h(Note, {}, '这个角色只有一张参考图')) : null,
              modal.kind === 'storyboard' ? h('div', { 'data-wb-col': '' },
                ...(modal.data?.shots || []).map((x, i) => h('div', { key: i, 'data-wb-quote': '' },
                  h('b', {}, `${i + 1}. ${x.kind}`), ' ', x.visual || '',
                  h('div', { 'data-wb-meta': '' }, [x.narration, x.camera, x.asset, x.transition].filter(Boolean).join(' · '))))) : null,
              modal.kind === 'script' ? h('pre', { 'data-wb-pre': '' },
                [(modal.data?.hook ? '钩子：' + modal.data.hook : ''), ...(modal.data?.lines || []).map((x, i) => `${i + 1}. ${x}`), modal.data?.cta ? 'CTA：' + modal.data.cta : ''].filter(Boolean).join('\n')) : null,
              modal.kind === 'assets' ? h('div', { 'data-wb-col': '' },
                ...(modal.data?.picks || []).map((x, i) => h('div', { key: i, 'data-wb-quote': '' }, h('b', {}, x.bv), ' ', x.use || '', x.why ? ` — ${x.why}` : ''))) : null),
            h('div', { 'data-wb-modal-foot': '' }, h('div', { 'data-wb-grow': '' }), h(Btn, { sm: true, onClick: () => setModal(null) }, '关闭')))) : null)
    }

    /* ── 制作阶段：关键帧 → 视频 → 组合 ── */
    const PHASE_LABEL = { keyframes: '关键帧', videos: '视频', assembly: '组合' }
    function ProductionPanel({ p, onChanged, phase: phaseProp, onPhase }) {
      const [phaseState, setPhaseState] = useState('keyframes')
      const phase = phaseProp || phaseState
      const setPhase = onPhase || setPhaseState
      const [prompts, setPrompts] = useState({})
      const [motions, setMotions] = useState({})
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [preview, setPreview] = useState('')
      const api = useApi(`/create/production?id=${encodeURIComponent(p.id)}`)
      const data = api.data || {}
      const production = data.production || {}
      const rows = (data.rows || []).filter((r) => r.enabled)
      const takes = data.takes || { keyframes: {}, videos: {} }
      const jobs = data.jobs || { keyframe: [], video: [] }
      const assembly = data.assembly || { status: 'idle' }
      const approved = Boolean(data.approvedAt)
      const voiceOn = production.assembly?.voice === undefined ? (data.voice?.enabled !== false) : Boolean(production.assembly.voice)
      usePoll(api.reload, 3500, true)

      useEffect(() => {
        if (!api.data) return
        setPrompts((prev) => {
          const next = { ...prev }
          let changed = false
          for (const r of (api.data.rows || [])) {
            if (next[r.shotId] !== undefined) continue
            next[r.shotId] = api.data.production?.keyframes?.[r.shotId]?.prompt || r.prompt || r.visual || ''
            changed = true
          }
          return changed ? next : prev
        })
        setMotions((prev) => {
          const next = { ...prev }
          let changed = false
          for (const r of (api.data.rows || [])) {
            if (next[r.shotId] !== undefined) continue
            next[r.shotId] = api.data.production?.videos?.[r.shotId]?.prompt || ''
            changed = true
          }
          return changed ? next : prev
        })
      }, [api.data])

      const kfSel = (shotId) => String(production.keyframes?.[shotId]?.selectedAssetId || '')
      const vdSel = (shotId) => String(production.videos?.[shotId]?.selectedAssetId || '')
      const kfCount = rows.filter((r) => kfSel(r.shotId)).length
      const vdCount = rows.filter((r) => vdSel(r.shotId)).length
      const jobsOf = (kind, shotId) => (jobs[kind] || []).filter((j) => String(j.shotId) === String(shotId))
      const runningOf = (kind, shotId) => jobsOf(kind, shotId).some((j) => ['queued', 'running'].includes(j.status))
      const latestJob = (kind, shotId) => jobsOf(kind, shotId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]

      const savePrompts = async (kind) => {
        const key = kind === 'keyframe' ? 'keyframes' : 'videos'
        const src = kind === 'keyframe' ? prompts : motions
        const patch = { [key]: {} }
        for (const r of rows) patch[key][r.shotId] = { prompt: src[r.shotId] || '' }
        await jpost('/create/production', { id: p.id, patch })
      }
      const generateKeyframes = async (list, perShot = 1) => {
        if (!approved) return setMsg('先在「方案蓝图」里点确认，再生成关键帧')
        if (!list.length) return
        setBusy('gen-kf'); setMsg(`提交关键帧：${list.length} 镜 × ${perShot} 张…`)
        await savePrompts('keyframe')
        const r = await jpost('/create/production/keyframes', {
          id: p.id, shotIds: list.map((x) => x.shotId), perShot,
        })
        setBusy(''); setMsg(r.ok ? `已提交 ${r.jobs?.length || 0} 个关键帧任务，生成完在这里选图` : ('失败：' + (errText(r) || '')))
        api.reload(); onChanged?.()
      }
      const generateVideos = async (list) => {
        if (!approved) return setMsg('先在「方案蓝图」里点确认，再生成视频')
        if (!list.length) return
        setBusy('gen-vd'); setMsg(`提交视频：${list.length} 镜…`)
        await savePrompts('video')
        const r = await jpost('/create/production/videos', { id: p.id, shotIds: list.map((x) => x.shotId) })
        setBusy(''); setMsg(r.ok ? `已提交 ${r.jobs?.length || 0} 个视频任务；不能一次全跑，按 1 并发排队` : ('失败：' + (errText(r) || '')))
        api.reload(); onChanged?.()
      }
      const selectTake = async (kind, row, take) => {
        const key = kind === 'keyframe' ? 'keyframes' : 'videos'
        setBusy('sel:' + kind + row.shotId)
        const r = await jpost('/create/production', { id: p.id, patch: { [key]: { [row.shotId]: { selectedAssetId: take.id } } } })
        setBusy('')
        if (!r.ok) setMsg('选用失败：' + (errText(r) || ''))
        api.reload(); onChanged?.()
      }
      const cancelJob = async (j) => {
        const r = await jpost(`/generate/jobs/${j.id}/cancel`)
        if (!r.ok) setMsg(r.error || '取消失败')
        api.reload()
      }
      const retryJob = async (j) => {
        const r = await jpost(`/generate/jobs/${j.id}/retry`)
        if (!r.ok) setMsg(r.error || '重试失败')
        api.reload()
      }
      const assemble = async () => {
        setBusy('assemble'); setMsg('开始组合：配音 → 拼接 → 封面…')
        const r = await jpost('/create/production/assemble', { id: p.id, voice: voiceOn })
        setBusy('')
        setMsg(r.ok ? `组合已开始：${r.runId}` : ('失败：' + (errText(r) || '')))
        api.reload(); onChanged?.()
      }
      const cancelAssemble = async () => {
        setBusy('cancel'); setMsg('取消组合…')
        const r = await jpost('/create/production/assemble/cancel', { id: p.id, runId: assembly.runId })
        setBusy(''); setMsg(r.ok ? '已取消组合' : ('取消失败：' + (errText(r) || '')))
        api.reload()
      }
      const setVoice = async (on) => {
        await jpost('/create/production', { id: p.id, patch: { assembly: { voice: on } } })
        api.reload()
      }

      const jobLine = (kind, row) => {
        const j = latestJob(kind, row.shotId)
        if (!j) return null
        const active = ['queued', 'running'].includes(j.status)
        return h('div', { 'data-wb-row': '', style: { marginTop: 4 } },
          h(Chip, { ok: j.status === 'done', warn: j.status === 'failed' || j.status === 'interrupted' },
            `${j.status === 'done' ? '已完成' : j.status === 'running' ? '生成中' : j.status === 'queued' ? '排队中' : j.status === 'failed' ? '失败' : j.status === 'cancelled' ? '已取消' : j.status}${j.stage ? ' · ' + j.stage : ''}`),
          h('span', { 'data-wb-meta': '', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.error || j.model || ''),
          active ? h(Btn, { sm: true, onClick: () => cancelJob(j) }, '取消')
            : h(Btn, { sm: true, onClick: () => retryJob(j) }, j.status === 'done' ? '再出一版' : '重试'))
      }

      const takeGrid = (kind, row) => {
        const list = (kind === 'keyframe' ? takes.keyframes : takes.videos)[row.shotId] || []
        const selId = kind === 'keyframe' ? kfSel(row.shotId) : vdSel(row.shotId)
        if (!list.length) return h('div', { 'data-wb-meta': '' }, kind === 'keyframe' ? '还没有关键帧；写一句画面描述后生成' : '还没有视频；先选一张关键帧')
        return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 8 } },
          ...list.map((t) => h('div', {
            key: t.id,
            style: { border: '2px solid ' + (String(t.id) === selId ? 'var(--wb-acc)' : 'var(--wb-line)'), borderRadius: 9, overflow: 'hidden', background: 'var(--wb-card2)' },
          },
            kind === 'keyframe'
              ? h('img', {
                src: `${API}/assets/media?path=${encodeURIComponent(t.path)}`, alt: '', loading: 'lazy',
                onClick: () => setPreview(`${API}/assets/media?path=${encodeURIComponent(t.path)}`),
                style: { width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block', cursor: 'zoom-in' },
              })
              : h('video', {
                src: `${API}/assets/media?path=${encodeURIComponent(t.path)}`, controls: true, preload: 'metadata',
                style: { width: '100%', aspectRatio: '16/9', objectFit: 'cover', display: 'block', background: '#000' },
              }),
            h('div', { style: { padding: '6px 7px' } },
              h('div', { 'data-wb-meta': '' }, `take ${t.takeNo || '?'} · ${t.model || ''}`),
              h('div', { 'data-wb-row': '', style: { marginTop: 4 } },
                h(Btn, { sm: true, primary: String(t.id) === selId, disabled: busy === 'sel:' + kind + row.shotId, onClick: () => selectTake(kind, row, t), 'data-wb-act': 'select-take', 'data-wb-shot': row.shotId, 'data-wb-take': t.id },
                  String(t.id) === selId ? '已选用' : '选用'),
                kind === 'keyframe' ? h(Btn, {
                  sm: true, disabled: runningOf('video', row.shotId),
                  onClick: async () => { await selectTake('keyframe', row, t); await generateVideos([row]) },
                }, '生成视频') : null)))))
      }

      const rowCard = (row) => {
        const isKf = phase === 'keyframes'
        const kf = kfSel(row.shotId)
        const vd = vdSel(row.shotId)
        return h('div', { key: row.shotId, 'data-wb-card': '', style: { padding: '10px 12px' } },
          h('div', { 'data-wb-row': '' },
            h('b', {}, `#${row.n}`),
            h(Chip, {}, row.kind),
            h('div', { style: { flex: '1 1 220px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: row.visual }, row.visual || row.narration || '未命名镜头'),
            h(Chip, { ok: isKf ? Boolean(kf) : Boolean(vd) }, isKf ? (kf ? '已选图' : '待选图') : (vd ? '已选视频' : '待选视频')),
            h('span', { 'data-wb-meta': '' }, `${row.duration || 4}s`)),
          h('div', { 'data-wb-meta': '', style: { margin: '2px 0 6px' } }, row.narration || '（这镜没有旁白）'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(220px,1fr) minmax(260px,1.3fr)', gap: 10, alignItems: 'start' } },
            h('div', { 'data-wb-col': '' },
              h(BpInput, {
                label: isKf ? '画面提示词（角色一致性会自动拼上）' : '运动 / 表演提示词',
                value: isKf ? (prompts[row.shotId] || '') : (motions[row.shotId] || ''),
                area: true, rows: isKf ? 4 : 3,
                placeholder: isKf ? '例如：主角站在直升机舱门口，手持木制魔法杖，回头和同伴说话' : '例如：主角跳下飞机，背后展开一对白色翅膀，俯视地面',
                onChange: (v) => (isKf ? setPrompts({ ...prompts, [row.shotId]: v }) : setMotions({ ...motions, [row.shotId]: v })),
              }),
              h('div', { 'data-wb-row': '' },
                h(Btn, {
                  sm: true, primary: true, disabled: Boolean(busy) || runningOf(isKf ? 'keyframe' : 'video', row.shotId),
                  onClick: () => (isKf ? generateKeyframes([row], 1) : generateVideos([row])),
                }, runningOf(isKf ? 'keyframe' : 'video', row.shotId) ? '生成中…' : (isKf ? '生成这张' : '生成这镜视频')),
                isKf ? h(Btn, { sm: true, disabled: Boolean(busy) || runningOf('keyframe', row.shotId), onClick: () => generateKeyframes([row], 2) }, '出 2 版') : null,
                h('div', { 'data-wb-grow': '' }),
                h('span', { 'data-wb-meta': '' }, isKf ? '会走真实模型计费' : '1 并发排队')),
              jobLine(isKf ? 'keyframe' : 'video', row)),
            h('div', { 'data-wb-col': '' },
              takeGrid(isKf ? 'keyframe' : 'video', row))))
      }

      if (api.loading && !data.rows) return h(Sec, { title: '制作' }, h('div', { 'data-wb-loading': '' }, '读制作进度…'))
      if (api.err) return h(Sec, { title: '制作' }, h(Err, {}, api.err), h(Btn, { sm: true, onClick: api.reload }, '重试'))

      const missing = []
      if (phase === 'assembly') {
        for (const r of rows) if (!vdSel(r.shotId)) missing.push(`#${r.n}`)
      }
      const liveJobs = [...(jobs.keyframe || []), ...(jobs.video || [])].filter((j) => ['queued', 'running'].includes(j.status))
      return h(Sec, { title: '制作' },
        h('div', { 'data-wb-row': '' },
          h('span', { 'data-wb-meta': '' }, `${PHASE_LABEL[phase]} · 关键帧 ${kfCount}/${rows.length} · 视频 ${vdCount}/${rows.length}${liveJobs.length ? ` · ${liveJobs.length} 个任务在跑` : ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: api.reload }, '刷新')),
        h('div', { 'data-wb-meta': '', style: { margin: '6px 0 8px' } },
          phase === 'keyframes' ? '先给每一镜生成/选一张关键帧；角色参考图会自动带上。' : phase === 'videos' ? '只给已选关键帧的镜头生成视频；视频 1 并发排队。' : '每镜选一条视频后组合；组合会重新配音并统一规格。'),
        data.character ? h('div', { 'data-wb-row': '', style: { marginBottom: 8 } },
          data.character.file ? h('img', {
            src: `${API}/assets/media?path=${encodeURIComponent(data.character.file)}`, alt: '',
            style: { width: 38, height: 38, objectFit: 'cover', borderRadius: 7, border: '1px solid var(--wb-line)' },
          }) : null,
          h('span', { 'data-wb-meta': '' }, `角色：${data.character.name || data.character.id} · 关键帧会带三视图参考`)) : null,
        !approved ? h(Note, {}, '蓝图还没确认：可以先看，生成和组合要先在「方案蓝图」点确认。') : null,
        phase !== 'assembly' ? h('div', { 'data-wb-row': '' },
          h(Btn, {
            sm: true, primary: true, disabled: Boolean(busy) || !rows.length || !approved,
            onClick: () => (phase === 'keyframes' ? generateKeyframes(rows, 1) : generateVideos(rows)),
          }, busy === 'gen-kf' || busy === 'gen-vd'
            ? '提交中…'
            : (phase === 'keyframes' ? `全部生成关键帧（${rows.length} 镜）` : `全部生成视频（${vdCount} 镜已选图）`)),
          h('span', { 'data-wb-meta': '' }, phase === 'keyframes'
            ? '一批最多 12 镜；图片 4 并发'
            : '只给已选关键帧的镜头生成；视频 1 并发')) : null,
        phase === 'assembly' ? h('div', { 'data-wb-col': '' },
          h('div', { 'data-wb-row': '' },
            h(Chip, { ok: !missing.length }, missing.length ? `缺 ${missing.length} 镜视频` : '全部镜头已就绪'),
            h('div', { 'data-wb-grow': '' }),
            h(Btn, {
              sm: true,
              onClick: () => setVoice(!voiceOn),
            }, voiceOn ? '配音：参与' : '配音：不参与'),
            h(Btn, {
              sm: true, primary: true, disabled: Boolean(busy) || Boolean(missing.length) || assembly.status === 'running' || !approved,
              onClick: assemble, 'data-wb-act': 'assemble',
            }, assembly.status === 'running' ? '组合中…' : '开始组合'),
            assembly.status === 'running' ? h(Btn, { sm: true, onClick: cancelAssemble }, '取消') : null),
          h(Note, {}, '组合会复用当前方案旁白重新配音，把选中的镜头统一成 1920×1080 / 30fps 后拼接；成片出现在「审核 / 发布」，不会自动投稿。'),
          missing.length ? h(Note, {}, '还缺：' + missing.join('、') + '；到「视频」页选一版') : null,
          assembly.runId ? h('div', { 'data-wb-col': '', style: { marginTop: 6 } },
            h('div', { 'data-wb-meta': '' }, `run ${assembly.runId} · ${assembly.status}${assembly.stage ? ' · ' + assembly.stage : ''}${assembly.seconds ? ` · ${assembly.seconds}s` : ''}`),
            assembly.error ? h(Err, {}, assembly.error) : null,
            assembly.status === 'done' ? h('div', { 'data-wb-col': '' },
              h('video', {
                src: `${API}/review/media?runId=${encodeURIComponent(assembly.runId)}&kind=video`,
                controls: true, preload: 'metadata',
                style: { width: '100%', maxHeight: 420, background: '#000', borderRadius: 8 },
              }),
              h('div', { 'data-wb-row': '' },
                h(Btn, { sm: true, onClick: () => setPreview(`${API}/review/media?runId=${encodeURIComponent(assembly.runId)}&kind=video`) }, '放大预览'),
                h('span', { 'data-wb-meta': '' }, '已进入「审核 / 发布」列表，可以在那边通过或打回'))) : null) : null) : null,
        phase !== 'assembly' ? h('div', { 'data-wb-col': '' }, ...rows.map((r) => rowCard(r))) : null,
        msg ? h(Note, {}, msg) : null,
        preview ? h('div', { 'data-wb-overlay': '', onClick: (e) => { if (e.target === e.currentTarget) setPreview('') } },
          h('button', { className: 'x', onClick: () => setPreview('') }, '✕'),
          preview.includes('.mp4')
            ? h('video', { src: preview, controls: true, autoPlay: true, style: { maxWidth: '94vw', maxHeight: '88vh' } })
            : h('img', { src: preview, alt: '', style: { maxWidth: '94vw', maxHeight: '88vh' } })) : null)
    }

    function ProjectCard({ p, onChange, autoOpen }) {
      const [inst, setInst] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [panel, setPanel] = useState('')
      const [viewV, setViewV] = useState(0)
      const [viewPlan, setViewPlan] = useState(null)
      const [preview, setPreview] = useState('')
      const [logOpen, setLogOpen] = useState(false)
      const [delArmed, setDelArmed] = useState(false)
      const delTimer = useRef(null)
      useEffect(() => () => clearTimeout(delTimer.current), [])
      useEffect(() => { if (autoOpen) setPanel('plan') }, [autoOpen])
      useEffect(() => {
        if (!preview) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape') setPreview('') }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [preview])
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
      const bpApproved = p.plan?.blueprint?.approvedAt || ''
      const needsBp = Boolean(p.plan?.blueprint) && !bpApproved

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
      const cancelRender = async () => {
        if (!job?.runId) return
        setBusy('cancel')
        const r = await jpost('/render/cancel', { runId: job.runId })
        setBusy('')
        setMsg(r.ok ? '已取消渲染' : ('取消失败：' + (errText(r) || '')))
        onChange?.()
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
      const remove = async () => {
        if (busy === 'del') return
        if (!delArmed) {
          setDelArmed(true)
          clearTimeout(delTimer.current)
          delTimer.current = setTimeout(() => setDelArmed(false), 4000)
          return
        }
        clearTimeout(delTimer.current)
        setDelArmed(false)
        setBusy('del'); setMsg('删除中…')
        const r = await jpost('/create/delete', { id: p.id })
        setBusy('')
        if (r.ok) onChange?.()
        else setMsg('删除失败：' + (errText(r) || ''))
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
        h('div', { 'data-wb-row': '', 'data-wb-project-tabs': '' },
          h(Btn, { sm: true, primary: panel === 'plan', 'data-wb-panel': 'plan', onClick: () => setPanel(panel === 'plan' ? '' : 'plan') }, panel === 'plan' ? '收起方案' : '方案蓝图'),
          h(Btn, { sm: true, primary: panel === 'keyframes', 'data-wb-panel': 'keyframes', onClick: () => setPanel(panel === 'keyframes' ? '' : 'keyframes') }, '关键帧'),
          h(Btn, { sm: true, primary: panel === 'videos', 'data-wb-panel': 'videos', onClick: () => setPanel(panel === 'videos' ? '' : 'videos') }, '视频'),
          h(Btn, { sm: true, primary: panel === 'assembly', 'data-wb-panel': 'assembly', onClick: () => setPanel(panel === 'assembly' ? '' : 'assembly') }, '组合'),
          h(Btn, { sm: true, disabled: needsBp || busy === 'render' || job?.stage === 'running', onClick: render, title: needsBp ? '先确认方案蓝图' : '' }, job?.stage === 'running' ? '渲染中…' : (pct === 100 ? '重新渲染' : '开始渲染')),
          job?.stage === 'running' ? h(Btn, { sm: true, disabled: busy === 'cancel', onClick: cancelRender }, busy === 'cancel' ? '取消中…' : '停止渲染') : null,
          h(Btn, { sm: true, disabled: !pct || !runId, onClick: togglePreview }, '预览成片'),
          h(Btn, {
            sm: true, disabled: Boolean(busy), onClick: remove,
            style: delArmed ? { color: '#f87171', borderColor: 'rgba(248,113,113,.5)' } : undefined,
          }, busy === 'del' ? '删除中…' : delArmed ? '确认删除？' : '删除方案'),
          h('div', { 'data-wb-grow': '' }),
          h('span', { 'data-wb-meta': '' }, `引用素材 ${picks.length} 处`)),
        needsBp ? h(Note, {}, '先在「方案蓝图」里确认，再开始渲染。') : null,
        panel === 'plan' ? h(BlueprintPanel, { p, onClose: () => setPanel(''), onChanged: onChange }) : null,
        panel && panel !== 'plan' ? h(ProductionPanel, {
          p, phase: panel, onPhase: (k) => setPanel(k), onChanged: onChange,
        }) : null,
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

    /* ── 创作页：生成模型选择（服务地址在设置里） ── */
    function GenerationModelsCard() {
      const cfgRes = useApi('/config')
      const modelsRes = useApi('/generate/models')
      const [gen, setGen] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [testUrl, setTestUrl] = useState('')
      useEffect(() => {
        const g = cfgRes.data?.config?.generation
        if (g && gen === null) setGen({ ...g })
      }, [cfgRes.data, gen])
      const models = modelsRes.data?.models || []
      const groups = [
        ['t2i', '文生图', 'text2image'],
        ['i2i', '图生图 / 编辑', 'image2image'],
        ['t2v', '文生视频', 'text2video'],
        ['i2v', '图生视频', 'image2video'],
      ]
      const save = async () => {
        if (!gen) return
        setBusy('save')
        const r = await jpost('/config', { generation: gen })
        setBusy('')
        setMsg(r.ok ? '已保存模型选择' : ('保存失败：' + (errText(r) || '')))
        if (r.ok) cfgRes.reload()
      }
      const test = async () => {
        if (!window.confirm('会用最便宜的文生图模型真实生成 1 张 512×512，约 $0.003，继续？')) return
        setBusy('test'); setMsg('测试生成中…')
        const r = await jpost('/generate/test', { model: 'fal-flux-schnell', confirm: true })
        setBusy('')
        if (r.ok) { setTestUrl(r.url); setMsg(`测试成功：${r.model} · 计费 ${r.billable || '?'} 单位`) }
        else setMsg('测试失败：' + (errText(r) || ''))
      }
      if (!gen) return h(Sec, { title: '生成模型' }, h(Note, {}, cfgRes.loading ? '读配置…' : '还没读到生成服务配置'))
      return h(Sec, { title: '生成模型' },
        h('div', { 'data-wb-row': '' },
          h(Note, {}, `服务：${cfgRes.data?.config?.generation?.baseUrl || modelsRes.data?.baseUrl || '-'}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: modelsRes.reload }, '刷新模型'),
          h(Btn, { sm: true, primary: true, disabled: busy === 'save', onClick: save }, busy === 'save' ? '保存中…' : '保存模型')),
        h('div', { 'data-wb-row': '' },
          ...groups.map(([key, label, task]) => {
            const opts = models.filter((m) => m.task === task)
            const cur = gen[key] || ''
            const known = opts.some((m) => m.id === cur)
            return h('div', { key, style: { flex: '1 1 150px', minWidth: 0 } },
              h('div', { 'data-wb-h': '' }, label),
              h('select', {
                'data-wb-input': '', value: cur,
                onChange: (e) => setGen({ ...gen, [key]: e.target.value }),
              },
              !known && cur ? h('option', { value: cur }, `${cur}（当前配置，列表里没有）`) : null,
              ...opts.map((m) => h('option', { key: m.id, value: m.id }, `${m.id}${m.mode === 'queue' ? ' · 队列' : ''}`))),
              h('div', { 'data-wb-meta': '', style: { marginTop: 3 } },
                opts.find((m) => m.id === cur)?.description || '—'))
          })),
        h('div', { 'data-wb-row': '' },
          h(Btn, { sm: true, disabled: busy === 'test', onClick: test }, busy === 'test' ? '测试中…' : '测试生成（约 $0.003）'),
          h(Note, {}, '只测最便宜的文生图；视频/编辑测试请用 30001 控制台。'),
          msg ? h('span', { 'data-wb-note': '' }, msg) : null),
        testUrl ? h('div', { 'data-wb-row': '' },
          h('img', { src: testUrl, alt: '', style: { width: 160, borderRadius: 8, border: '1px solid var(--wb-line)' } }),
          h('a', { href: testUrl, target: '_blank', rel: 'noreferrer', 'data-wb-note': '' }, '打开测试图 ↗')) : null,
        !modelsRes.loading && !models.length ? h(Err, {}, modelsRes.data?.error || '生成服务不可达；检查 30001 是否启动') : null,
        h(Note, {}, '模型选择会用于创作任务；服务地址/连接在「刷 B 站 → 设置 → 生成服务」。'))
    }

    function TabCreate() {
      const [brief, setBrief] = useState('')
      const [busy, setBusy] = useState('')
      const [log, setLog] = useState('')
      const [autoOpenId, setAutoOpenId] = useState('')
      const list = useApi('/create/plans')
      const taskList = useApi('/task/list')
      const projects = list.data?.projects || []
      const taskRows = taskList.data?.tasks || []
      const activeTasks = taskRows.filter((t) => !['ready', 'failed'].includes(t.status)).length
      const anyRunning = projects.some((p) => p.job?.stage === 'running')
      usePoll(list.reload, 4000, true)
      usePoll(taskList.reload, 4000, true)

      const quickPlan = async () => {
        if (!brief.trim()) return
        setBusy('plan'); setLog('生成方案中…（先出蓝图，不渲染、不投稿）')
        const r = await jpost('/create/plan', { brief })
        setBusy('')
        if (r.ok) {
          setLog(`方案已生成：${r.plan?.title || ''}。先看下方蓝图，确认后再渲染。`)
          setBrief(''); setAutoOpenId(r.project?.id || ''); list.reload()
        } else setLog('失败：' + (errText(r) || ''))
      }
      const go = async () => {
        if (!brief.trim()) return
        setBusy('go'); setLog('已创建任务：先查素材库，不够就自己去 B站 找（进度看下面）')
        const r = await jpost('/task/create', { brief })
        setBusy('')
        if (r.ok) {
          setLog(`任务已创建${r.task?.topic ? `：${r.task.topic}` : ''}。素材不够会按关键词去「刷 B 站」补，够了自动写方案。`)
          setBrief(''); taskList.reload(); list.reload()
        } else setLog('失败：' + (errText(r) || ''))
      }
      return h('div', { 'data-wb-page': '' },
        h(PageHead, { title: '创作 / 出片', sub: '说一句想做什么，先生成方案蓝图；确认分镜、角色、配音、素材、模型后，再渲染' }),
        h(GenerationModelsCard),
        h('div', { 'data-wb-sec': '', style: { gap: 10 } },
          h('div', { 'data-wb-projtitle': '' }, '想做什么样的片子？'),
          h('div', { 'data-wb-note': '' }, '描述主题、语气和时长就行。素材不够时，AI 会按关键词去「刷 B 站」补素材。'),
          h('textarea', {
            'data-wb-input': '', 'data-area': '', rows: 3, style: { minHeight: 92 },
            placeholder: '比如：做一期 iPhone 折叠屏耐用性的实测盘点，轻松点，90 秒以内',
            value: brief, onChange: (e) => setBrief(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) quickPlan() },
          }),
          h('div', { 'data-wb-row': '' },
            ...[
              ['iPhone 折叠屏盘点', '做一期 iPhone 折叠屏耐用性的实测盘点，轻松一点，90 秒以内'],
              ['本周热梗混剪', '把本周 B 站最火的 5 个梗串成一条 60 秒的混剪，节奏快一点'],
              ['打工人对话', '用「打工人的名场面」做一期双角色对话，最后落到一句安慰'],
            ].map(([label, text]) => h('button', {
              key: label, 'data-wb-chip': '', style: { cursor: 'pointer' }, onClick: () => setBrief(text),
            }, label))),
          h('div', { 'data-wb-row': '' },
            h(Btn, { primary: true, disabled: busy === 'plan' || !brief.trim(), onClick: quickPlan }, busy === 'plan' ? '生成方案中…' : '生成方案'),
            h(Btn, { sm: true, disabled: busy === 'go' || !brief.trim(), onClick: go }, busy === 'go' ? '创建任务中…' : '素材不够？让 AI 去刷 B 站'),
            h('span', { 'data-wb-note': '' }, 'Ctrl + Enter 生成方案 · 先确认蓝图，不会自动渲染/投稿'))),
        h(Sec, {},
          h(Note, {}, '素材够就直接写方案；不够就按关键词去 B 站补素材，凑齐后再创作。'),
          log ? h('pre', { 'data-wb-pre': '' }, log) : null),
        taskRows.length ? h(Sec, { title: `任务${activeTasks ? `（${activeTasks} 个进行中）` : ''}` },
          h(Note, {}, '素材不够时按关键词去「刷 B 站」补；素材齐了自动写方案。不会自动渲染，也不会自动投稿。'),
          h('div', { 'data-wb-col': '' }, ...taskRows.map((t) => h(TaskCard, {
            key: t.id, t, onChange: () => { taskList.reload(); list.reload() },
          })))) : null,
        h('div', { 'data-wb-row': '' },
          h(Note, {}, `共 ${projects.length} 个方案${anyRunning ? ' · 有项目在渲染' : ''}`),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: list.reload }, '刷新')),
        h(Note, {}, '删除方案只删方案本身；已经渲染的成片会留在「审核发布」，可以在那边单独删除。'),
        h(Err, {}, list.err),
        list.loading ? h('div', { 'data-wb-loading': '' }, '读方案…') : null,
        !list.loading && !projects.length ? h(Empty, {
          icon: '✍️',
          title: '还没有方案',
          hint: '在上面写一句需求，点「生成方案」。先看蓝图，确认后再渲染。',
        }) : null,
        h('div', { 'data-wb-col': '' }, ...projects.map((p) => h(ProjectCard, {
          key: p.id, p, onChange: list.reload, autoOpen: p.id === autoOpenId,
        }))),
        h(Note, {}, '出片设置（音色 / 时长 / 是否用真实帧）在「刷 B 站 → 设置」和每张卡片的「开始渲染」里调。'),
        )
    }

    /* ═══════════════════ ④ 审核 / 发布 ═══════════════════ */
    function TabReview() {
      const list = useApi('/review/list')
      const [busy, setBusy] = useState('')
      const [dump, setDump] = useState('')
      const [tech, setTech] = useState('')
      const [preview, setPreview] = useState('')
      const [delArm, setDelArm] = useState('')
      const delTimer = useRef(null)
      useEffect(() => () => clearTimeout(delTimer.current), [])
      const runs = list.data?.runs || []
      const publishEnabled = Boolean(list.data?.publishEnabled)
      usePoll(list.reload, 5000, true)
      useEffect(() => {
        if (!preview) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape') setPreview('') }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [preview])

      const decide = async (runId, state) => {
        setBusy(runId + state)
        const r = await jpost('/review/decision', { runId, state })
        setBusy('')
        setDump(r.ok ? `已${state === 'approved' ? '通过' : '打回'}：${runId}` : ('失败：' + (errText(r) || '')))
        setTech('')
        list.reload()
      }
      const upload = async (run, dryRun) => {
        if (!dryRun && !window.confirm('真要投稿到 B站？这会公开发布。')) return
        setBusy(run.runId + (dryRun ? 'dry' : 'real'))
        const r = await jpost('/review/upload', { runId: run.runId, dryRun, confirm: !dryRun })
        setBusy('')
        setDump(r.ok
          ? (dryRun
            ? `✅ 已预演投稿，未发布${r.data?.bvid ? `（BV ${r.data.bvid}）` : ''}`
            : `✅ 已发布！${r.data?.bvid ? `BV：${r.data.bvid}` : ''}`)
          : ('❌ 失败：' + firstLine(errText(r))))
        setTech(r.ok ? [`$ ${(r.command || []).join(' ')}`, JSON.stringify(r.data || {}, null, 2).slice(0, 2000)].join('\n') : '')
        list.reload()
      }
      const showStats = async (run) => {
        setBusy(run.runId + 'stats')
        const r = await jget('/review/stats?runId=' + encodeURIComponent(run.runId))
        setBusy('')
        setDump(r.ok ? JSON.stringify(r.data || {}, null, 2).slice(0, 3000) : ('失败：' + (errText(r) || '')))
        setTech('')
      }
      const remove = async (run) => {
        if (busy === run.runId + 'del') return
        if (delArm !== run.runId) {
          setDelArm(run.runId)
          clearTimeout(delTimer.current)
          delTimer.current = setTimeout(() => setDelArm(''), 4000)
          return
        }
        clearTimeout(delTimer.current)
        setDelArm('')
        setBusy(run.runId + 'del')
        const r = await jpost('/review/delete', { runId: run.runId })
        setBusy('')
        setDump(r.ok ? '' : ('删除失败：' + (errText(r) || '')))
        setTech('')
        list.reload()
      }
      return h('div', { 'data-wb-page': '' },
        h('div', { 'data-wb-sticky-header': '' },
          h(PageHead, {
            title: '审核发布',
            sub: '成片必须你点「通过」才会进入投稿流程；投稿前先预演，确认无误再正式发布',
          },
            h('span', { 'data-wb-chip': '', 'data-ok': publishEnabled ? '' : undefined }, publishEnabled ? '已允许正式投稿' : '正式投稿未开启'),
            h(Btn, { sm: true, onClick: list.reload }, '刷新'))),
        h(Err, {}, list.err),
        h(Note, {}, '「删除成片」只清理本地文件，不会删除 B 站上已发布的内容；删除后项目回到草稿，可以重新渲染。'),
        dump ? h('pre', { 'data-wb-pre': '' }, dump) : null,
        tech ? h(TechDetails, { text: tech }) : null,
        list.loading ? h('div', { 'data-wb-loading': '' }, '读成片…') : null,
        !list.loading && !runs.length ? h(Empty, {
          icon: '🎬',
          title: '还没有成片',
          hint: '去「创作出片」写一句需求，渲染完成后会自动出现在这里。',
        }) : null,
        h('div', { 'data-wb-col': '' }, ...runs.map((r) => {
          const [label, tone] = stageOf(r.stage)
          const published = r.stage === 'published' || r.review?.state === 'published'
          return h('div', { key: r.runId, 'data-wb-card': '', 'data-wb-review': '' },
            h('div', { 'data-wb-review-cover': '' },
              r.hasCover
                ? h('img', { src: `/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=cover`, alt: '', loading: 'lazy', onError: (e) => { e.target.style.display = 'none' } })
                : h('span', {}, published ? '已发布成片' : '待审成片'),
              h('span', { 'data-wb-badge': '', 'data-tone': tone, style: { position: 'absolute', left: '8px', top: '8px', zIndex: 2 } }, label),
              h('span', { 'data-wb-dur': '' }, r.seconds ? `${Math.round(r.seconds)}s` : '')),
            h('div', { 'data-wb-review-body': '' },
              h('div', { 'data-wb-row': '' },
                h('div', { 'data-wb-cardtitle': '', style: { flex: '1 1 260px' } }, r.title || r.runId),
                r.projectVersion ? h('span', { 'data-wb-chip': '' }, `v${r.projectVersion}`) : null,
                r.review?.state ? h('span', { 'data-wb-meta': '' }, `审核：${r.review.state}`) : null),
              h('div', { 'data-wb-meta': '' },
                [r.shots ? `${r.shots} 镜` : '', r.realFrames ? `真实帧 ${r.realFrames}` : '', r.builtAt ? dayOf(r.builtAt) : ''].filter(Boolean).join(' · ')),
              h('div', { 'data-wb-review-actions': '' },
                published
                  ? h(Btn, { sm: true, primary: true, disabled: busy === r.runId + 'stats', onClick: () => showStats(r) }, '看数据')
                  : h(Btn, { sm: true, primary: true, disabled: busy === r.runId + 'approved', onClick: () => decide(r.runId, 'approved') }, '通过'),
                h(Btn, { sm: true, disabled: !r.hasVideo, onClick: () => setPreview(`/api/bili-wb/review/media?runId=${encodeURIComponent(r.runId)}&kind=video`), 'data-wb-act': 'review-preview', 'data-wb-run': r.runId }, '预览'),
                published ? null : h(Btn, { sm: true, disabled: busy === r.runId + 'rejected', onClick: () => decide(r.runId, 'rejected') }, '打回重做'),
                h('details', { 'data-wb-review-more': '' },
                  h('summary', {}, '更多操作'),
                  h('div', { className: 'more' },
                    h(Btn, { sm: true, disabled: busy === r.runId + 'dry' || !r.hasVideo, onClick: () => upload(r, true) }, '预演投稿（不发布）'),
                    r.stage === 'approved'
                      ? h(Btn, { sm: true, disabled: !publishEnabled || busy === r.runId + 'real', onClick: () => upload(r, false) }, '正式投稿')
                      : null,
                    h(Btn, {
                      sm: true, disabled: Boolean(busy), onClick: () => remove(r),
                      style: delArm === r.runId ? { color: 'var(--wb-bad)', borderColor: 'color-mix(in srgb,var(--wb-bad) 50%,transparent)' } : undefined,
                    }, busy === r.runId + 'del' ? '删除中…' : delArm === r.runId ? '确认删除？' : '删除成片'))))))
        })),
        preview ? h('div', {
          'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '成片预览',
          onClick: (e) => { if (e.target === e.currentTarget) setPreview('') },
        },
          h('div', { 'data-wb-modal': '' },
            h('div', { 'data-wb-modal-head': '' },
              h('h3', { style: { flex: 1 } }, '成片预览'),
              h('button', { 'data-wb-modal-close': '', 'aria-label': '关闭预览', onClick: () => setPreview('') }, '✕')),
            h('div', { 'data-wb-modal-body': '' },
              h('video', { src: preview, controls: true, autoPlay: true, style: { width: '100%', borderRadius: 12, background: '#000' } })))) : null)
    }

    /* ═══════════════════ 我的 → 记忆 ═══════════════════ */
    function MemorySec() {
      const [data, setData] = useState(null)
      const [inputs, setInputs] = useState({ user: '', memory: '' })
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [armDel, setArmDel] = useState('')
      const [showAllEvents, setShowAllEvents] = useState(false)
      const delTimer = useRef(null)
      useEffect(() => () => clearTimeout(delTimer.current), [])
      const cfgRes = useApi('/config')
      const cfg = cfgRes.data?.config

      const refresh = async () => {
        const r = await jget('/memory')
        if (r.ok) setData(r)
      }
      // 两次点击确认删除：第一次变红「确认删除？」，4 秒不点自动复位
      const delEntry = async (key, e) => {
        const id = key + '::' + e.text
        if (armDel !== id) {
          setArmDel(id)
          clearTimeout(delTimer.current)
          delTimer.current = setTimeout(() => setArmDel(''), 4000)
          return
        }
        clearTimeout(delTimer.current)
        setArmDel('')
        await op({ target: key, action: 'remove', old_text: e.text }, '已删')
      }
      useEffect(() => { refresh() }, [])
      const op = async (o, note) => {
        setBusy('op'); setMsg('')
        const r = await jpost('/memory/op', o)
        setBusy('')
        if (!r.ok) setMsg(String(r.error || r.result?.error || '操作失败').split('\n')[0])
        else if (note) setMsg(note)
        refresh()
      }
      const toggleMemory = async (on) => {
        setBusy('toggle')
        const r = await jpost('/config', { memoryEnabled: on })
        setBusy('')
        if (r.ok) cfgRes.reload()
      }
      const toggleReflect = async (on) => {
        setBusy('reflect-toggle')
        const r = await jpost('/config', { reflectEnabled: on })
        setBusy('')
        if (r.ok) cfgRes.reload()
      }
      const runReflectNow = async () => {
        setBusy('reflect'); setMsg('复盘中…（翻最近的经历，提炼你的习惯）')
        const r = await jpost('/memory/reflect', {})
        setBusy('')
        if (r.ok) setMsg(`复盘完成：新记 ${r.added} 条${r.results?.some((x) => x.skipped) ? '（有候选被拦截）' : ''}`)
        else setMsg(String(r.skipped || r.error || '复盘未执行').split('\n')[0])
        refresh()
      }
      const evIcon = { watched: '👀', plan: '📝', 'plan-revise': '✏️', render: '🎬', review: '✅', comment: '💬', reply: '↩️', dm: '📨', publish: '🚀', task: '🎯', remember: '🧠' }
      const pendings = data?.pending || []
      const events = data?.events || { count: 0, types: {}, recent: [] }

      const col = (key, title, hint) => {
        const t = data?.[key]
        return h('div', { 'data-wb-memory-col': '' },
          h('div', { 'data-wb-row': '' },
            h('b', { style: { fontSize: 12.5, fontWeight: 700 } }, title),
            h('div', { 'data-wb-grow': '' }),
            h(Chip, {}, `${t?.entries?.length ?? 0} 条 · ${t?.used ?? 0}/${t?.limit ?? 0} 字`)),
          h(Note, {}, hint),
          t?.error ? h('div', { 'data-wb-err': '' }, t.error) : null,
          h('div', { 'data-wb-row': '', style: { gap: 6, margin: '6px 0' } },
            h('input', {
              'data-wb-input': '', style: { flex: '1', minWidth: '0' }, value: inputs[key],
              placeholder: key === 'user' ? '例：标题别超过 18 个字' : '例：1080p 渲染并发 4 会 OOM，用 2',
              onChange: (e) => setInputs({ ...inputs, [key]: e.target.value }),
              onKeyDown: async (e) => {
                if (e.key === 'Enter' && inputs[key]?.trim()) {
                  const v = inputs[key].trim()
                  setInputs({ ...inputs, [key]: '' })
                  await op({ target: key, action: 'add', content: v }, '已记下')
                }
              },
            }),
            h(Btn, {
              sm: true, disabled: busy === 'op' || !inputs[key]?.trim(),
              onClick: async () => { const v = inputs[key].trim(); await op({ target: key, action: 'add', content: v }, '已记下'); setInputs({ ...inputs, [key]: '' }) },
            }, '记一条')),
          h('div', {},
            (t?.entries || []).map((e, i) => h('div', {
              key: i, 'data-wb-memory-item': '',
              title: e.blocked ? `已屏蔽：${e.blockedWhy}（磁盘原文保留）` : `${e.source || ''} ${e.at ? '· ' + e.at.slice(0, 10) : ''}`,
              style: e.blocked ? { color: 'var(--wb-bad)' } : undefined,
            },
            h('span', {}, e.blocked ? `⛔ ${e.text}` : e.text),
            h('button', {
              'aria-label': armDel === key + '::' + e.text ? '确认删除' : '删除这条',
              title: armDel === key + '::' + e.text ? '再点一次确认删除' : `删除这条：${String(e.text || '').slice(0, 20)}`,
              style: armDel === key + '::' + e.text ? { color: 'var(--wb-bad)' } : undefined,
              onClick: () => delEntry(key, e),
            }, armDel === key + '::' + e.text ? '✓' : '×')))),
          !t?.entries?.length && !t?.error ? h(Note, {}, '（空）') : null)
      }

      const visibleEvents = (events.recent || []).slice(0, showAllEvents ? 20 : 7)
      return h(Sec, { title: '长期记忆' },
        h('div', { 'data-wb-row': '' },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', 'data-wb-act': 'memory-toggle-mine', checked: cfg?.memoryEnabled !== false, disabled: busy === 'toggle', onChange: (e) => toggleMemory(e.target.checked) }),
            h('span', {}, '开启长期记忆：评论、回复、出方案时自动参考你的偏好和历史')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, onClick: refresh }, '刷新'),
          msg ? h('span', { 'data-wb-note': '' }, msg) : null),
        h(Note, {}, `文件在 ${data?.dir || '素材库/memory/'}（USER.md = 你的偏好，MEMORY.md = 工作台事实；纯文本可手改，条目用 § 分隔）。红色条目 = 命中注入扫描，注入时已屏蔽。`),
        h('div', { 'data-wb-memory-grid': '', style: { marginTop: 6 } },
          col('user', '主人画像（USER.md）', '称呼、标题长度、封面偏好、禁用梗'),
          col('memory', '工作台笔记（MEMORY.md）', '环境的坑、渲染参数、恢复办法')),
        h('div', { style: { marginTop: 12 } },
          h('div', { 'data-wb-row': '' },
            h('b', { style: { fontSize: 12.5, fontWeight: 700 } }, `经历流（${events.count} 条）`),
            h('div', { 'data-wb-grow': '' }),
            h(Chip, {}, Object.entries(events.types || {}).map(([t, n]) => `${evIcon[t] || '·'}${n}`).join(' ') || '还没有')),
          h(Note, {}, '自动记录看过什么、出过什么方案、渲染/审核/评论结果；出方案和写评论时按题材召回。'),
          h('div', {},
            visibleEvents.map((e, i) => h('div', {
              key: i, 'data-wb-event-row': '', title: `${e.at} · ${e.type}`,
            },
            h('span', { style: { marginRight: 6 } }, evIcon[e.type] || '·'),
            h('span', { className: 'text' }, String(e.text || '').slice(0, 80)),
            h('time', {}, String(e.at || '').slice(5, 10))))),
          (events.recent || []).length > 7 ? h('div', { 'data-wb-row': '', style: { marginTop: 6 } },
            h(Btn, { sm: true, onClick: () => setShowAllEvents(!showAllEvents) }, showAllEvents ? '收起' : `查看全部（${events.recent.length} 条）`)) : null,
          !events.recent?.length ? h(Note, {}, '（还没有经历，刷几条 B 站 或出一个方案就有了）') : null),
        h('div', { 'data-wb-row': '', style: { marginTop: 10 } },
          h('label', { 'data-wb-toggle': '' },
            h('input', { type: 'checkbox', checked: cfg?.reflectEnabled !== false, disabled: busy === 'reflect-toggle', onChange: (e) => toggleReflect(e.target.checked) }),
            h('span', {}, '任务后自动复盘（从经历里提炼你的习惯，只增不改）')),
          h('div', { 'data-wb-grow': '' }),
          h(Btn, { sm: true, disabled: busy === 'reflect', onClick: runReflectNow }, '立即复盘'),
          data?.reflect?.lastAt ? h('span', { 'data-wb-note': '' }, `上次 ${String(data.reflect.lastAt).slice(5, 16).replace('T', ' ')} · 累计新记 ${data.reflect.added || 0} 条`) : null),
        pendings.length ? h('div', { style: { marginTop: 8 } },
          h('b', {}, `待批提案（${pendings.length}）`),
          h(Note, {}, '无人值守任务只能「记新条」，改动/删除会在这里等批准'),
          pendings.map((p) => h('div', { key: p.id, 'data-wb-row': '', style: { padding: '2px 0' } },
            h('span', { 'data-wb-grow': '' }, `#${p.id} ${p.target}.${p.action}：${(p.matched_entry || p.old_text || '').slice(0, 40)}${p.new_text ? ' → ' + p.new_text.slice(0, 30) : ''}`),
            h(Btn, { sm: true, onClick: async () => { await jpost('/memory/pending/approve', { id: p.id }); refresh() } }, '批准'),
            h(Btn, { sm: true, onClick: async () => { await jpost('/memory/pending/discard', { id: p.id }); refresh() } }, '丢弃')))) : null)
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
      const [doctor, setDoctor] = useState(null) // /doctor 结果
      useEffect(() => {
        if (!doctor) return
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const onKey = (e) => { if (e.key === 'Escape') setDoctor(null) }
        window.addEventListener('keydown', onKey)
        return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
      }, [doctor])
      const checkDoctor = async () => {
        setBusy('doctor')
        const r = await jget('/doctor')
        setBusy('')
        setDoctor(r.data?.checks || null)
      }
      const DOCTOR_LABELS = [
        ['bili', 'bili 命令'], ['ffmpeg', 'ffmpeg'], ['ytdlp', 'yt-dlp'], ['llm', '模型服务'],
        ['assets', '素材库（音色·BGM·表情包·贴纸·片段）'], ['sovits', '声音克隆环境'],
      ]
      const doctorLine = (k, v) => {
        if (k === 'assets') {
          if (!v || typeof v !== 'object') return '✗ 未知'
          const names = { bgm: 'BGM', voices: '音色', memes: '表情包', stickers: '贴纸', clips: '片段' }
          return Object.entries(names).map(([n, zh]) => `${v[n] ? '✓' : '✗'}${zh}`).join(' ')
        }
        const ok = v?.ok
        const detail = v?.detail ? ` — ${String(v.detail).slice(0, 80)}` : ''
        return `${ok ? '✓' : '✗'}${detail}`
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
        h(PageHead, { title: '我的', sub: '账号、数据、素材库位置与长期记忆' },
          auth?.loggedIn ? null : h(Btn, { primary: true, sm: true, disabled: busy === 'login', onClick: login }, busy === 'login' ? '生成二维码…' : '扫码登录')),

        !auth?.loggedIn
          ? h('div', { 'data-wb-login': '' },
            h('div', { 'data-wb-qr': '' }, qr ? h('img', { src: API + '/qr.png?t=' + Date.now(), alt: '二维码' }) : h('div', { className: 'ph' })),
            h('div', { 'data-wb-col': '', style: { flex: 1 } },
              h('div', { 'data-wb-projtitle': '' }, '扫码登录 bili-cli'),
              h(Note, {}, '手机 B 站 App 扫码，确认时选「记住我 / 长期」。登录成功后这里会显示昵称、UID、LV 和登出按钮。'),
              h('div', { 'data-wb-row': '' },
                h(Chip, { warn: true }, '未登录'),
                h(Btn, { sm: true, onClick: qr ? () => setQr(false) : login }, qr ? '刷新二维码' : '生成二维码'),
                msg ? h('span', { 'data-wb-note': '' }, msg) : null),
              h(Note, {}, '工作台统一使用这份 bili-cli 登录；请勿再安装旧的「刷 B 站」插件，避免出现两套登录状态。')))
          : h('div', { 'data-wb-account': '' },
            h('span', { 'data-wb-avatar': '' }, '咕'),
            h('div', { 'data-wb-grow': '' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('b', { style: { fontSize: 16, fontWeight: 750 } }, auth.user?.name || auth.user?.mid || '已登录'),
                h('span', { 'data-wb-chip': '', 'data-ok': '' }, `LV${auth.user?.level ?? '?'}`)),
              h('div', { 'data-wb-meta': '' }, `UID ${auth.user?.mid ?? '-'} · 已登录 bili-cli`)),
            h(Btn, { sm: true, onClick: refreshAuth }, '刷新'),
            h(Btn, { sm: true, disabled: busy === 'logout', onClick: logout }, '登出')),

        d ? h('div', { 'data-wb-stat-grid': '' },
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.plays, 'now'))), h('span', {}, `播放量（上期 ${fmtNum(n(d.plays, 'previous'))}）`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, fmtNum(n(d.visitors, 'now'))), h('span', {}, '主页访客')),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `+${fmtNum(n(d.new_fans, 'now'))}`), h('span', {}, `涨粉 · 总粉丝 ${fmtNum(d.fans?.total)}`)),
          h('div', { 'data-wb-stat': '' }, h('b', {}, `${d.beats_similar_ups_percent?.play ?? '-'}%`), h('span', {}, '播放超过同类 UP 主'))) : null,

        h('div', { 'data-wb-split': '' },
          h(Sec, { title: '素材库与运行' },
            h('div', { 'data-wb-kv': '' },
              `库路径：${store.path || '—'}`,
              h('br'),
              `库内：${store.videos ?? '-'} 条 · ${store.mb ?? '-'} MB · ${store.files ?? '-'} 个文件`,
              h('br'),
              `定时：${cfg?.enabled ? '开' : '关'}（${cfg?.scheduleRanges || '00:00-24:00'} · 每天上限 ${cfg?.perDay || 48} · 约每 ${cfgRes.data?.schedule?.estMinutes || '?'} 分钟 1 条）`,
              h('br'),
              `模型顺序：${(cfg?.modelChain || []).length} 个，当前 ${(cfg?.modelChain || [])[0] || '-'}`),
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
              h(Btn, { sm: true, disabled: busy === 'model', onClick: checkModel }, '测模型'),
              h(Btn, { sm: true, disabled: busy === 'doctor', onClick: checkDoctor }, busy === 'doctor' ? '自检中…' : '自检')),
            doctor ? h('div', {
              'data-wb-overlay': '', role: 'dialog', 'aria-modal': 'true', 'aria-label': '环境自检',
              onClick: (e) => { if (e.target === e.currentTarget) setDoctor(null) },
            },
              h('div', { 'data-wb-modal': '', style: { width: 'min(520px, 94%)' } },
                h('div', { 'data-wb-modal-head': '' },
                  h('h3', { style: { flex: 1 } }, '环境自检'),
                  h('button', { 'data-wb-modal-close': '', 'aria-label': '关闭自检', onClick: () => setDoctor(null) }, '✕')),
                h('div', { 'data-wb-modal-body': '' },
                  ...DOCTOR_LABELS.map(([k, label]) => h('div', { key: k, 'data-wb-row': '', style: { padding: '4px 0', alignItems: 'flex-start' } },
                    h('span', { 'data-wb-grow': '' }, label),
                    h('span', { 'data-wb-note': '', style: { textAlign: 'right', maxWidth: '55%' } }, doctorLine(k, doctor[k]))))))) : null,
            health ? h('pre', { 'data-wb-pre': '' }, health) : null,
            log ? h('pre', { 'data-wb-pre': '' }, log) : null),

          h(Sec, { title: '发布权限' },
            h('label', { 'data-wb-toggle': '' },
              h('input', { type: 'checkbox', checked: Boolean(draft?.publishEnabled), onChange: (e) => setDraft({ ...draft, publishEnabled: e.target.checked }) }),
              h('span', {}, '允许正式投稿（默认关）')),
            h(Note, {}, '关闭时「审核发布」只能预演；打开后仍会二次确认。'),
            h(Field, { label: '默认标签' },
              h('input', { 'data-wb-input': '', value: draft?.tagsText || '', onChange: (e) => setDraft({ ...draft, tagsText: e.target.value }), placeholder: '资讯,盘点' })),
            h(Field, { label: '默认分区 ID' },
              h('input', { 'data-wb-input': '', 'data-num': '', type: 'number', value: draft?.defaultZone ?? 0, onChange: (e) => setDraft({ ...draft, defaultZone: e.target.value }) }),
              h(Note, {}, '0 = 让 bili 自动预测')),
            h('div', { 'data-wb-row': '' },
              h(Btn, { sm: true, primary: true, disabled: busy === 'save', onClick: savePublish }, '保存发布设置'),
              msg ? h('span', { 'data-wb-note': '' }, msg) : null))),

        h(Sec, { title: '模型顺序' },
          h('div', { 'data-wb-kv': '' }, (cfg?.modelChain || []).map((m, i) => h('div', { key: i }, `${i + 1}. ${m}`))),
          h(Note, {}, '在「刷 B 站 → 设置 → 模型顺序」里改。失败自动切换下一个。')),

        h(MemorySec),
        h(Err, {}, cfgRes.err))
    }

    /* ═══════════════════ 外壳 ═══════════════════ */
    const NAV = [
      ['store', 'library', '素材库'],
      ['scroll', 'play', '刷 B 站'],
      ['create', 'pen', '创作出片'],
      ['review', 'check', '审核发布'],
      ['mine', 'user', '我的'],
    ]

    const NAV_ICONS = {
      library: [
        h('path', { key: 'a', d: 'M4 19.5V6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 0 4 22' }),
        h('path', { key: 'b', d: 'M8 8h8M8 12h6' }),
      ],
      play: [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
        h('path', { key: 'b', d: 'm10 8.5 6 3.5-6 3.5v-7Z' }),
      ],
      pen: [
        h('path', { key: 'a', d: 'M12 20h9' }),
        h('path', { key: 'b', d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z' }),
      ],
      check: [
        h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
        h('path', { key: 'b', d: 'm8.5 12 2.5 2.5 4.5-5' }),
      ],
      user: [
        h('circle', { key: 'a', cx: 12, cy: 8, r: 3.5 }),
        h('path', { key: 'b', d: 'M5 20a7 7 0 0 1 14 0' }),
      ],
    }
    function NavIcon({ name }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, ...(NAV_ICONS[name] || []))
    }

    function Shell() {
      const [tab, setTab] = useState('store')
      const [collapsed, setCollapsed] = useState(false)
      const rootRef = useRef(null)
      // 让工作台高度跟着宿主“可用区 - 输入区”走，避免外层再多一条滚动条
      React.useLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return
        const findScroll = () => {
          let el = root.parentElement
          while (el) {
            const s = getComputedStyle(el)
            if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.clientHeight > 0) return el
            el = el.parentElement
          }
          return null
        }
        const seatOf = (scroll) => scroll?.querySelector('[class*="composerSeat"]') || null
        let seat = null
        const fit = () => {
          const scroll = findScroll()
          if (!scroll) return
          seat = seatOf(scroll)
          const seatH = seat ? seat.offsetHeight : 0
          const avail = Math.max(320, scroll.clientHeight - seatH)
          root.style.height = avail + 'px'
          root.style.maxHeight = avail + 'px'
          root.style.minHeight = '0px'
        }
        fit()
        const ro = new ResizeObserver(() => fit())
        ro.observe(document.documentElement)
        const scroll = findScroll()
        if (scroll) ro.observe(scroll)
        if (seat) ro.observe(seat)
        window.addEventListener('resize', fit)
        const t = setTimeout(fit, 500)
        return () => { clearTimeout(t); ro.disconnect(); window.removeEventListener('resize', fit) }
      }, [])
      return h('div', { 'data-wb-root': '', 'data-collapsed': collapsed ? '' : undefined, ref: rootRef },
        h('aside', { 'data-wb-rail': '' },
          h('div', { 'data-wb-brand': '' }, 'B站工作台', h('small', {}, '从素材到发布')),
          h('nav', { style: { display: 'flex', flexDirection: 'column' } },
            ...NAV.map(([k, ico, label]) => h('button', {
              key: k, 'data-wb-nav': '', 'aria-selected': tab === k ? 'true' : 'false',
              'aria-label': label, title: label,
              onClick: () => setTab(k),
            },
            h('span', { className: 'ico' }, h(NavIcon, { name: ico })),
            h('span', { 'data-wb-label': '' }, label)))),
          h('div', { 'data-wb-rail-foot': '' },
            h('button', { 'data-wb-ghost': '', onClick: () => setCollapsed(!collapsed) }, collapsed ? '»' : '« 收起'))),
        h('main', { 'data-wb-main': '' },
          tab === 'store' ? h(TabStore) : null,
          tab === 'scroll' ? h(TabScroll) : null,
          tab === 'create' ? h(TabCreate) : null,
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
