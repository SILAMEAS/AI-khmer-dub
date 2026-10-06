"use client";

/**
 * The look of the video (subtitle style, title text, filter, effects, logo, format): types, the CSS that imitates
 * each setting in the live preview, and the panels that change them.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SubStyle = {
  font: string; size: number; bold: boolean;
  color: string; outline: string; outlineWidth: number;
  box: boolean; boxColor: string; boxOpacity: number;
  position: "bottom" | "top"; margin: number; bilingual: boolean; anim: "none" | "fade" | "pop";
};
export type LogoOpts = {
  enabled: boolean; size: number; every: number; duration: number; position: "top" | "bottom"; opacity: number;
};
export type OutOpts = {
  aspect: "original" | "16:9" | "9:16" | "1:1" | "4:5"; fit: "blur" | "crop" | "bars";
  size: 0 | 480 | 720 | 1080; quality: "high" | "standard" | "small";
};
export type FxOpts = {
  cover: boolean; coverY: number; coverH: number; coverMode: "blur" | "box"; coverColor: string;
  filter: "none" | "vivid" | "warm" | "cool" | "cinematic" | "vintage" | "bw";
  brightness: number; contrast: number; saturation: number; sharpen: boolean;
  mirror: boolean; fade: boolean; progress: boolean; progressColor: string;
  title: string; titlePos: "tl" | "tc" | "tr" | "bl" | "br"; titleSize: number; titleColor: string;
};
export type Look = { burn: boolean; sub: SubStyle; logo: LogoOpts; out: OutOpts; fx: FxOpts };
export type LookProps = { value: Look; onChange: (l: Look) => void };

export const DEFAULT_LOOK: Look = {
  burn: false,
  sub: { font: "Khmer UI", size: 20, bold: false, color: "#ffffff", outline: "#000000", outlineWidth: 2,
    box: false, boxColor: "#000000", boxOpacity: 0.6, position: "bottom", margin: 28, bilingual: false, anim: "none" },
  logo: { enabled: false, size: 12, every: 60, duration: 10, position: "top", opacity: 0.9 },
  out: { aspect: "original", fit: "blur", size: 0, quality: "standard" },
  fx: {
    cover: false, coverY: 78, coverH: 14, coverMode: "blur", coverColor: "#000000",
    filter: "none", brightness: 0, contrast: 0, saturation: 0, sharpen: false,
    mirror: false, fade: false, progress: false, progressColor: "#ff3b5c",
    title: "", titlePos: "tr", titleSize: 14, titleColor: "#ffffff",
  },
};

/** A look saved earlier (or sent by the server), completed with defaults for settings added since. */
export const fullLook = (s: Partial<Look> | { burn?: boolean; sub?: object; logo?: object; out?: object; fx?: object } | null | undefined): Look => ({
  burn: !!s?.burn, sub: { ...DEFAULT_LOOK.sub, ...s?.sub }, logo: { ...DEFAULT_LOOK.logo, ...s?.logo },
  out: { ...DEFAULT_LOOK.out, ...s?.out }, fx: { ...DEFAULT_LOOK.fx, ...s?.fx },
});

const SAVED = "khmerDubLook";
/** The look last used on this browser (remembered between videos). */
export function savedLook(): Look {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) || "null");
    if (s) return fullLook(s);
  } catch { /* storage blocked or old data: use the default */ }
  return DEFAULT_LOOK;
}
export function rememberLook(l: Look) {
  try { localStorage.setItem(SAVED, JSON.stringify(l)); } catch { /* not important */ }
}

// ---------------------------------------------------------------- live preview helpers

