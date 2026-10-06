"use client";

import { useEffect, useRef, useState } from "react";

export type SubStyle = {
  font: string; size: number; bold: boolean;
  color: string; outline: string; outlineWidth: number;
  box: boolean; boxColor: string; boxOpacity: number;
  position: "bottom" | "top"; margin: number;
};
export type LogoOpts = {
  enabled: boolean; size: number; every: number; duration: number; position: "top" | "bottom"; opacity: number;
};
export type Look = { burn: boolean; sub: SubStyle; logo: LogoOpts };
type Font = { family: string; uploaded: boolean; url: string | null };
type Branding = { fonts: Font[]; logo: { url: string } | null; defaults: { sub: SubStyle; logo: LogoOpts } };

export const DEFAULT_LOOK: Look = {
  burn: false,
  sub: { font: "Khmer UI", size: 20, bold: false, color: "#ffffff", outline: "#000000", outlineWidth: 2,
    box: false, boxColor: "#000000", boxOpacity: 0.6, position: "bottom", margin: 28 },
  logo: { enabled: false, size: 12, every: 60, duration: 10, position: "top", opacity: 0.9 },
};

const SAMPLE = "សួស្តី! នេះជាចំណងជើងខ្មែរ។";
const SAVED = "khmerDubLook";

/** The look last used on this browser (remembered between videos). */
export function savedLook(): Look {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) || "null");
    if (s) return { burn: !!s.burn, sub: { ...DEFAULT_LOOK.sub, ...s.sub }, logo: { ...DEFAULT_LOOK.logo, ...s.logo } };
  } catch { /* storage blocked or old data: use the default */ }
  return DEFAULT_LOOK;
}

