"use client";

/**
 * The player in the middle: the video with every setting drawn live on top of it (subtitles, text, logo, filter,
 * cover band, progress bar, fade, shape), or the exported video.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { timeWords } from "@/lib/words";
import { clock, cutAt, lineAt, punchRanges, zoomAt, type EditOpts, type Segment } from "./common";
import { ASPECTS, cssFilter, subTextStyle, TITLE_POS, type Look, type OutOpts } from "./look";

const RATIO: Record<Exclude<OutOpts["aspect"], "original">, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
const SAMPLE = "សួស្តី! នេះជាចំណងជើងខ្មែរ។", SAMPLE_ORIGINAL = "Hello! These are Khmer subtitles.";

export const Player = memo(function Player({ src, finalSrc, view, onView, look, onLook, segs, logoUrl, videoRef, onPlay, onTime, onDuration,
  jobId, placeholder, edit, onEdit, selectedSticker, onSelectSticker, editAreas = false }: {
  src: string | null; finalSrc: string | null; view: "edit" | "final"; onView: (v: "edit" | "final") => void;
  look: Look; onLook: (l: Look) => void; segs: Segment[] | null; logoUrl: string | null;
  videoRef: React.RefObject<HTMLVideoElement | null>; onPlay: () => void; onTime: (t: number) => void; onDuration: (d: number) => void;
  jobId?: string; placeholder?: React.ReactNode;
  edit: EditOpts; onEdit: (e: EditOpts) => void; selectedSticker: string | null; onSelectSticker: (id: string | null) => void;
  /** the band over the old subtitles and the logo boxes can be dragged (while their panel is open) */
  editAreas?: boolean;
}) {
  // while playing, the parts cut out are jumped over, as in the exported video
  const cutsRef = useRef(edit.cuts);
  cutsRef.current = edit.cuts;
  const latestEdit = useRef(edit);
  latestEdit.current = edit;
  const stage = useRef<HTMLDivElement>(null), blurRef = useRef<HTMLVideoElement>(null), frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [nat, setNat] = useState({ w: 16, h: 9 });
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [still, setStill] = useState<string | null>(null);
  const [stillBusy, setStillBusy] = useState(false);
  // the exact frame is a picture in memory: let it go once another replaces it, or the player closes
  useEffect(() => () => { if (still) URL.revokeObjectURL(still); }, [still]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the clock: every frame while playing when something on the picture moves by itself (logo, slow zoom, fade,
  // progress bar), so it moves smoothly; else 20 times a second, which is enough for the subtitles
  const moving = useRef(false);
  moving.current = (look.logo.enabled && !!logoUrl) || look.fx.zoom === "slow" || look.fx.fade || look.fx.progress;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0, last = 0, drawn = 0;
    const step = () => {
      const cut = !v.paused && cutAt(cutsRef.current, v.currentTime);
      if (cut) v.currentTime = Math.min(cut.to, v.duration || cut.to);
      const now = v.currentTime;
      if (v.paused || moving.current || performance.now() - drawn > 50) { drawn = performance.now(); setT(now); }
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

  // the speed of the whole video (the live sound follows the video's rate)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => { v.defaultPlaybackRate = edit.speed; v.playbackRate = edit.speed; };
    apply();
    v.addEventListener("loadedmetadata", apply);
    return () => v.removeEventListener("loadedmetadata", apply);
  }, [edit.speed, src, view, videoRef]);
  const punch = useMemo(() => (look.fx.zoom === "punch" && segs ? punchRanges(segs, dur) : []), [look.fx.zoom, segs, dur]);

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
  const zoom = zoomAt(fx.zoom, t, punch);
  const inCut = cutAt(edit.cuts, t);
  // karaoke: the word being said at t, its time shared out over the line as the export does
  // (cut into words once per line, not on every frame)
  const words = useMemo(() => (s.karaoke && segs && i >= 0 && segs[i].km ? timeWords(segs[i].km, segs[i].start, segs[i].end) : null),
    [s.karaoke, segs, i]);
  const lit = words ? Math.max(0, words.findIndex((w) => t < w.to)) : -1;

  /** Dragging a sticker on the picture moves it (x / y in % of the picture, as the export places it). */
  const dragSticker = (e: React.PointerEvent, id: string) => {
    e.preventDefault(); e.stopPropagation();
    onSelectSticker(id);
    const box = frameRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const x = Math.round(Math.max(0, Math.min(100, ((ev.clientX - box.left) / box.width) * 100)) * 10) / 10;
      const y = Math.round(Math.max(0, Math.min(100, ((ev.clientY - box.top) / box.height) * 100)) * 10) / 10;
      onEdit({ ...latestEdit.current, stickers: latestEdit.current.stickers.map((k) => (k.id === id ? { ...k, x, y } : k)) });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The band over the old subtitles ("band") or a logo box (its index): moved by dragging it, resized by its corner.
  // In % of the source picture, like the export.
  const latestLook = useRef(look);
  latestLook.current = look;
  const dragArea = (e: React.PointerEvent, which: number | "band", mode: "move" | "size", pw: number, ph: number) => {
    if (!editAreas) return;
    e.preventDefault(); e.stopPropagation();
    const fx0 = latestLook.current.fx;
    const a0 = which === "band" ? { x: fx0.coverX, y: fx0.coverY, w: fx0.coverW, h: fx0.coverH } : fx0.logoAreas[which];
    if (!a0) return;
    const sx = e.clientX, sy = e.clientY;
    const lim = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)) * 10) / 10;
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - sx) / pw) * 100, dy = ((ev.clientY - sy) / ph) * 100;
      const a = mode === "move"
        ? { ...a0, x: lim(a0.x + dx, 0, 100 - a0.w), y: lim(a0.y + dy, 0, 100 - a0.h) }
        : { ...a0, w: lim(a0.w + dx, 1, 100 - a0.x), h: lim(a0.h + dy, 1, 100 - a0.y) };
      const l = latestLook.current;
      onLook({ ...l, fx: which === "band"
        ? { ...l.fx, coverX: a.x, coverY: a.y, coverW: a.w, coverH: a.h }
        : { ...l.fx, logoAreas: l.fx.logoAreas.map((x, i) => (i === which ? a : x)) } });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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
        body: JSON.stringify({ sub: s, logo: lg, out, fx, edit, t }) });
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
            <div className="pic-box" style={{ left: px, top: py, width: pw, height: ph }}>
              <video ref={videoRef} src={src} playsInline onClick={() => { onSelectSticker(null); toggle(); }} className="pic"
                style={{ inset: 0, width: "100%", height: "100%", filter, transform: [flip, zoom !== 1 && `scale(${zoom.toFixed(4)})`].filter(Boolean).join(" ") || undefined }} />
            </div>
            {fx.cover && (
              <div className={`cover-band ${fx.coverMode} ${editAreas ? "edit" : ""}`}
                style={{ left: px + (pw * fx.coverX) / 100, width: (pw * Math.min(fx.coverW, 100 - fx.coverX)) / 100,
                  top: py + (ph * fx.coverY) / 100, height: (ph * Math.min(fx.coverH, 100 - fx.coverY)) / 100,
                  ...(fx.coverMode === "box" && { background: fx.coverColor }) }}
                onPointerDown={(e) => dragArea(e, "band", "move", pw, ph)} title={editAreas ? "Drag to move" : undefined}>
                {editAreas && <span className="area-size" onPointerDown={(e) => dragArea(e, "band", "size", pw, ph)} title="Drag to resize" />}
              </div>
            )}
            {fx.logoAreas.map((a, k) => (
              <div key={k} className={`cover-band ${fx.logoAreaMode} ${editAreas ? "edit" : ""}`}
                style={{ left: px + (pw * a.x) / 100, width: (pw * a.w) / 100, top: py + (ph * a.y) / 100, height: (ph * a.h) / 100 }}
                onPointerDown={(e) => dragArea(e, k, "move", pw, ph)} title={editAreas ? "Drag to move" : undefined}>
                {editAreas && <><b className="area-label">{k + 1}</b>
                  <span className="area-size" onPointerDown={(e) => dragArea(e, k, "size", pw, ph)} title="Drag to resize" /></>}
              </div>
            ))}
            {fx.title && (
              <div className="ov-title" style={{ ...TITLE_POS[fx.titlePos], color: fx.titleColor,
                fontFamily: `"${s.font}", "Khmer UI", sans-serif`, fontSize: fx.titleSize * unit }}>{fx.title}</div>
            )}
            {lg.enabled && logoUrl && inSlide && (
              <img className="ov-logo" src={logoUrl} alt="" style={{ width: lw, left: lx, opacity: lg.opacity, [lg.position]: "5%" }} />
            )}
            {showSub && (
              <div className="ov-sub" style={{ [s.position]: s.margin * unit }}>
                <span key={i} className={`anim-${s.anim}`} style={subTextStyle(s, unit)}>
                  {words ? words.map((w, k) => <span key={k} style={k === lit ? { color: s.hiColor } : undefined}>{w.text}</span>) : line!.km}
                  {s.bilingual && line!.text && <><br /><span style={{ fontSize: s.size * 0.72 * unit }}>{line!.text}</span></>}
                </span>
              </div>
            )}
            {!look.burn && line?.km && <div className="ov-cc">{line.km}</div>}
            {fx.progress && dur > 0 && <div className="ov-progress" style={{ width: `${(t / dur) * 100}%`, background: fx.progressColor, height: Math.max(2, fh / 160) }} />}
            {edit.stickers.filter((k) => (t >= k.from && t <= k.to) || k.id === selectedSticker).map((k) => (
              <img key={k.id} src={`/api/branding/stickers/${encodeURIComponent(k.file)}`} alt="" draggable={false}
                className={`ov-sticker ${k.id === selectedSticker ? "on" : ""} ${t >= k.from && t <= k.to ? "" : "off"}`}
                style={{ left: `${k.x}%`, top: `${k.y}%`, width: (fw * k.size) / 100 }}
                onPointerDown={(e) => dragSticker(e, k.id)} title="Drag to move" />
            ))}
            {fade > 0 && <div className="ov-fade" style={{ opacity: Math.min(1, fade) }} />}
            {inCut && <div className="ov-cut">✂ Cut out – skipped in the video</div>}
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
});