export const FILTERS: [FxOpts["filter"], string, string][] = [ // value, name, CSS look-alike of the ffmpeg filter
  ["none", "None", ""], ["vivid", "Vivid", "saturate(1.35) contrast(1.06)"], ["warm", "Warm", "sepia(.25) saturate(1.2)"],
  ["cool", "Cool", "hue-rotate(-12deg) saturate(.95)"], ["cinematic", "Cinematic", "contrast(1.12) saturate(.85) hue-rotate(-6deg)"],
  ["vintage", "Vintage", "sepia(.45) contrast(.9)"], ["bw", "B & W", "grayscale(1) contrast(1.1)"],
];
/** CSS filter that looks like the chosen filter and adjustments. */
export const cssFilter = (fx: FxOpts) => [FILTERS.find((f) => f[0] === fx.filter)?.[2],
  `brightness(${1 + fx.brightness / 200}) contrast(${1 + fx.contrast / 200}) saturate(${1 + fx.saturation / 100})`,
  fx.sharpen ? "contrast(1.03)" : ""].filter(Boolean).join(" ");

export const TITLE_POS: Record<FxOpts["titlePos"], React.CSSProperties> = {
  tl: { top: "4%", left: "3%" }, tc: { top: "4%", left: 0, right: 0, textAlign: "center" }, tr: { top: "4%", right: "3%" },
  bl: { bottom: "4%", left: "3%" }, br: { bottom: "4%", right: "3%" },
};

const rgba = (c: string, a: number) =>
  `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;
/** Subtitle text style; `unit` = pixels per libass unit (picture height / 288). */
export const subTextStyle = (s: SubStyle, unit: number): React.CSSProperties => ({
  fontFamily: `"${s.font}", "Khmer UI", sans-serif`, fontSize: s.size * unit, fontWeight: s.bold ? 700 : 400,
  color: s.color, lineHeight: 1.25,
  ...(s.box
    ? { background: rgba(s.boxColor, s.boxOpacity), padding: `${Math.max(2, s.outlineWidth) * unit}px ${Math.max(2, s.outlineWidth) * unit * 1.5}px` }
    : { WebkitTextStroke: s.outlineWidth ? `${s.outlineWidth * unit * 2}px ${s.outline}` : undefined, paintOrder: "stroke fill" }),
});

// ---------------------------------------------------------------- branding (fonts, logo, music)

type Font = { family: string; uploaded: boolean; url: string | null };
export type Branding = { fonts: Font[]; logo: { url: string } | null; music: { url: string } | null };

async function upload(url: string, file: File) {
  const r = await fetch(`${url}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

/** Fonts, logo and music kept for every video; uploaded fonts are loaded into the page for the preview. */
export function useBranding() {
  const [brand, setBrand] = useState<Branding | null>(null);
  const reload = useCallback(() => fetch("/api/branding").then((r) => r.json()).then(setBrand).catch(() => {}), []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    for (const f of brand?.fonts ?? []) {
      if (!f.url || [...document.fonts].some((ff) => ff.family === f.family)) continue;
      new FontFace(f.family, `url(${f.url})`).load().then((ff) => document.fonts.add(ff)).catch(() => {});
    }
  }, [brand]);
  return { brand, reload, upload };
}
type BrandProps = { brand: Branding | null; reload: () => void };

// ---------------------------------------------------------------- panels

const Hint = ({ children }: { children: React.ReactNode }) => <small className="note">{children}</small>;

