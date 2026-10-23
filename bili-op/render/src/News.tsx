import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/**
 * 资讯盘点模板 —— 4 种镜头：title / item / data / outro
 * 数据全部来自 props.json（bili-op/tts.mjs 产出），这里只负责画。
 */

const FONT = 'Microsoft YaHei, "Segoe UI", "Noto Sans SC", sans-serif';
const ACCENT = "#5B8CFF";
const ACCENT2 = "#A78BFA";
const GREEN = "#34D399";
const DIM = "rgba(255,255,255,0.66)";

/* ───────────── 背景 ───────────── */
const Bg: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const x1 = 28 + Math.sin(t * 0.35) * 6;
  const y1 = 22 + Math.cos(t * 0.28) * 5;
  const x2 = 74 + Math.cos(t * 0.22) * 6;
  const y2 = 78 + Math.sin(t * 0.31) * 5;
  return (
    <AbsoluteFill style={{ background: "linear-gradient(160deg,#080c18 0%,#0b1020 45%,#0a0f1e 100%)" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(46% 42% at ${x1}% ${y1}%, rgba(91,140,255,0.28), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(44% 40% at ${x2}% ${y2}%, rgba(167,139,250,0.22), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "repeating-linear-gradient(0deg, rgba(255,255,255,0.028) 0 1px, transparent 1px 44px)",
        }}
      />
    </AbsoluteFill>
  );
};

/* ───────────── 通用动画 ───────────── */
const useAnim = (frames: number) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.6 } });
  const out = interpolate(frame, [frames - 10, frames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return {
    opacity: Math.min(enter, out),
    y: interpolate(enter, [0, 1], [28, 0]),
    scale: interpolate(enter, [0, 1], [0.97, 1]),
  };
};

/* ───────────── 顶栏 / 进度 ───────────── */
const TopBar: React.FC<{ label: string; right?: string }> = ({ label, right }) => (
  <div style={{ position: "absolute", top: 56, left: 88, right: 88, display: "flex", alignItems: "center" }}>
    <div
      style={{
        padding: "10px 22px",
        borderRadius: 999,
        background: "rgba(91,140,255,0.18)",
        border: "1px solid rgba(91,140,255,0.5)",
        color: "#cfe0ff",
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: 1,
      }}
    >
      {label}
    </div>
    <div style={{ flex: 1 }} />
    <div style={{ color: "rgba(255,255,255,0.45)", fontSize: 24, fontFamily: FONT }}>{right || ""}</div>
  </div>
);

const Progress: React.FC<{ total: number }> = ({ total }) => {
  const frame = useCurrentFrame();
  const p = Math.max(0, Math.min(1, frame / Math.max(1, total - 1)));
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 6, background: "rgba(255,255,255,0.08)" }}>
      <div
        style={{
          width: `${p * 100}%`,
          height: "100%",
          background: `linear-gradient(90deg,${ACCENT},${ACCENT2})`,
        }}
      />
    </div>
  );
};

/* ───────────── 四种镜头 ───────────── */
const TitleShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <TopBar label="资讯盘点" right="每周更新" />
      <div
        style={{
          position: "absolute",
          left: 88,
          right: 88,
          top: 300,
          transform: `translateY(${a.y}px) scale(${a.scale})`,
          fontFamily: FONT,
        }}
      >
        <div style={{ color: ACCENT, fontSize: 30, fontWeight: 700, letterSpacing: 3, marginBottom: 26 }}>
          本周值得知道的几件事
        </div>
        <div style={{ color: "#fff", fontSize: 104, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1 }}>
          {s.headline}
        </div>
        <div style={{ color: DIM, fontSize: 40, marginTop: 34 }}>{s.sub}</div>
      </div>
    </AbsoluteFill>
  );
};

