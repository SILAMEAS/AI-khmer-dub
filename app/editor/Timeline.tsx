"use client";

/** The timeline at the bottom: ruler and playhead, the cut, subtitle lines and sound parts. */
import { useEffect, useRef, useState } from "react";
import { clock, type Part, type Segment } from "./common";

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function Timeline({ duration, time, onSeek, segs, edited, selected, onSelect, parts, selectedPart, onSelectPart,
  trim, onTrim, speakers }: {
  duration: number; time: number; onSeek: (t: number) => void;
  segs: Segment[] | null; edited: Set<number>; selected: number | null; onSelect: (i: number | null) => void;
  parts: Part[]; selectedPart: number | null; onSelectPart: (i: number | null) => void;
  trim: { from: number; to: number } | null; onTrim?: (t: { from: number; to: number }) => void; speakers: number;
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
  const pps = ((width - 16) / d) * zoom; // pixels per second
  const x = (t: number) => t * pps;
  const step = STEPS.find((s) => s * pps >= 70) ?? 600;

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom === 1) return;
    const px = x(time);
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = px - el.clientWidth * 0.2;
  }, [time, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Dragging: the playhead (seek) or a cut handle. */
  const drag = (e: React.PointerEvent, what: "seek" | "from" | "to") => {
    const el = scroller.current!;
    const rect = el.getBoundingClientRect();
    const at = (cx: number) => Math.max(0, Math.min(d, (cx - rect.left + el.scrollLeft) / pps));
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
        <span className="note">{segs ? `${segs.length} lines` : "Timeline"}{edited.size ? ` · ${edited.size} edited` : ""}</span>
        <label className="row nowrap tl-zoom">🔍
          <input type="range" min={1} max={30} step={0.5} value={zoom} onChange={(e) => setZoom(+e.target.value)} />
        </label>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <div className="tl-ruler-label" />
          <div>🎬 Video</div>
          <div>💬 Subtitles</div>
          <div>🔊 Sound</div>
        </div>
        <div className="tl-scroll" ref={scroller}>
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
            </div>
            <div className="tl-track">
              {segs?.map((s, i) => (
                <div key={i} className={`tl-clip sub ${speakers ? `spk s${(s.speaker ?? 0) % 6}` : ""} ${selected === i ? "on" : ""} ${s.km.trim() ? "" : "empty"}`}
                  style={{ left: x(s.start), width: Math.max(4, x(s.end - s.start) - 1) }} title={`${clock(s.start)} ${s.km}`}
                  onPointerDown={(e) => { e.stopPropagation(); onSelect(i); onSeek(s.start); }}>
                  {edited.has(i) && <i className="dot" title="Edited: the voice is made again on Update voices" />}
                  <span className="km">{s.km}</span>
                </div>
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
            <div className="tl-playhead" style={{ left: x(time) }} onPointerDown={(e) => drag(e, "seek")} />
          </div>
        </div>
      </div>
    </div>
  );
}
