"use client";

/**
 * Editing tools beyond the look: cutting (In / Out and ripple delete like Premiere, the silent parts found for you),
 * speed, image stickers, the thumbnail maker, the translation glossary and batch projects.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyGlossary, type GlossEntry } from "@/lib/glossary";
import {
  api, clock, mergeRanges, outputDuration, parseTime, uploadFile, SPEEDS, type EditOpts, type Job, type Range, type Segment,
  type Sticker,
} from "./common";

const Hint = ({ children }: { children: React.ReactNode }) => <small className="note">{children}</small>;

/** A time field (1:23.4) that is taken when you leave it. */
export function TimeField({ value, onChange, placeholder }: { value: number; onChange: (t: number) => void; placeholder?: string }) {
  const [s, setS] = useState(value ? clock(value, true) : "");
  useEffect(() => setS(value ? clock(value, true) : ""), [value]);
  return <input type="text" className="time-field" value={s} placeholder={placeholder} onChange={(e) => setS(e.target.value)}
    onBlur={() => { const t = parseTime(s); if (Number.isNaN(t)) setS(value ? clock(value, true) : ""); else onChange(t); }} />;
}

export type Marks = { in: number | null; out: number | null };
type EditProps = { value: EditOpts; onChange: (e: EditOpts) => void };

/** Adds parts to cut out (joined with the ones already there). */
export const addCuts = (e: EditOpts, rs: Range[]): EditOpts => ({ ...e, cuts: mergeRanges([...e.cuts, ...rs]) });

// ---------------------------------------------------------------- cut and speed

/** Speed, cutting by In / Out marks or by line, and removing the silent parts (left panel of Edit). */
export function EditPanel({ value: e, onChange, time, duration, marks, onMarks, segs, jobId }: EditProps & {
  time: number; duration: number; marks: Marks; onMarks: (m: Marks) => void; segs: Segment[] | null; jobId?: string;
}) {
  const [min, setMin] = useState(0.8), [db, setDb] = useState(-35);
  const [found, setFound] = useState<Range[] | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const line = segs?.find((s) => s.start <= time && time < s.end);
  const canCut = marks.in !== null && marks.out !== null && marks.out > marks.in + 0.05;
  async function findSilent() {
    if (!jobId) return;
    setBusy(true); setErr(""); setFound(null);
    try { setFound(await api<Range[]>(`/api/jobs/${jobId}/silences`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ min, db }) })); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  const total = (rs: Range[]) => rs.reduce((s, r) => s + r.to - r.from, 0);
  return (
    <div className="pane">
      <h4>Speed</h4>
      <div className="seg-btns">
        {SPEEDS.map((s) => <button type="button" key={s} className={e.speed === s ? "on" : ""} onClick={() => onChange({ ...e, speed: s })}>{s}×</button>)}
      </div>
      <Hint>The whole video, voices included (their pitch stays). The player plays at this speed too.</Hint>

      <h4>✂ Cut out a part</h4>
      <div className="row nowrap">
        <button type="button" className="btn ghost sm" onClick={() => onMarks({ ...marks, in: time })} title="I">⇤ In <kbd>I</kbd></button>
        <span className="tc-small">{marks.in !== null ? clock(marks.in, true) : "–"}</span>
        <button type="button" className="btn ghost sm" onClick={() => onMarks({ ...marks, out: time })} title="O">Out ⇥ <kbd>O</kbd></button>
        <span className="tc-small">{marks.out !== null ? clock(marks.out, true) : "–"}</span>
      </div>
      <div className="row">
        <button type="button" className="btn sm" disabled={!canCut}
          onClick={() => { onChange(addCuts(e, [{ from: marks.in!, to: marks.out! }])); onMarks({ in: null, out: null }); }}>
          ✂ Cut out In → Out <kbd>Del</kbd></button>
        {(marks.in !== null || marks.out !== null) && <button type="button" className="btn ghost sm" onClick={() => onMarks({ in: null, out: null })}>Clear marks</button>}
      </div>
      {line && (
        <button type="button" className="btn ghost sm" onClick={() => onChange(addCuts(e, [{ from: line.start, to: line.end }]))}>
          ✂ Cut out this line ({clock(line.start)} – {clock(line.end)})</button>
      )}
      <Hint>Like Premiere&apos;s ripple delete: the part goes, the rest closes up – picture, sound and subtitles together.
        Cuts show in red in the timeline; nothing is lost, put them back any time.</Hint>

      <h4>Remove silent parts</h4>
      <label className="slider-row"><span>Longer than</span>
        <input type="range" min={0.4} max={3} step={0.1} value={min} onChange={(x) => setMin(+x.target.value)} /><b>{min.toFixed(1)} s</b></label>
      <label className="slider-row"><span>Quieter than</span>
        <input type="range" min={-50} max={-20} step={1} value={db} onChange={(x) => setDb(+x.target.value)} /><b>{db} dB</b></label>
      <div className="row">
        <button type="button" className="btn ghost sm" disabled={!jobId || busy} onClick={findSilent}>{busy ? "Listening…" : "🔍 Find silent parts"}</button>
        {found && found.length > 0 && (
          <button type="button" className="btn sm" onClick={() => { onChange(addCuts(e, found)); setFound(null); }}>
            ✂ Cut out {found.length} ({clock(total(found))})</button>
        )}
      </div>
      {found && !found.length && <Hint>No silent parts this long and this quiet – try a shorter length or move “quieter than” right.</Hint>}
      <Hint>Jump cut: pauses where nobody speaks and the sound is quiet. Music under them? Move “quieter than” to the right.</Hint>
      {err && <div className="err">{err}</div>}

      {duration > 0 && (e.cuts.length > 0 || e.speed !== 1) && (
        <div className="ok-note">Exported length: {clock(outputDuration(e, duration))} (was {clock(duration)})</div>
      )}
    </div>
  );
}