/** Subtitle style (right panel of Captions). */
export function SubtitleStylePanel({ value, onChange, brand, reload }: LookProps & BrandProps) {
  const s = value.sub;
  const setSub = (p: Partial<SubStyle>) => onChange({ ...value, sub: { ...s, ...p } });
  const [err, setErr] = useState("");
  const fontInput = useRef<HTMLInputElement>(null);
  async function pickFont(file?: File) {
    if (!file) return;
    setErr("");
    try { const j = await upload("/api/branding/fonts", file); setSub({ font: j.family }); reload(); } catch (e) { setErr((e as Error).message); }
  }
  const PRESETS: [string, Partial<SubStyle>][] = [
    ["Classic", { color: "#ffffff", outline: "#000000", outlineWidth: 2, box: false, bold: false }],
    ["Yellow", { color: "#ffd400", outline: "#000000", outlineWidth: 2.5, box: false, bold: true }],
    ["Box", { color: "#ffffff", box: true, boxColor: "#000000", boxOpacity: 0.6 }],
    ["Pink", { color: "#ffffff", outline: "#e11d74", outlineWidth: 3, box: false, bold: true }],
    ["News", { color: "#ffffff", box: true, boxColor: "#1d4ed8", boxOpacity: 0.85, bold: true }],
  ];
  return (
    <div className="pane">
      <label className="check">
        <input type="checkbox" checked={value.burn} onChange={(e) => onChange({ ...value, burn: e.target.checked })} />
        <span>Show subtitles on the picture<small>Burned in, in this style. The .srt and the selectable track are always made too.</small></span>
      </label>
      <fieldset className="pane-group" disabled={!value.burn}>
        <div className="chips text-presets">
          {PRESETS.map(([name, p]) => (
            <button type="button" key={name} className="chip" onClick={() => setSub(p)}>
              <span style={subTextStyle({ ...s, ...p, size: 13 }, 1)}>អក្សរ</span>{name}
            </button>
          ))}
        </div>
        <label className="f">Font</label>
        <div className="row nowrap">
          <select value={s.font} onChange={(e) => setSub({ font: e.target.value })}>
            {!brand?.fonts.some((f) => f.family === s.font) && <option value={s.font}>{s.font}</option>}
            {brand?.fonts.map((f) => <option key={f.family} value={f.family}>{f.uploaded ? "★ " : ""}{f.family}</option>)}
          </select>
          <button type="button" className="btn ghost sm" onClick={() => fontInput.current?.click()}>Upload</button>
          <input ref={fontInput} type="file" accept=".ttf,.otf" hidden onChange={(e) => pickFont(e.target.files?.[0])} />
        </div>
        <div className="pane-grid">
          <label><span>Size <b>{s.size}</b></span><input type="range" min={10} max={44} value={s.size} onChange={(e) => setSub({ size: +e.target.value })} /></label>
          <label><span>From the edge <b>{s.margin}</b></span><input type="range" min={0} max={140} value={s.margin} onChange={(e) => setSub({ margin: +e.target.value })} /></label>
          <label>Colour <span className="row nowrap"><input type="color" value={s.color} onChange={(e) => setSub({ color: e.target.value })} />
            <label className="check inline"><input type="checkbox" checked={s.bold} onChange={(e) => setSub({ bold: e.target.checked })} /><span>Bold</span></label></span></label>
          <label>Position
            <div className="seg-btns">
              {(["top", "bottom"] as const).map((p) => <button type="button" key={p} className={s.position === p ? "on" : ""} onClick={() => setSub({ position: p })}>{p === "top" ? "Top" : "Bottom"}</button>)}
            </div>
          </label>
          <label>Background
            <div className="seg-btns">
              <button type="button" className={!s.box ? "on" : ""} onClick={() => setSub({ box: false })}>Outline</button>
              <button type="button" className={s.box ? "on" : ""} onClick={() => setSub({ box: true })}>Box</button>
            </div>
          </label>
          {s.box ? (
            <>
              <label>Box colour <input type="color" value={s.boxColor} onChange={(e) => setSub({ boxColor: e.target.value })} /></label>
              <label><span>See-through <b>{Math.round((1 - s.boxOpacity) * 100)}%</b></span>
                <input type="range" min={0} max={90} value={Math.round((1 - s.boxOpacity) * 100)} onChange={(e) => setSub({ boxOpacity: 1 - +e.target.value / 100 })} /></label>
            </>
          ) : (
            <>
              <label>Outline colour <input type="color" value={s.outline} onChange={(e) => setSub({ outline: e.target.value })} /></label>
              <label><span>Outline <b>{s.outlineWidth}</b></span>
                <input type="range" min={0} max={6} step={0.5} value={s.outlineWidth} onChange={(e) => setSub({ outlineWidth: +e.target.value })} /></label>
            </>
          )}
          <label>Animation
            <select value={s.anim} onChange={(e) => setSub({ anim: e.target.value as SubStyle["anim"] })}>
              <option value="none">None</option><option value="fade">Fade in</option><option value="pop">Pop</option>
            </select>
          </label>
          <label className="check inline"><input type="checkbox" checked={s.bilingual} onChange={(e) => setSub({ bilingual: e.target.checked })} />
            <span>Khmer + original<small>Original line under it, smaller</small></span></label>
        </div>
      </fieldset>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

/** Text on the picture the whole time (channel name, episode). */
export function TitlePanel({ value, onChange }: LookProps) {
  const fx = value.fx;
  const setFx = (p: Partial<FxOpts>) => onChange({ ...value, fx: { ...fx, ...p } });
  return (
    <div className="pane">
      <label className="f">Text on the video</label>
      <input type="text" className="km" value={fx.title} maxLength={80} placeholder="e.g. ភាគទី ១ · My Channel"
        onChange={(e) => setFx({ title: e.target.value })} onBlur={(e) => setFx({ title: e.target.value.trim() })} />
      <Hint>Shown the whole time, in the subtitle font. Empty = no text.</Hint>
      <label className="f">Place</label>
      <div className="pos-grid">
        {(["tl", "tc", "tr", "bl", "br"] as const).map((p) => (
          <button type="button" key={p} className={fx.titlePos === p ? "on" : ""} disabled={!fx.title} onClick={() => setFx({ titlePos: p })}
            title={{ tl: "Top left", tc: "Top centre", tr: "Top right", bl: "Bottom left", br: "Bottom right" }[p]}>
            {{ tl: "↖", tc: "↑", tr: "↗", bl: "↙", br: "↘" }[p]}
          </button>
        ))}
      </div>
      <div className="pane-grid">
        <label><span>Size <b>{fx.titleSize}</b></span>
          <input type="range" min={6} max={30} value={fx.titleSize} disabled={!fx.title} onChange={(e) => setFx({ titleSize: +e.target.value })} /></label>
        <label>Colour <input type="color" value={fx.titleColor} disabled={!fx.title} onChange={(e) => setFx({ titleColor: e.target.value })} /></label>
      </div>
    </div>
  );
}

/** Filter gallery (left panel of Filters). */
export function FilterGallery({ value, onChange, thumb }: LookProps & { thumb?: string }) {
  const fx = value.fx;
  return (
    <div className="pane">
      <div className="filter-grid">
        {FILTERS.map(([v, name, css]) => (
          <button type="button" key={v} className={`filter-tile ${fx.filter === v ? "on" : ""}`}
            onClick={() => onChange({ ...value, fx: { ...fx, filter: v } })}>
            <i style={{ filter: css, ...(thumb && { backgroundImage: `url(${thumb})` }) }} />{name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Brightness, contrast, saturation, sharpen (right panel of Filters). */
export function AdjustPanel({ value, onChange }: LookProps) {
  const fx = value.fx;
  const setFx = (p: Partial<FxOpts>) => onChange({ ...value, fx: { ...fx, ...p } });
  return (
    <div className="pane">
      {([["brightness", "Brightness"], ["contrast", "Contrast"], ["saturation", "Saturation"]] as const).map(([k, name]) => (
        <label key={k} className="slider-row"><span>{name}</span>
          <input type="range" min={-100} max={100} step={5} value={fx[k]} onChange={(e) => setFx({ [k]: +e.target.value } as Partial<FxOpts>)}
            onDoubleClick={() => setFx({ [k]: 0 } as Partial<FxOpts>)} title="Double-click: back to 0" />
          <b>{fx[k] > 0 ? "+" : ""}{fx[k]}</b>
        </label>
      ))}
      <label className="check"><input type="checkbox" checked={fx.sharpen} onChange={(e) => setFx({ sharpen: e.target.checked })} />
        <span>Sharpen<small>Crisper picture for soft or re-uploaded videos</small></span></label>
      <button type="button" className="btn ghost sm" onClick={() => setFx({ brightness: 0, contrast: 0, saturation: 0, sharpen: false, filter: "none" })}>Reset all</button>
    </div>
  );
}

/** Band over the subtitles already burned into the source. */
export function CoverPanel({ value, onChange }: LookProps) {
  const fx = value.fx;
  const setFx = (p: Partial<FxOpts>) => onChange({ ...value, fx: { ...fx, ...p } });
  return (
    <div className="pane">
      <label className="check"><input type="checkbox" checked={fx.cover} onChange={(e) => setFx({ cover: e.target.checked })} />
        <span>Hide the original subtitles<small>Chinese / English text already in the picture. Move the band over it while watching the player.</small></span></label>
      <fieldset className="pane-group" disabled={!fx.cover}>
        <label className="slider-row"><span>Starts at</span>
          <input type="range" min={0} max={95} value={fx.coverY} onChange={(e) => setFx({ coverY: +e.target.value })} /><b>{fx.coverY}%</b></label>
        <label className="slider-row"><span>Height</span>
          <input type="range" min={2} max={40} value={fx.coverH} onChange={(e) => setFx({ coverH: +e.target.value })} /><b>{fx.coverH}%</b></label>
        <div className="seg-btns">
          <button type="button" className={fx.coverMode === "blur" ? "on" : ""} onClick={() => setFx({ coverMode: "blur" })}>Blur</button>
          <button type="button" className={fx.coverMode === "box" ? "on" : ""} onClick={() => setFx({ coverMode: "box" })}>Solid colour</button>
          {fx.coverMode === "box" && <input type="color" value={fx.coverColor} onChange={(e) => setFx({ coverColor: e.target.value })} />}
        </div>
      </fieldset>
    </div>
  );
}

/** Mirror, fade, progress bar. */
export function ExtrasPanel({ value, onChange }: LookProps) {
  const fx = value.fx;
  const setFx = (p: Partial<FxOpts>) => onChange({ ...value, fx: { ...fx, ...p } });
  const Item = ({ k, name, hint }: { k: "mirror" | "fade" | "progress"; name: string; hint: string }) => (
    <label className="check"><input type="checkbox" checked={fx[k]} onChange={(e) => setFx({ [k]: e.target.checked } as Partial<FxOpts>)} />
      <span>{name}<small>{hint}</small></span></label>
  );
  return (
    <div className="pane">
      <Item k="mirror" name="Mirror" hint="Flip the picture left ↔ right" />
      <Item k="fade" name="Fade in & out" hint="From black at the start, to black at the end (sound too)" />
      <Item k="progress" name="Progress bar" hint="A thin bar along the bottom that fills as the video plays" />
      {fx.progress && <label className="row nowrap">Bar colour <input type="color" value={fx.progressColor} onChange={(e) => setFx({ progressColor: e.target.value })} /></label>}
    </div>
  );
}

/** Logo: upload and on/off (left), how it moves (right). */
export function LogoPanel({ value, onChange, brand, reload, part }: LookProps & BrandProps & { part: "left" | "right" }) {
  const lg = value.logo;
  const setLogo = (p: Partial<LogoOpts>) => onChange({ ...value, logo: { ...lg, ...p } });
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const hasLogo = !!brand?.logo;
  async function pick(file?: File) {
    if (!file) return;
    setErr("");
    try { await upload("/api/branding/logo", file); setLogo({ enabled: true }); reload(); } catch (e) { setErr((e as Error).message); }
  }
  async function remove() {
    await fetch("/api/branding/logo", { method: "DELETE" });
    setLogo({ enabled: false });
    reload();
  }
  if (part === "left") return (
    <div className="pane">
      <div className="logo-box">
        {hasLogo ? <img src={brand!.logo!.url} alt="Your logo" /> : <span className="note">No logo yet</span>}
      </div>
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => input.current?.click()}>{hasLogo ? "Replace" : "Upload logo"}</button>
        {hasLogo && <button type="button" className="btn ghost sm" onClick={remove}>Remove</button>}
        <input ref={input} type="file" accept=".png,.jpg,.jpeg,.webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      <label className="check"><input type="checkbox" checked={lg.enabled && hasLogo} disabled={!hasLogo} onChange={(e) => setLogo({ enabled: e.target.checked })} />
        <span>Show the logo<small>It slides across the picture, then hides until the next time. A PNG with a transparent background looks best.</small></span></label>
      {err && <div className="err">{err}</div>}
    </div>
  );
  return (
    <fieldset className="pane pane-group" disabled={!lg.enabled || !hasLogo}>
      <label className="f">Every</label>
      <div className="seg-btns">
        {[30, 60, 120, 300].map((v) => <button type="button" key={v} className={lg.every === v ? "on" : ""} onClick={() => setLogo({ every: v })}>{v < 60 ? `${v} s` : `${v / 60} min`}</button>)}
      </div>
      <label className="slider-row"><span>Crossing time</span><input type="range" min={4} max={30} value={lg.duration} onChange={(e) => setLogo({ duration: +e.target.value })} /><b>{lg.duration} s</b></label>
      <label className="slider-row"><span>Size</span><input type="range" min={5} max={30} value={lg.size} onChange={(e) => setLogo({ size: +e.target.value })} /><b>{lg.size}%</b></label>
      <label className="slider-row"><span>See-through</span><input type="range" min={0} max={80} value={Math.round((1 - lg.opacity) * 100)} onChange={(e) => setLogo({ opacity: 1 - +e.target.value / 100 })} /><b>{Math.round((1 - lg.opacity) * 100)}%</b></label>
      <div className="seg-btns">
        <button type="button" className={lg.position === "top" ? "on" : ""} onClick={() => setLogo({ position: "top" })}>Near the top</button>
        <button type="button" className={lg.position === "bottom" ? "on" : ""} onClick={() => setLogo({ position: "bottom" })}>Near the bottom</button>
      </div>
    </fieldset>
  );
}

export const ASPECTS: [OutOpts["aspect"], string, string][] = [
  ["original", "Original", "As the video"], ["16:9", "16:9", "YouTube"], ["9:16", "9:16", "TikTok · Reels · Shorts"],
  ["1:1", "1:1", "Square post"], ["4:5", "4:5", "Facebook · Instagram"],
];

/** Shape, fill, resolution and quality of the exported video. */
export function FormatPanel({ value, onChange }: LookProps) {
  const out = value.out;
  const setOut = (p: Partial<OutOpts>) => onChange({ ...value, out: { ...out, ...p } });
  return (
    <div className="pane">
      <label className="f">Shape</label>
      <div className="ratio-grid">
        {ASPECTS.map(([v, name, sub]) => (
          <button type="button" key={v} className={out.aspect === v ? "on" : ""} onClick={() => setOut({ aspect: v })}>
            <i className={`r-${v.replace(":", "x")}`} /><b>{name}</b><small>{sub}</small>
          </button>
        ))}
      </div>
      <label className="f">Fill the empty space</label>
      <div className="seg-btns">
        {([["blur", "Blur"], ["crop", "Zoom in"], ["bars", "Black bars"]] as const).map(([v, n]) => (
          <button type="button" key={v} disabled={out.aspect === "original"} className={out.fit === v ? "on" : ""} onClick={() => setOut({ fit: v })}>{n}</button>
        ))}
      </div>
      <label className="f">Resolution</label>
      <div className="seg-btns">
        {([[0, "Source"], [1080, "1080p"], [720, "720p"], [480, "480p"]] as const).map(([v, n]) => (
          <button type="button" key={v} className={out.size === v ? "on" : ""} onClick={() => setOut({ size: v })}>{n}</button>
        ))}
      </div>
      <label className="f">Quality</label>
      <div className="seg-btns">
        {([["high", "High"], ["standard", "Standard"], ["small", "Small file"]] as const).map(([v, n]) => (
          <button type="button" key={v} className={out.quality === v ? "on" : ""} onClick={() => setOut({ quality: v })}>{n}</button>
        ))}
      </div>
      <Hint>Never enlarged above the source. “Small file” is handy for Telegram.</Hint>
    </div>
  );
}
