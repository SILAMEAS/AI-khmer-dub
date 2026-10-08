"use client";

/**
 * The timeline at the bottom: ruler and playhead, the cut, subtitle lines and sound parts.
 * One scroll area (so the horizontal scrollbar is always at the bottom); the ruler stays on top and the track
 * names on the left while scrolling. Ctrl + mouse wheel zooms around the pointer.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { clock, usePlayhead, type Part, type Playhead, type Range, type Segment, type Sticker } from "./common";

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const LABEL = 96;   // width of the track names column (px)
const MAX_ZOOM = 30;

/**
 * One subtitle line on its track. A long video has thousands: each is only drawn again when it changes itself
 * (its text, selected, the zoom), not when another line is typed in.
 */
const SubClip = memo(function SubClip({ s, i, pps, speakers, on, edited, onPick }: {
  s: Segment; i: number; pps: number; speakers: number; on: boolean; edited: boolean; onPick: (i: number, t: number) => void;
}) {
  return (
    <div className={`tl-clip sub ${speakers ? `spk s${(s.speaker ?? 0) % 6}` : ""} ${on ? "on" : ""} ${s.km.trim() ? "" : "empty"}`}
      style={{ left: s.start * pps, width: Math.max(4, (s.end - s.start) * pps - 1) }} title={`${clock(s.start)} ${s.km}`}
      onPointerDown={(e) => { e.stopPropagation(); onPick(i, s.start); }}>
      {edited && <i className="dot" title="Edited: its voice is made again in a moment" />}
      <span className="km">{s.km}</span>
    </div>
  );
});

/** The playhead: the only part of the timeline that moves while playing, so the only one drawn again then. */
function Head({ playhead, pps, zoom, scroller, onDrag }: {
  playhead: Playhead; pps: number; zoom: number; scroller: React.RefObject<HTMLDivElement | null>; onDrag: (e: React.PointerEvent) => void;
}) {
  const time = usePlayhead(playhead);
  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom === 1) return;
    const px = time * pps, view = el.clientWidth - LABEL;
    if (px < el.scrollLeft || px > el.scrollLeft + view - 40) el.scrollLeft = px - view * 0.2;
  }, [time, zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="tl-playhead" style={{ left: time * pps }} onPointerDown={onDrag} />;
}