/** The parts cut out, each to check or put back (right panel of Edit). */
export function CutList({ value: e, onChange, selected, onSelect, onSeek, onPlayFrom }: EditProps & {
  selected: number | null; onSelect: (i: number | null) => void; onSeek: (t: number) => void; onPlayFrom: (t: number) => void;
}) {
  return (
    <div className="pane">
      <h4>Cuts ({e.cuts.length})</h4>
      {!e.cuts.length && <Hint>Nothing cut yet. Mark In and Out while watching (keys I and O), then Delete.</Hint>}
      <div className="cut-list">
        {e.cuts.map((c, i) => (
          <div key={i} className={`cut-row ${selected === i ? "on" : ""}`} onClick={() => { onSelect(i); onSeek(c.from); }}>
            <span>{clock(c.from, true)} – {clock(c.to, true)} <small>({(c.to - c.from).toFixed(1)} s)</small></span>
            <button type="button" className="btn ghost sm" title="Play across the cut, as the video will be" onClick={(x) => { x.stopPropagation(); onPlayFrom(Math.max(0, c.from - 2)); }}>▶</button>
            <button type="button" className="btn ghost sm" title="Put back" onClick={(x) => { x.stopPropagation(); onChange({ ...e, cuts: e.cuts.filter((_, k) => k !== i) }); onSelect(null); }}>↺</button>
          </div>
        ))}
      </div>
      {e.cuts.length > 1 && <button type="button" className="btn ghost sm" onClick={() => { onChange({ ...e, cuts: [] }); onSelect(null); }}>Put all back</button>}
    </div>
  );
}

// ---------------------------------------------------------------- stickers

type LibItem = { file: string; url: string };

