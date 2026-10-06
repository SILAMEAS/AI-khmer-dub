"use client";

/**
 * The player in the middle: the video with every setting drawn live on top of it (subtitles, text, logo, filter,
 * cover band, progress bar, fade, shape), or the exported video.
 */
import { useEffect, useRef, useState } from "react";
import { clock, lineAt, type Segment } from "./common";
import { ASPECTS, cssFilter, subTextStyle, TITLE_POS, type Look, type OutOpts } from "./look";

const RATIO: Record<Exclude<OutOpts["aspect"], "original">, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
const SAMPLE = "សួស្តី! នេះជាចំណងជើងខ្មែរ។", SAMPLE_ORIGINAL = "Hello! These are Khmer subtitles.";

export function Player({ src, finalSrc, view, onView, look, onLook, segs, logoUrl, videoRef, onPlay, onTime, onDuration,
  jobId, placeholder }: {
  src: string | null; finalSrc: string | null; view: "edit" | "final"; onView: (v: "edit" | "final") => void;
  look: Look; onLook: (l: Look) => void; segs: Segment[] | null; logoUrl: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>; onPlay: () => void; onTime: (t: number) => void; onDuration: (d: number) => void;
  jobId?: string; placeholder?: React.ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null), blurRef = useRef<HTMLVideoElement>(null), frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [nat, setNat] = useState({ w: 16, h: 9 });
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [still, setStill] = useState<string | null>(null);
  const [stillBusy, setStillBusy] = useState(false);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the clock: every frame while playing, so the overlays move with the picture
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0, last = 0;
    const step = () => {
      const now = v.currentTime;
      setT(now);
      const b = blurRef.current;
      if (b) { if (Math.abs(b.currentTime - now) > 0.3) b.currentTime = now; if (v.paused !== b.paused) v.paused ? b.pause() : b.play().catch(() => {}); }
      if (performance.now() - last > 66) { last = performance.now(); onTime(now); }
      if (!v.paused) raf = requestAnimationFrame(step);
    };
    const go = () => { setPlaying(!v.paused); cancelAnimationFrame(raf); step(); };
    const meta = () => { setNat({ w: v.videoWidth || 16, h: v.videoHeight || 9 }); setDur(v.duration || 0); onDuration(v.duration || 0); };
    v.addEventListener("play", go); v.addEventListener("pause", go); v.addEventListener("seeked", go); v.addEventListener("timeupdate", go);
    v.addEventListener("loadedmetadata", meta);
    if (v.readyState >= 1) meta();
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", go); v.removeEventListener("pause", go); v.removeEventListener("seeked", go);
      v.removeEventListener("timeupdate", go); v.removeEventListener("loadedmetadata", meta);
    };
  }, [src, view, videoRef, onTime, onDuration]);

  const { sub: s, fx, logo: lg, out } = look;
  // frame = the exported picture's shape, fitted into the stage; pic = where the source picture sits in it
  const srcR = nat.w / nat.h, R = out.aspect === "original" ? srcR : RATIO[out.aspect];
  const fw = Math.max(10, Math.min(box.w - 24, (box.h - 24) * R)), fh = fw / R;
  const cover = out.aspect !== "original" && out.fit === "crop";
  const pw = out.aspect === "original" ? fw : cover ? Math.max(fw, fh * srcR) : Math.min(fw, fh * srcR);
  const ph = pw / srcR, px = (fw - pw) / 2, py = (fh - ph) / 2;
  const unit = fh / 288; // libass sizes are in units of a 288-line-high picture
  const filter = cssFilter(fx), flip = fx.mirror ? "scaleX(-1)" : undefined;

  const i = lineAt(segs, t);
  const line = segs ? (i >= 0 ? segs[i] : null) : { km: SAMPLE, text: SAMPLE_ORIGINAL };
  const showSub = look.burn && line && line.km.trim();
  const D = Math.max(2, lg.duration), E = Math.max(D, lg.every), lw = (fw * lg.size) / 100;
  const inSlide = t % E < D, lx = -lw + ((fw + lw) * (t % E)) / D;
  const fade = fx.fade && dur > 2 ? Math.max(0, 1 - t / 0.6, (t - (dur - 0.6)) / 0.6) : 0;

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { onPlay(); v.play().catch(() => {}); } else v.pause();
  };
  const jump = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || !segs?.length) return;
    const now = v.currentTime;
    const next = dir > 0 ? segs.find((x) => x.start > now + 0.05) : [...segs].reverse().find((x) => x.start < now - 0.3);
    v.currentTime = next ? next.start : dir > 0 ? now : 0;
  };
  async function exactFrame() {
    if (!jobId) return;
    setStillBusy(true);
    try {
      const r = await fetch(`/api/jobs/${jobId}/frame`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub: s, logo: lg, out, fx, t }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      setStill(URL.createObjectURL(await r.blob()));
    } catch (e) { alert((e as Error).message); } finally { setStillBusy(false); }
  }

  return (
    <div className="player">
      <div className="stage" ref={stage}>
        {view === "final" && finalSrc ? (
          <video key={finalSrc} src={finalSrc} controls playsInline className="final-video" />
        ) : !src ? placeholder : (
          <div className="frame" ref={frameRef} style={{ width: fw, height: fh }}>
            {out.aspect !== "original" && out.fit === "blur" && (
              <video ref={blurRef} src={src} muted playsInline className="blur-fill" style={{ filter: `${filter} blur(${Math.max(8, fw / 40)}px) brightness(.85)`, transform: flip }} />
            )}
            <video ref={videoRef} src={src} playsInline onClick={toggle} className="pic"
              style={{ left: px, top: py, width: pw, height: ph, filter, transform: flip }} />
            {fx.cover && (
              <div className={`cover-band ${fx.coverMode}`} style={{ left: px, width: pw, top: py + (ph * fx.coverY) / 100,
                height: (ph * Math.min(fx.coverH, 100 - fx.coverY)) / 100, ...(fx.coverMode === "box" && { background: fx.coverColor }) }} />
            )}
            {fx.title && (
              <div className="ov-title" style={{ ...TITLE_POS[fx.titlePos], color: fx.titleColor,
                fontFamily: `"${s.font}", "Khmer UI", sans-serif`, fontSize: fx.titleSize * unit }}>{fx.title}</div>
            )}
            {lg.enabled && logoUrl && inSlide && (
              <img className="ov-logo" src={logoUrl} alt="" style={{ width: lw, left: lx, opacity: lg.opacity, [lg.position]: "5%" }} />
            )}
            {showSub && (
              <div className="ov-sub" style={{ [s.position]: s.margin * unit }}>
                <span key={i} className={`anim-${s.anim}`} style={subTextStyle(s, unit)}>{line!.km}
                  {s.bilingual && line!.text && <><br /><span style={{ fontSize: s.size * 0.72 * unit }}>{line!.text}</span></>}
                </span>
              </div>
            )}
            {!look.burn && line?.km && <div className="ov-cc">{line.km}</div>}
            {fx.progress && dur > 0 && <div className="ov-progress" style={{ width: `${(t / dur) * 100}%`, background: fx.progressColor, height: Math.max(2, fh / 160) }} />}
            {fade > 0 && <div className="ov-fade" style={{ opacity: Math.min(1, fade) }} />}
          </div>
        )}
        {still && (
          <div className="still" onClick={() => setStill(null)}>
            <img src={still} alt="Exact frame" /><small>Exactly as the exported video will look · click to close</small>
          </div>
        )}
      </div>
      <div className="transport">
        <div className="tp-left">
          <span className="tc">{clock(t, true)} <i>/ {clock(dur)}</i></span>
        </div>
        <div className="tp-mid">
          <button type="button" onClick={() => jump(-1)} title="Previous line" disabled={!src || view === "final"}>⏮</button>
          <button type="button" className="play" onClick={toggle} title="Play / pause (space)" disabled={!src || view === "final"}>{playing ? "⏸" : "▶"}</button>
          <button type="button" onClick={() => jump(1)} title="Next line" disabled={!src || view === "final"}>⏭</button>
        </div>
        <div className="tp-right">
          <select value={out.aspect} title="Shape of the video" onChange={(e) => onLook({ ...look, out: { ...out, aspect: e.target.value as OutOpts["aspect"] } })}>
            {ASPECTS.map(([v, n, sub]) => <option key={v} value={v}>{n} · {sub}</option>)}
          </select>
          {jobId && view === "edit" && (
            <button type="button" onClick={exactFrame} disabled={stillBusy} title="Render this frame exactly as the export will look">{stillBusy ? "…" : "📷"}</button>
          )}
          {finalSrc && (
            <div className="seg-btns sm">
              <button type="button" className={view === "edit" ? "on" : ""} onClick={() => onView("edit")}>Edit</button>
              <button type="button" className={view === "final" ? "on" : ""} onClick={() => { videoRef.current?.pause(); onView("final"); }}>Exported</button>
            </div>
          )}
          <button type="button" title="Full screen" onClick={() => stage.current?.requestFullscreen?.()}>⛶</button>
        </div>
      </div>
    </div>
  );
}