export const Timeline = memo(function Timeline({ duration, playhead, onSeek, segs, edited, selected, onSelect, parts, selectedPart, onSelectPart,
  trim, onTrim, speakers, cuts, selectedCut, onSelectCut, marks, stickers, selectedSticker, onSelectSticker }: {
  duration: number; playhead: Playhead; onSeek: (t: number) => void;
  segs: Segment[] | null; edited: Set<number>; selected: number | null; onSelect: (i: number | null) => void;
  parts: Part[]; selectedPart: number | null; onSelectPart: (i: number | null) => void;
  trim: { from: number; to: number } | null; onTrim?: (t: { from: number; to: number }) => void; speakers: number;
  /** parts cut out of the video, the In / Out marks for the next cut, stickers */
  cuts: Range[]; selectedCut: number | null; onSelectCut: (i: number | null) => void;
  marks: { in: number | null; out: number | null };
  stickers: Sticker[]; selectedSticker: string | null; onSelectSticker: (id: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const d = Math.max(duration, 1);
  const pps = ((width - LABEL - 16) / d) * zoom; // pixels per second
  const x = (t: number) => t * pps;
  const step = STEPS.find((s) => s * pps >= 70) ?? 600;

  // a line clicked: the same function every time, so the lines that didn't change aren't drawn again
  const latest = useRef({ onSelect, onSeek });
  latest.current = { onSelect, onSeek };
  const pick = useCallback((i: number, t: number) => { latest.current.onSelect(i); latest.current.onSeek(t); }, []);

  // Ctrl + wheel: zoom, keeping the moment under the pointer where it is
  const zoomRef = useRef({ zoom, pps });
  zoomRef.current = { zoom, pps };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const { zoom: z, pps: p } = zoomRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.25 : 0.8)));
      const px = e.clientX - el.getBoundingClientRect().left - LABEL + el.scrollLeft, t = px / p;
      setZoom(next);
      requestAnimationFrame(() => { el.scrollLeft = t * p * (next / z) - (px - el.scrollLeft); });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  /** Dragging: the playhead (seek) or a cut handle. */
  const drag = (e: React.PointerEvent, what: "seek" | "from" | "to") => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const at = (cx: number) => Math.max(0, Math.min(d, (cx - rect.left - LABEL + el.scrollLeft) / pps));
    const apply = (cx: number) => {
      const t = at(cx);
      if (what === "seek") onSeek(t);
      else if (trim && onTrim) {
        const end = trim.to || d;
        if (what === "from") onTrim({ ...trim, from: Math.min(t, end - 1) });
        else onTrim({ ...trim, to: Math.max(t, trim.from + 1) >= d - 0.05 ? 0 : Math.max(t, trim.from + 1) });
      }
    };
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks: number[] = [];
  for (let s = 0; s <= d; s += step) ticks.push(s);
  const full = x(d) + 16;
  const tEnd = trim ? trim.to || d : d;

  return (
    <div className="timeline">
      <div className="tl-bar">
        <span className="note">{segs?.length ? `${segs.length} lines` : "Timeline"}{edited.size ? ` · ${edited.size} edited` : ""}
          {cuts.length ? ` · ${cuts.length} cut${cuts.length > 1 ? "s" : ""} (−${clock(cuts.reduce((s, c) => s + c.to - c.from, 0))})` : ""}
          {" · "}<kbd>I</kbd> <kbd>O</kbd> mark · <kbd>Del</kbd> cut out</span>
        <div className="row nowrap tl-zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} title="Zoom out" disabled={zoom <= 1}>－</button>
          <input type="range" min={1} max={MAX_ZOOM} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} title="Zoom (Ctrl + wheel)" />
          <button type="button" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))} title="Zoom in" disabled={zoom >= MAX_ZOOM}>＋</button>
          <button type="button" onClick={() => setZoom(1)} title="Show the whole video" disabled={zoom === 1}>Fit</button>
        </div>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-grid" style={{ width: LABEL + full }}>
          <div className="tl-labels">
            <div className="tl-corner" />
            <div>🎬 Video</div>
            <div>💬 Subtitles</div>
            <div>🔊 Sound</div>
            <div>🖼 Stickers</div>
          </div>
          <div className="tl-content" style={{ width: full }} onPointerDown={(e) => drag(e, "seek")}>
            <div className="tl-ruler">
              {ticks.map((s) => <span key={s} style={{ left: x(s) }}>{clock(s)}</span>)}
            </div>
            <div className="tl-track">
              {duration > 0 && <div className="tl-clip video" style={{ left: 0, width: x(d) }} />}
              {trim && (
                <>
                  {trim.from > 0 && <div className="tl-out" style={{ left: 0, width: x(trim.from) }} />}
                  {tEnd < d && <div className="tl-out" style={{ left: x(tEnd), width: x(d - tEnd) }} />}
                  <div className="tl-handle" style={{ left: x(trim.from) - 5 }} title="Start of the cut" onPointerDown={(e) => drag(e, "from")} />
                  <div className="tl-handle" style={{ left: x(tEnd) - 5 }} title="End of the cut" onPointerDown={(e) => drag(e, "to")} />
                </>
              )}
              {cuts.map((c, i) => (
                <div key={i} className={`tl-cut ${selectedCut === i ? "on" : ""}`} style={{ left: x(c.from), width: Math.max(3, x(c.to - c.from)) }}
                  title={`Cut out ${clock(c.from, true)} – ${clock(c.to, true)} · click to select, Delete key or ↺ to put back`}
                  onPointerDown={(e) => { e.stopPropagation(); onSelectCut(i); onSeek(c.from); }} />
              ))}
              {marks.in !== null && marks.out !== null && marks.out > marks.in && (
                <div className="tl-range" style={{ left: x(marks.in), width: x(marks.out - marks.in) }} />
              )}
              {marks.in !== null && <div className="tl-mark in" style={{ left: x(marks.in) }} title="In" />}
              {marks.out !== null && <div className="tl-mark out" style={{ left: x(marks.out) }} title="Out" />}
            </div>
            <div className="tl-track">
              {segs?.map((s, i) => (
                <SubClip key={i} s={s} i={i} pps={pps} speakers={speakers} on={selected === i} edited={edited.has(i)} onPick={pick} />
              ))}
            </div>
            <div className="tl-track">
              {parts.map((p, i) => (
                <div key={i} className={`tl-clip part ${selectedPart === i ? "on" : ""}`} style={{ left: x(p.from), width: Math.max(4, x(p.to - p.from)) }}
                  title={`Original ${p.orig}% · Khmer ${p.khmer}%`} onPointerDown={(e) => { e.stopPropagation(); onSelectPart(i); }}>
                  <span>O {p.orig}% · K {p.khmer}%</span>
                </div>
              ))}
            </div>
            <div className="tl-track">
              {stickers.map((s) => (
                <div key={s.id} className={`tl-clip sticker ${selectedSticker === s.id ? "on" : ""}`}
                  style={{ left: x(s.from), width: Math.max(4, x(s.to - s.from)) }} title={`${clock(s.from)} – ${clock(s.to)}`}
                  onPointerDown={(e) => { e.stopPropagation(); onSelectSticker(s.id); onSeek(s.from); }}>
                  <img src={`/api/branding/stickers/${encodeURIComponent(s.file)}`} alt="" />
                </div>
              ))}
            </div>
            <Head playhead={playhead} pps={pps} zoom={zoom} scroller={scroller} onDrag={(e) => drag(e, "seek")} />
          </div>
        </div>
      </div>
    </div>
  );
});