/** The sticker library: upload images once, click one to put it on the video at the playhead (left panel). */
export function StickerLibrary({ value: e, onChange, time, duration, onSelect }: EditProps & {
  time: number; duration: number; onSelect: (id: string) => void;
}) {
  const [lib, setLib] = useState<LibItem[]>([]);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api<LibItem[]>("/api/branding/stickers").then(setLib).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  async function upload(files: FileList | null) {
    setErr("");
    for (const f of [...(files ?? [])]) {
      try {
        const r = await fetch(`/api/branding/stickers?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      } catch (x) { setErr((x as Error).message); }
    }
    load();
  }
  function add(file: string) {
    const id = Math.random().toString(36).slice(2, 9);
    const from = Math.floor(time * 10) / 10;
    onChange({ ...e, stickers: [...e.stickers, { id, file, from, to: Math.min(duration || from + 3, from + 3), x: 50, y: 50, size: 20 }] });
    onSelect(id);
  }
  async function remove(file: string) {
    if (!confirm("Remove this image from the library? It is also taken off every video that uses it.")) return;
    await fetch(`/api/branding/stickers?file=${encodeURIComponent(file)}`, { method: "DELETE" });
    onChange({ ...e, stickers: e.stickers.filter((s) => s.file !== file) });
    load();
  }
  return (
    <div className="pane">
      <button type="button" className="btn ghost sm" onClick={() => input.current?.click()}>＋ Upload images</button>
      <input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.gif" hidden onChange={(x) => upload(x.target.files)} />
      <Hint>PNG with a transparent background looks best; GIFs keep moving. Kept for every video.</Hint>
      {err && <div className="err">{err}</div>}
      <div className="sticker-grid">
        {lib.map((s) => (
          <div key={s.file} className="sticker-tile">
            <button type="button" onClick={() => add(s.file)} title={`Add at ${clock(time)}`}><img src={s.url} alt={s.file} /></button>
            <button type="button" className="del" title="Remove from the library" onClick={() => remove(s.file)}>✕</button>
          </div>
        ))}
        {!lib.length && <span className="note">No images yet</span>}
      </div>
      {e.stickers.length > 0 && <h4>On this video ({e.stickers.length})</h4>}
      {e.stickers.map((s) => (
        <button type="button" key={s.id} className="cut-row" onClick={() => onSelect(s.id)}>
          <img src={`/api/branding/stickers/${encodeURIComponent(s.file)}`} alt="" className="mini" />
          <span>{clock(s.from)} – {clock(s.to)}</span>
        </button>
      ))}
    </div>
  );
}

/** The selected sticker: when, how big, where (right panel). It can also be dragged on the picture. */
export function StickerSettings({ value: e, onChange, id, time, onDone }: EditProps & { id: string | null; time: number; onDone: () => void }) {
  const s = e.stickers.find((k) => k.id === id);
  if (!s) return <div className="pane"><Hint>Click an image on the left to add it at the playhead, then drag it on the picture.</Hint></div>;
  const set = (p: Partial<Sticker>) => onChange({ ...e, stickers: e.stickers.map((k) => (k.id === s.id ? { ...k, ...p } : k)) });
  return (
    <div className="pane">
      <img src={`/api/branding/stickers/${encodeURIComponent(s.file)}`} alt="" className="sticker-preview" />
      <div className="row nowrap"><span className="lbl">From</span><TimeField value={s.from} onChange={(t) => set({ from: t, to: Math.max(s.to, t + 0.5) })} />
        <button type="button" className="btn ghost sm" onClick={() => set({ from: time, to: Math.max(s.to, time + 0.5) })}>⇤ Here</button></div>
      <div className="row nowrap"><span className="lbl">To</span><TimeField value={s.to} onChange={(t) => set({ to: Math.max(t, s.from + 0.2) })} />
        <button type="button" className="btn ghost sm" onClick={() => set({ to: Math.max(time, s.from + 0.2) })}>Here ⇥</button></div>
      <label className="slider-row"><span>Size</span><input type="range" min={3} max={100} value={s.size} onChange={(x) => set({ size: +x.target.value })} /><b>{s.size}%</b></label>
      <label className="slider-row"><span>Across</span><input type="range" min={0} max={100} value={s.x} onChange={(x) => set({ x: +x.target.value })} /><b>{Math.round(s.x)}%</b></label>
      <label className="slider-row"><span>Down</span><input type="range" min={0} max={100} value={s.y} onChange={(x) => set({ y: +x.target.value })} /><b>{Math.round(s.y)}%</b></label>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => {
          const copy = { ...s, id: Math.random().toString(36).slice(2, 9), from: s.to, to: s.to + (s.to - s.from) };
          onChange({ ...e, stickers: [...e.stickers, copy] });
        }}>Duplicate after</button>
        <button type="button" className="btn ghost sm" onClick={() => { onChange({ ...e, stickers: e.stickers.filter((k) => k.id !== s.id) }); onDone(); }}>🗑 Remove</button>
      </div>
      <Hint>Drag it on the picture to move it.</Hint>
    </div>
  );
}

// ---------------------------------------------------------------- thumbnail

export type Thumb = {
  text: string; color: string; outline: string; size: number; pos: "top" | "middle" | "bottom"; shape: "16:9" | "9:16"; logo: boolean; pop: boolean;
};
export const DEFAULT_THUMB: Thumb = { text: "", color: "#ffd400", outline: "#000000", size: 12, pos: "bottom", shape: "16:9", logo: true, pop: true };

/** Title text and style of the thumbnail (left panel). */
export function ThumbnailStyle({ value: th, onChange, hasLogo }: { value: Thumb; onChange: (t: Thumb) => void; hasLogo: boolean }) {
  const set = (p: Partial<Thumb>) => onChange({ ...th, ...p });
  return (
    <div className="pane">
      <label className="f">Title on the thumbnail</label>
      <textarea className="km" rows={3} value={th.text} maxLength={120} placeholder="e.g. ភាគទី ១ – រឿងថ្មី" onChange={(e) => set({ text: e.target.value })} />
      <div className="pane-grid">
        <label><span>Size <b>{th.size}</b></span><input type="range" min={5} max={25} value={th.size} onChange={(e) => set({ size: +e.target.value })} /></label>
        <label>Colour <span className="row nowrap"><input type="color" value={th.color} onChange={(e) => set({ color: e.target.value })} />
          <input type="color" value={th.outline} title="Outline" onChange={(e) => set({ outline: e.target.value })} /></span></label>
      </div>
      <label className="f">Place</label>
      <div className="seg-btns">
        {(["top", "middle", "bottom"] as const).map((p) => <button type="button" key={p} className={th.pos === p ? "on" : ""} onClick={() => set({ pos: p })}>{p[0].toUpperCase() + p.slice(1)}</button>)}
      </div>
      <label className="f">Shape</label>
      <div className="seg-btns">
        <button type="button" className={th.shape === "16:9" ? "on" : ""} onClick={() => set({ shape: "16:9" })}>16:9 YouTube · Facebook</button>
        <button type="button" className={th.shape === "9:16" ? "on" : ""} onClick={() => set({ shape: "9:16" })}>9:16 Shorts · TikTok</button>
      </div>
      <label className="check"><input type="checkbox" checked={th.pop} onChange={(e) => set({ pop: e.target.checked })} />
        <span>Make the colours pop<small>More contrast and colour, a little sharper</small></span></label>
      <label className="check"><input type="checkbox" checked={th.logo && hasLogo} disabled={!hasLogo} onChange={(e) => set({ logo: e.target.checked })} />
        <span>Your logo in the corner<small>{hasLogo ? "From the 🏷 Logo tab" : "Upload one on the 🏷 Logo tab"}</small></span></label>
    </div>
  );
}

/** Makes the thumbnail from the frame at the playhead (right panel). */
export function ThumbnailMaker({ value: th, jobId, time, sub, version }: { value: Thumb; jobId?: string; time: number; sub: object; version: number }) {
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function make() {
    if (!jobId) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/jobs/${jobId}/thumbnail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...th, t: time, sub }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      if (img) URL.revokeObjectURL(img);
      setImg(URL.createObjectURL(await r.blob()));
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="pane">
      <Hint>Pause the video on a strong frame (a face, action), then:</Hint>
      <button type="button" className="btn wide" disabled={!jobId || busy} onClick={make}>{busy ? "Making…" : `📸 Make from ${clock(time, true)}`}</button>
      {err && <div className="err">{err}</div>}
      {img && (
        <>
          <img src={img} alt="Thumbnail" className="thumb-preview" />
          <a className="btn ghost sm" href={`/api/jobs/${jobId}/files/thumbnail.jpg?download=1&v=${version}-${Date.now()}`}>⬇ Download JPG</a>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- glossary

/** Names and words always translated the same way: used for every new translation, and on the lines here now. */
export function Glossary({ segs, onSegs }: { segs: Segment[] | null; onSegs: (s: Segment[]) => void }) {
  const [rows, setRows] = useState<GlossEntry[]>([]);
  const [state, setState] = useState("");
  useEffect(() => { api<GlossEntry[]>("/api/branding/glossary").then(setRows).catch(() => {}); }, []);
  async function save(next: GlossEntry[]) {
    setRows(next); setState("");
    try { await api("/api/branding/glossary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }); setState("Saved"); }
    catch (x) { setState((x as Error).message); }
  }
  const valid = rows.filter((r) => r.from.trim() && r.to.trim());
  const changes = segs ? segs.filter((s) => applyGlossary(s.km, valid) !== s.km).length : 0;
  return (
    <details className="net glossary">
      <summary>📖 Glossary{valid.length ? ` (${valid.length})` : ""}</summary>
      <Hint>A name or word (Chinese, English, or Khmer the translator gets wrong) → the Khmer to always use.</Hint>
      {rows.map((r, i) => (
        <div key={i} className="row nowrap">
          <input type="text" value={r.from} placeholder="李明 / Li Ming" onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, from: e.target.value } : x)))} onBlur={() => save(rows)} />
          <span>→</span>
          <input type="text" className="km" value={r.to} placeholder="លី មីង" onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, to: e.target.value } : x)))} onBlur={() => save(rows)} />
          <button type="button" className="btn ghost sm" onClick={() => save(rows.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => setRows([...rows, { from: "", to: "" }])}>＋ Add</button>
        {segs && <button type="button" className="btn ghost sm" disabled={!changes} onClick={() => onSegs(segs.map((s) => ({ ...s, km: applyGlossary(s.km, valid) })))}>
          Apply to these lines ({changes})</button>}
        <small className="note">{state}</small>
      </div>
      <Hint>New videos use it while translating. On lines already translated only Khmer → Khmer fixes can be applied.</Hint>
    </details>
  );
}

// ---------------------------------------------------------------- batch

/** Many videos at once: links (one per line) and / or files, each its own project, done one after the other. */
export function Batch({ params, onDone }: { params: Record<string, string>; onDone: (lastId?: string) => void }) {
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [auto, setAuto] = useState(true);
  const [state, setState] = useState(""), [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const urls = links.split(/\r?\n/).map((l) => l.trim()).filter((l) => /https?:\/\//i.test(l));
  async function start() {
    setBusy(true);
    const p = { ...params, autoExport: String(auto) };
    let last: string | undefined, n = 0, failed = 0;
    const total = urls.length + files.length;
    for (const u of urls) {
      setState(`Adding ${++n}/${total}…`);
      try { last = (await api<Job>("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...p, url: u }) })).id; } catch { failed++; }
    }
    for (const f of files) {
      try { last = (await uploadFile(f, p, (pct) => setState(`Uploading ${++n > total ? total : n}/${total}: ${f.name} ${pct}%`))).id; } catch { failed++; }
    }
    setBusy(false); setLinks(""); setFiles([]);
    setState(`${total - failed} added${failed ? `, ${failed} failed` : ""} – they run one after the other (see Projects).`);
    onDone(last);
  }
  return (
    <div className="batch">
      <textarea rows={4} value={links} placeholder={"Links, one per line\nhttps://www.youtube.com/watch?v=…\nhttps://www.tiktok.com/…"} onChange={(e) => setLinks(e.target.value)} />
      <button type="button" className="import" onClick={() => input.current?.click()}>
        <b>＋ Add video files</b><small>{files.length ? `${files.length} chosen · ${(files.reduce((s, f) => s + f.size, 0) / 1048576).toFixed(0)} MB` : "Several at once"}</small>
      </button>
      <input ref={input} type="file" multiple accept="video/*,.mkv,.ts" hidden onChange={(e) => setFiles([...files, ...e.target.files ?? []])} />
      <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        <span>Export each one by itself<small>All the way to the finished video with the settings you see now – no stop to check</small></span></label>
      <button type="button" className="btn wide" disabled={busy || !(urls.length + files.length)} onClick={start}>
        ▶ Start {urls.length + files.length || ""} video{urls.length + files.length === 1 ? "" : "s"}</button>
      {state && <small className="note">{state}</small>}
    </div>
  );
}