async function upload(url: string, file: File) {
  const r = await fetch(`${url}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

/** Subtitle style + sliding logo, with a live preview (and an exact preview frame when a job exists). */
export default function LookEditor({ value, onChange, jobId, previewAt }: {
  value: Look; onChange: (l: Look) => void; jobId?: string; previewAt?: number;
}) {
  const [brand, setBrand] = useState<Branding | null>(null);
  const [err, setErr] = useState("");
  const [frame, setFrame] = useState<string | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const [frameT, setFrameT] = useState(previewAt ?? 5);
  const fontInput = useRef<HTMLInputElement>(null), logoInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(200); // preview height, to scale sizes like the real video

  const load = () => fetch("/api/branding").then((r) => r.json()).then(setBrand).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { if (previewAt !== undefined) setFrameT(previewAt); }, [previewAt]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(SAVED, JSON.stringify(value)); } catch { /* not important */ } }, [value]);

  // uploaded fonts are loaded into the page so the preview can use them
  useEffect(() => {
    for (const f of brand?.fonts ?? []) {
      if (!f.url || [...document.fonts].some((ff) => ff.family === f.family)) continue;
      new FontFace(f.family, `url(${f.url})`).load().then((ff) => document.fonts.add(ff)).catch(() => {});
    }
  }, [brand]);

  const s = value.sub, lg = value.logo;
  const setSub = (p: Partial<SubStyle>) => { onChange({ ...value, sub: { ...s, ...p } }); setFrame(null); };
  const setLogo = (p: Partial<LogoOpts>) => { onChange({ ...value, logo: { ...lg, ...p } }); setFrame(null); };

  async function pick(kind: "font" | "logo", file?: File) {
    if (!file) return;
    setErr("");
    try {
      if (kind === "font") {
        const j = await upload("/api/branding/fonts", file);
        setSub({ font: j.family });
      } else {
        await upload("/api/branding/logo", file);
        setLogo({ enabled: true });
      }
      await load();
    } catch (e) { setErr((e as Error).message); }
  }

  async function removeLogo() {
    await fetch("/api/branding/logo", { method: "DELETE" });
    setLogo({ enabled: false });
    load();
  }

  async function exactPreview() {
    if (!jobId) return;
    setFrameBusy(true); setErr("");
    try {
      const r = await fetch(`/api/jobs/${jobId}/frame`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub: s, logo: lg, t: frameT }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      setFrame(URL.createObjectURL(await r.blob()));
    } catch (e) { setErr((e as Error).message); }
    finally { setFrameBusy(false); }
  }

  // preview: sizes follow the video (libass measures in a 288-line-high picture)
  const unit = h / 288;
  const rgba = (c: string, a: number) => `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;
  const textStyle: React.CSSProperties = {
    fontFamily: `"${s.font}", "Khmer UI", sans-serif`, fontSize: s.size * unit, fontWeight: s.bold ? 700 : 400,
    color: s.color, lineHeight: 1.25,
    ...(s.box
      ? { background: rgba(s.boxColor, s.boxOpacity), padding: `${Math.max(2, s.outlineWidth) * unit}px ${Math.max(2, s.outlineWidth) * unit * 1.5}px` }
      : { WebkitTextStroke: s.outlineWidth ? `${s.outlineWidth * unit * 2}px ${s.outline}` : undefined, paintOrder: "stroke fill" }),
  };
  const hasLogo = !!brand?.logo;

  return (
    <div className="look">
      <div className="look-preview" ref={box}>
        {hasLogo && lg.enabled && (
          <img className="look-logo" src={brand!.logo!.url} alt="" style={{
            width: `${lg.size}%`, opacity: lg.opacity, [lg.position]: "5%",
            animationDuration: `${Math.max(2, lg.duration)}s`,
          }} />
        )}
        {(value.burn || !jobId) && (
          <div className="look-sub" style={{ [s.position]: s.margin * unit }}>
            <span style={textStyle}>{SAMPLE}</span>
          </div>
        )}
        <small className="look-tag">Preview{value.burn ? "" : " (subtitles not burned in)"}</small>
      </div>

      <label className="check">
        <input type="checkbox" checked={value.burn} onChange={(e) => onChange({ ...value, burn: e.target.checked })} />
        <span>Burn subtitles into the picture<small>Needed for the style below; the selectable subtitle track and .srt are always included too</small></span>
      </label>

      <fieldset className="look-group" disabled={!value.burn}>
        <legend>Subtitle style</legend>
        <div className="look-grid">
          <label>Font
            <span className="row nowrap">
              <select value={s.font} onChange={(e) => setSub({ font: e.target.value })}>
                {!brand?.fonts.some((f) => f.family === s.font) && <option value={s.font}>{s.font}</option>}
                {brand?.fonts.map((f) => (
                  <option key={f.family} value={f.family} style={{ fontFamily: `"${f.family}"` }}>
                    {f.uploaded ? "★ " : ""}{f.family}
                  </option>
                ))}
              </select>
              <button type="button" className="btn ghost sm" onClick={() => fontInput.current?.click()}>Upload font</button>
              <input ref={fontInput} type="file" accept=".ttf,.otf" hidden onChange={(e) => pick("font", e.target.files?.[0])} />
            </span>
          </label>
          <label><span>Size: <b>{s.size}</b></span>
            <input type="range" min={12} max={40} value={s.size} onChange={(e) => setSub({ size: +e.target.value })} />
          </label>
          <label>Text colour
            <span className="row nowrap">
              <input type="color" value={s.color} onChange={(e) => setSub({ color: e.target.value })} />
              <label className="check inline"><input type="checkbox" checked={s.bold} onChange={(e) => setSub({ bold: e.target.checked })} /><span>Bold</span></label>
            </span>
          </label>
          <label>Position
            <select value={s.position} onChange={(e) => setSub({ position: e.target.value as SubStyle["position"] })}>
              <option value="bottom">Bottom</option><option value="top">Top</option>
            </select>
          </label>
          <label><span>Distance from edge: <b>{s.margin}</b></span>
            <input type="range" min={0} max={120} value={s.margin} onChange={(e) => setSub({ margin: +e.target.value })} />
          </label>
          <label>Background
            <select value={s.box ? "box" : "outline"} onChange={(e) => setSub({ box: e.target.value === "box" })}>
              <option value="outline">Outline around letters</option><option value="box">Box behind text</option>
            </select>
          </label>
          {s.box ? (
            <>
              <label>Box colour <input type="color" value={s.boxColor} onChange={(e) => setSub({ boxColor: e.target.value })} /></label>
              <label><span>Box see-through: <b>{Math.round((1 - s.boxOpacity) * 100)}%</b></span>
                <input type="range" min={0} max={90} value={Math.round((1 - s.boxOpacity) * 100)}
                  onChange={(e) => setSub({ boxOpacity: 1 - +e.target.value / 100 })} />
              </label>
            </>
          ) : (
            <>
              <label>Outline colour <input type="color" value={s.outline} onChange={(e) => setSub({ outline: e.target.value })} /></label>
              <label><span>Outline width: <b>{s.outlineWidth}</b></span>
                <input type="range" min={0} max={6} step={0.5} value={s.outlineWidth} onChange={(e) => setSub({ outlineWidth: +e.target.value })} />
              </label>
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="look-group">
        <legend>Logo</legend>
        <div className="row">
          {hasLogo ? <img src={brand!.logo!.url} alt="Your logo" className="look-thumb" /> : <span className="note">No logo yet</span>}
          <button type="button" className="btn ghost sm" onClick={() => logoInput.current?.click()}>{hasLogo ? "Replace logo" : "Upload logo"}</button>
          {hasLogo && <button type="button" className="btn ghost sm" onClick={removeLogo}>Remove</button>}
          <input ref={logoInput} type="file" accept=".png,.jpg,.jpeg,.webp" hidden onChange={(e) => pick("logo", e.target.files?.[0])} />
        </div>
        <label className="check">
          <input type="checkbox" checked={lg.enabled && hasLogo} disabled={!hasLogo} onChange={(e) => setLogo({ enabled: e.target.checked })} />
          <span>Show the logo on the video<small>It slides across the picture, then hides until the next time. A PNG with a transparent background looks best.</small></span>
        </label>
        <div className="look-grid" aria-disabled={!lg.enabled}>
          <label>Every
            <select value={lg.every} onChange={(e) => setLogo({ every: +e.target.value })} disabled={!lg.enabled}>
              {[30, 60, 120, 180, 300].map((v) => <option key={v} value={v}>{v < 60 ? `${v} seconds` : `${v / 60} minute${v > 60 ? "s" : ""}`}</option>)}
            </select>
          </label>
          <label><span>Takes <b>{lg.duration} s</b> to cross</span>
            <input type="range" min={4} max={30} value={lg.duration} onChange={(e) => setLogo({ duration: +e.target.value })} disabled={!lg.enabled} />
          </label>
          <label><span>Size: <b>{lg.size}%</b> of the width</span>
            <input type="range" min={5} max={30} value={lg.size} onChange={(e) => setLogo({ size: +e.target.value })} disabled={!lg.enabled} />
          </label>
          <label>Height
            <select value={lg.position} onChange={(e) => setLogo({ position: e.target.value as LogoOpts["position"] })} disabled={!lg.enabled}>
              <option value="top">Near the top</option><option value="bottom">Near the bottom</option>
            </select>
          </label>
          <label><span>See-through: <b>{Math.round((1 - lg.opacity) * 100)}%</b></span>
            <input type="range" min={0} max={80} value={Math.round((1 - lg.opacity) * 100)}
              onChange={(e) => setLogo({ opacity: 1 - +e.target.value / 100 })} disabled={!lg.enabled} />
          </label>
        </div>
      </fieldset>

      {jobId && (
        <div className="row">
          <label className="row nowrap">At <input type="number" min={0} step={1} value={Math.round(frameT)} style={{ width: 80 }}
            onChange={(e) => setFrameT(+e.target.value)} /> s</label>
          <button type="button" className="btn ghost sm" disabled={frameBusy} onClick={exactPreview}>
            {frameBusy ? "Rendering…" : "Preview on the video"}
          </button>
          <small className="note">Shows one real frame exactly as the final video will look (the logo is only there during its slide).</small>
        </div>
      )}
      {frame && <img src={frame} alt="Preview frame" className="look-frame" />}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