const ItemShot: React.FC<{ s: any; frames: number; total: number }> = ({ s, frames, total }) => {
  const a = useAnim(frames);
  const hasFrame = Boolean(s.frameImage);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <TopBar label="资讯盘点" right={`第 ${s.index || ""} 条 · 共 ${total} 条`} />
      <div
        style={{
          position: "absolute",
          left: 88,
          right: 88,
          top: hasFrame ? 214 : 250,
          display: "flex",
          gap: hasFrame ? 46 : 56,
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT,
            fontSize: hasFrame ? 170 : 220,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: -6,
            background: `linear-gradient(180deg,${ACCENT},${ACCENT2})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            transform: `translateY(${a.y}px)`,
          }}
        >
          {String(s.index || "").padStart(2, "0")}
        </div>
        <div style={{ flex: 1, minWidth: 0, transform: `translateY(${a.y}px)`, fontFamily: FONT }}>
          {s.badge ? (
            <div
              style={{
                display: "inline-block",
                padding: "8px 18px",
                borderRadius: 10,
                background: "rgba(52,211,153,0.16)",
                border: "1px solid rgba(52,211,153,0.5)",
                color: GREEN,
                fontSize: 24,
                fontWeight: 700,
                marginBottom: 24,
              }}
            >
              {s.badge}
            </div>
          ) : null}
          <div style={{ color: "#fff", fontSize: hasFrame ? 64 : 76, fontWeight: 800, lineHeight: 1.18, letterSpacing: -1 }}>
            {s.headline}
          </div>
          <div style={{ color: DIM, fontSize: hasFrame ? 34 : 38, lineHeight: 1.5, marginTop: 26 }}>{s.body}</div>
        </div>
        {hasFrame ? (
          <div
            style={{
              width: 560,
              flex: "none",
              borderRadius: 24,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.18)",
              boxShadow: "0 28px 70px rgba(0,0,0,0.5)",
              background: "#0d1424",
              transform: `scale(${a.scale})`,
            }}
          >
            <Img src={staticFile(s.frameImage)} style={{ width: "100%", display: "block" }} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 16px",
                color: "rgba(255,255,255,0.55)",
                fontSize: 18,
                fontFamily: FONT,
                background: "rgba(255,255,255,0.04)",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: ACCENT, display: "inline-block" }} />
              素材画面 · {s.frameFrom?.bv || ""}
              {Number.isFinite(Number(s.frameFrom?.t)) ? ` · ${Math.round(Number(s.frameFrom.t))}s` : ""}
            </div>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const DataShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  const stats = Array.isArray(s.stats) ? s.stats : [];
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <TopBar label="资讯盘点" right="几个数字" />
      <div style={{ position: "absolute", left: 88, right: 88, top: 260, fontFamily: FONT }}>
        <div style={{ color: "#fff", fontSize: 68, fontWeight: 800, marginBottom: 56, transform: `translateY(${a.y}px)` }}>
          {s.headline}
        </div>
        <div style={{ display: "flex", gap: 28 }}>
          {stats.map((x: any, i: number) => (
            <div
              key={i}
              style={{
                flex: 1,
                padding: "38px 34px",
                borderRadius: 22,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              <div
                style={{
                  fontSize: 72,
                  fontWeight: 800,
                  background: `linear-gradient(180deg,${ACCENT},${ACCENT2})`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                {x.value}
              </div>
              <div style={{ color: DIM, fontSize: 28, marginTop: 10 }}>{x.label}</div>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const OutroShot: React.FC<{ s: any; frames: number }> = ({ s, frames }) => {
  const a = useAnim(frames);
  return (
    <AbsoluteFill style={{ opacity: a.opacity }}>
      <TopBar label="资讯盘点" right="下期见" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: FONT }}>
        <div style={{ transform: `translateY(${a.y}px) scale(${a.scale})`, textAlign: "center" }}>
          <div style={{ color: "#fff", fontSize: 90, fontWeight: 800 }}>{s.headline}</div>
          <div style={{ color: DIM, fontSize: 36, marginTop: 30 }}>{s.sub}</div>
          <div
            style={{
              display: "inline-block",
              marginTop: 54,
              padding: "14px 34px",
              borderRadius: 999,
              background: "rgba(91,140,255,0.16)",
              border: "1px solid rgba(91,140,255,0.5)",
              color: "#cfe0ff",
              fontSize: 28,
              fontWeight: 700,
            }}
          >
            关注 · 下周接着聊
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/* ───────────── 主组件 ───────────── */
export const News: React.FC<any> = (p) => {
  const shots = Array.isArray(p?.shots) ? p.shots : [];
  const itemTotal = shots.filter((s: any) => s.kind === "item").length;
  const total = Number(p?.totalFrames) || 1;

  return (
    <AbsoluteFill style={{ background: "#080c18", fontFamily: FONT }}>
      <Bg />
      {shots.map((s: any, i: number) => (
        <Sequence key={i} from={Number(s.from) || 0} durationInFrames={Math.max(1, Number(s.frames) || 30)}>
          {s.kind === "title" ? <TitleShot s={s} frames={Number(s.frames) || 30} /> : null}
          {s.kind === "item" ? <ItemShot s={s} frames={Number(s.frames) || 30} total={itemTotal} /> : null}
          {s.kind === "data" ? <DataShot s={s} frames={Number(s.frames) || 30} /> : null}
          {s.kind === "outro" ? <OutroShot s={s} frames={Number(s.frames) || 30} /> : null}
        </Sequence>
      ))}
      <Progress total={total} />
    </AbsoluteFill>
  );
};
