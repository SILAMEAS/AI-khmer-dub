/**
 * Video look: subtitle style (font, colours, box, position) and a logo that slides across the picture.
 * Uploaded fonts and the logo live in ./branding and are reused for every video.
 */
import { fs, path } from "./rt";
import { ROOT } from "./tools";

export const BRANDING_DIR = path.join(ROOT, "branding");
export const FONTS_DIR = path.join(BRANDING_DIR, "fonts");

// ---------------------------------------------------------------- options

export type SubStyle = {
  font: string; size: number; bold: boolean;
  color: string; outline: string; outlineWidth: number;
  box: boolean; boxColor: string; boxOpacity: number;
  position: "bottom" | "top"; margin: number;
  bilingual: boolean; // the original line in smaller letters under the Khmer one
  anim: "none" | "fade" | "pop"; // how each line appears
};
export const DEFAULT_SUB: SubStyle = {
  font: "Khmer UI", size: 20, bold: false,
  color: "#ffffff", outline: "#000000", outlineWidth: 2,
  box: false, boxColor: "#000000", boxOpacity: 0.6,
  position: "bottom", margin: 28, bilingual: false, anim: "none",
};

/** The logo slides across the picture for `duration` seconds, once every `every` seconds. */
export type LogoOpts = {
  enabled: boolean; size: number; every: number; duration: number;
  position: "top" | "bottom"; opacity: number;
};
export const DEFAULT_LOGO: LogoOpts = { enabled: false, size: 12, every: 60, duration: 10, position: "top", opacity: 0.9 };

/**
 * Export format. aspect: picture shape (9:16 for TikTok / Reels / Shorts, 1:1 for Facebook / Instagram posts);
 * fit: how a picture of another shape fills it; size: the short side in pixels (0 = as the source);
 * quality: x264 CRF preset.
 */
export type OutOpts = {
  aspect: "original" | "16:9" | "9:16" | "1:1" | "4:5";
  fit: "blur" | "crop" | "bars" | "color"; // color: a plain background in `canvas`
  canvas: string;
  size: 0 | 480 | 720 | 1080;
  quality: "high" | "standard" | "small";
  fps: 0 | 24 | 25 | 30 | 60; // 0: as the source
};
export const DEFAULT_OUT: OutOpts = { aspect: "original", fit: "blur", canvas: "#000000", size: 0, quality: "standard", fps: 0 };
export const CRF: Record<OutOpts["quality"], number> = { high: 18, standard: 21, small: 26 };
const ASPECTS: Record<Exclude<OutOpts["aspect"], "original">, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
const hex = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
// a font name ends up inside an ffmpeg filter: keep it to characters that cannot break the filter syntax
const fontName = (v: unknown, d: string) =>
  typeof v === "string" && v.trim() ? v.replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 64) || d : d;

/** Cleans style values coming from the browser; anything missing or invalid falls back to the default. */
export function parseSubStyle(v: unknown): SubStyle {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof SubStyle, unknown>>;
  const d = DEFAULT_SUB;
  return {
    font: fontName(s.font, d.font), size: clamp(s.size, 8, 60, d.size), bold: s.bold === true,
    color: hex(s.color, d.color), outline: hex(s.outline, d.outline), outlineWidth: clamp(s.outlineWidth, 0, 6, d.outlineWidth),
    box: s.box === true, boxColor: hex(s.boxColor, d.boxColor), boxOpacity: clamp(s.boxOpacity, 0, 1, d.boxOpacity),
    position: s.position === "top" ? "top" : "bottom", margin: clamp(s.margin, 0, 200, d.margin),
    bilingual: s.bilingual === true,
    anim: s.anim === "fade" || s.anim === "pop" ? s.anim : "none",
  };
}

/**
 * Picture effects. cover: hide subtitles already burned into the source (a band from coverY, coverH high,
 * in % of the picture height) with a blur or a solid box; filter: colour look; brightness / contrast /
 * saturation: -100..100 (0 = unchanged); mirror: flip left-right; fade: from and to black (sound too);
 * progress: a bar along the bottom showing how far the video is; title: text on the picture the whole time
 * (channel name, episode), drawn with the subtitle font.
 */
export type FxOpts = {
  cover: boolean; coverY: number; coverH: number; coverMode: "blur" | "box"; coverColor: string;
  filter: "none" | "vivid" | "warm" | "cool" | "cinematic" | "vintage" | "bw";
  brightness: number; contrast: number; saturation: number; sharpen: boolean;
  mirror: boolean; fade: boolean; progress: boolean; progressColor: string;
  title: string; titlePos: "tl" | "tc" | "tr" | "bl" | "br"; titleSize: number; titleColor: string;
};
export const DEFAULT_FX: FxOpts = {
  cover: false, coverY: 78, coverH: 14, coverMode: "blur", coverColor: "#000000",
  filter: "none", brightness: 0, contrast: 0, saturation: 0, sharpen: false,
  mirror: false, fade: false, progress: false, progressColor: "#ff3b5c",
  title: "", titlePos: "tr", titleSize: 14, titleColor: "#ffffff",
};
const FILTERS: Record<FxOpts["filter"], string> = {
  none: "",
  vivid: "eq=saturation=1.35:contrast=1.06",
  warm: "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.06:bm=-0.06",
  cool: "colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06",
  cinematic: "eq=contrast=1.12:saturation=0.85,colorbalance=rs=-0.05:bs=0.06:rh=0.06:bh=-0.04",
  vintage: "curves=preset=vintage",
  bw: "hue=s=0,eq=contrast=1.1",
};

export function parseFx(v: unknown): FxOpts {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof FxOpts, unknown>>;
  const d = DEFAULT_FX;
  return {
    cover: s.cover === true, coverY: clamp(s.coverY, 0, 95, d.coverY), coverH: clamp(s.coverH, 2, 50, d.coverH),
    coverMode: s.coverMode === "box" ? "box" : "blur", coverColor: hex(s.coverColor, d.coverColor),
    filter: typeof s.filter === "string" && s.filter in FILTERS ? (s.filter as FxOpts["filter"]) : "none",
    brightness: clamp(s.brightness, -100, 100, 0), contrast: clamp(s.contrast, -100, 100, 0),
    saturation: clamp(s.saturation, -100, 100, 0), sharpen: s.sharpen === true,
    mirror: s.mirror === true, fade: s.fade === true,
    progress: s.progress === true, progressColor: hex(s.progressColor, d.progressColor),
    // the title goes into an .ass file: no line breaks or override braces
    title: typeof s.title === "string" ? s.title.replace(/[\r\n{}\\]/g, " ").trim().slice(0, 80) : "",
    titlePos: ["tl", "tc", "tr", "bl", "br"].includes(s.titlePos as string) ? (s.titlePos as FxOpts["titlePos"]) : d.titlePos,
    titleSize: clamp(s.titleSize, 6, 40, d.titleSize), titleColor: hex(s.titleColor, d.titleColor),
  };
}

/** The title as an .ass subtitle file (libass shapes Khmer correctly, ffmpeg's drawtext may not). */
export function titleAss(fx: FxOpts, font: string): string {
  const align = { tl: 7, tc: 8, tr: 9, bl: 1, br: 3 }[fx.titlePos];
  return ["[Script Info]", "ScriptType: v4.00+", "PlayResY: 288", "WrapStyle: 2", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: T,${font},${fx.titleSize},${assColour(fx.titleColor)},${assColour(fx.titleColor)},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,1.5,0.8,${align},12,12,10,1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,9:59:59.00,T,,0,0,0,,${fx.title}`, ""].join("\n");
}

export function parseOut(v: unknown): OutOpts {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof OutOpts, unknown>>;
  const pick = <T,>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? (x as T) : d);
  return {
    aspect: pick(s.aspect, ["original", "16:9", "9:16", "1:1", "4:5"] as const, DEFAULT_OUT.aspect),
    fit: pick(s.fit, ["blur", "crop", "bars", "color"] as const, DEFAULT_OUT.fit),
    canvas: hex(s.canvas, DEFAULT_OUT.canvas),
    size: pick(Number(s.size), [0, 480, 720, 1080] as const, DEFAULT_OUT.size),
    quality: pick(s.quality, ["high", "standard", "small"] as const, DEFAULT_OUT.quality),
    fps: pick(Number(s.fps), [0, 24, 25, 30, 60] as const, DEFAULT_OUT.fps),
  };
}

// ---------------------------------------------------------------- texts on the timeline

/**
 * A text shown from `from` to `to` (seconds of the source), centred at x / y (% of the picture), in its own style.
 * Sizes are in the subtitles' units (a 288-line-high picture).
 */
export type TextItem = {
  id: string; text: string; from: number; to: number; x: number; y: number;
  font: string; size: number; bold: boolean; color: string; outline: string; outlineWidth: number;
  box: boolean; boxColor: string; boxOpacity: number; anim: "none" | "fade" | "pop";
};
export function parseTexts(v: unknown): TextItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 100).map((t, i): TextItem => {
    const s = (t && typeof t === "object" ? t : {}) as Partial<Record<keyof TextItem, unknown>>;
    const from = clamp(s.from, 0, 1e6, 0);
    return {
      id: typeof s.id === "string" ? s.id.slice(0, 40) : `t${i}`,
      // into an .ass file: braces and backslashes would be read as commands
      text: typeof s.text === "string" ? s.text.replace(/[{}\\]/g, "").slice(0, 300) : "",
      from, to: Math.max(from + 0.1, clamp(s.to, 0, 1e6, from + 3)),
      x: clamp(s.x, 0, 100, 50), y: clamp(s.y, 0, 100, 50),
      font: fontName(s.font, DEFAULT_SUB.font), size: clamp(s.size, 6, 80, 22), bold: s.bold !== false,
      color: hex(s.color, "#ffffff"), outline: hex(s.outline, "#000000"), outlineWidth: clamp(s.outlineWidth, 0, 8, 2),
      box: s.box === true, boxColor: hex(s.boxColor, "#000000"), boxOpacity: clamp(s.boxOpacity, 0, 1, 0.6),
      anim: s.anim === "fade" || s.anim === "pop" ? s.anim : "none",
    };
  }).filter((t) => t.text.trim());
}

const assTime = (t: number) => {
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** The texts as one .ass file for a picture `width` x `height` (positions in its 288-line-high units). */
export function textsAss(texts: TextItem[], width: number, height: number): string {
  const resX = Math.round((288 * width) / height);
  const style = (t: TextItem, i: number) => {
    const back = assColour(t.boxColor, t.boxOpacity);
    return `Style: X${i},${t.font},${t.size},${assColour(t.color)},${assColour(t.color)},${t.box ? back : assColour(t.outline)},${back},`
      + `${t.bold ? -1 : 0},0,0,0,100,100,0,0,${t.box ? 3 : 1},${t.box ? Math.max(2, t.outlineWidth) : t.outlineWidth},0,5,0,0,0,1`;
  };
  const anim = { none: "", fade: "\\fad(180,120)", pop: "\\fscx70\\fscy70\\t(0,160,\\fscx100\\fscy100)" };
  return ["[Script Info]", "ScriptType: v4.00+", `PlayResX: ${resX}`, "PlayResY: 288", "WrapStyle: 0", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...texts.map(style), "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...texts.map((t, i) => `Dialogue: ${i},${assTime(t.from)},${assTime(t.to)},X${i},,0,0,0,,`
      + `{\\an5\\pos(${Math.round((resX * t.x) / 100)},${Math.round((288 * t.y) / 100)})${anim[t.anim]}}${t.text.replace(/\r?\n/g, "\\N")}`),
    ""].join("\n");
}

/** Output picture size for this format (even numbers, as x264 needs). */
export function outSize(o: OutOpts, width: number, height: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const ratio = o.aspect === "original" ? width / height : ASPECTS[o.aspect];
  // short side: the chosen size, never more than the source has (upscaling only adds blur and bytes)
  const short = Math.min(o.size || Infinity, width, height);
  return ratio >= 1 ? { width: even(short * ratio), height: even(short) } : { width: even(short), height: even(short / ratio) };
}

export function parseLogo(v: unknown): LogoOpts {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof LogoOpts, unknown>>;
  const d = DEFAULT_LOGO;
  return {
    enabled: s.enabled === true, size: clamp(s.size, 3, 40, d.size),
    every: clamp(s.every, 10, 600, d.every), duration: clamp(s.duration, 2, 60, d.duration),
    position: s.position === "bottom" ? "bottom" : "top", opacity: clamp(s.opacity, 0.1, 1, d.opacity),
  };
}

// ---------------------------------------------------------------- logo file

const LOGO_EXT = [".png", ".jpg", ".jpeg", ".webp"];
export const logoFile = () =>
  LOGO_EXT.map((e) => path.join(BRANDING_DIR, "logo" + e)).find((f) => fs.existsSync(f)) ?? null;

export function saveLogo(ext: string, data: Buffer) {
  if (!LOGO_EXT.includes(ext)) throw new Error("The logo must be a PNG, JPG or WEBP image");
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  for (const e of LOGO_EXT) fs.rmSync(path.join(BRANDING_DIR, "logo" + e), { force: true });
  fs.writeFileSync(path.join(BRANDING_DIR, "logo" + ext), data);
}

// ---------------------------------------------------------------- background music

const MUSIC_EXT = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"];
export const musicFile = () =>
  MUSIC_EXT.map((e) => path.join(BRANDING_DIR, "music" + e)).find((f) => fs.existsSync(f)) ?? null;

export function saveMusic(ext: string, data: Buffer) {
  if (!MUSIC_EXT.includes(ext)) throw new Error("The music must be an MP3, M4A, WAV, OGG or FLAC file");
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  for (const e of MUSIC_EXT) fs.rmSync(path.join(BRANDING_DIR, "music" + e), { force: true });
  fs.writeFileSync(path.join(BRANDING_DIR, "music" + ext), data);
}

// ---------------------------------------------------------------- fonts

export type FontInfo = { family: string; khmer: boolean; file: string; uploaded: boolean };

/**
 * Family name and Khmer support of a TrueType/OpenType font, read from its 'name' and 'cmap' tables
 * (only those tables are read, so scanning the Windows font folder is quick).
 */
export function readFont(file: string): { family: string; khmer: boolean } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      return b.subarray(0, fs.readSync(fd!, b, 0, len, pos));
    };
    let base = 0;
    if (read(0, 4).toString("latin1") === "ttcf") base = read(12, 4).readUInt32BE(0); // collection: first font
    const n = read(base + 4, 2).readUInt16BE(0);
    const dir = read(base + 12, n * 16);
    const tables: Record<string, [number, number]> = {};
    for (let i = 0; i < n; i++) {
      tables[dir.toString("latin1", i * 16, i * 16 + 4)] = [dir.readUInt32BE(i * 16 + 8), dir.readUInt32BE(i * 16 + 12)];
    }
    if (!tables.name || !tables.cmap) return null;

    const name = read(...tables.name);
    const count = name.readUInt16BE(2), strings = name.readUInt16BE(4);
    let family = "", score = -1;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = name.readUInt16BE(r), lang = name.readUInt16BE(r + 4), id = name.readUInt16BE(r + 6);
      const len = name.readUInt16BE(r + 8), off = strings + name.readUInt16BE(r + 10);
      if (id !== 1 && id !== 16) continue; // family / typographic family
      const s = (id === 16 ? 4 : 0) + (platform === 3 ? 2 : 0) + (lang === 0x409 ? 1 : 0);
      if (s <= score || off + len > name.length) continue;
      family = platform === 3 || platform === 0
        ? Buffer.from(name.subarray(off, off + len)).swap16().toString("utf16le")
        : name.toString("latin1", off, off + len);
      score = s;
    }

    const cmap = read(...tables.cmap);
    const KA = 0x1780; // ក
    let khmer = false;
    for (let i = 0; i < cmap.readUInt16BE(2) && !khmer; i++) {
      const platform = cmap.readUInt16BE(4 + i * 8), off = cmap.readUInt32BE(8 + i * 8);
      if (platform !== 0 && platform !== 3) continue;
      const format = cmap.readUInt16BE(off);
      if (format === 4) {
        const segs = cmap.readUInt16BE(off + 6) / 2;
        for (let s = 0; s < segs; s++) {
          const end = cmap.readUInt16BE(off + 14 + s * 2), start = cmap.readUInt16BE(off + 16 + segs * 2 + s * 2);
          if (start <= KA && KA <= end) { khmer = true; break; }
        }
      } else if (format === 12) {
        const groups = cmap.readUInt32BE(off + 12);
        for (let g = 0; g < groups; g++) {
          const start = cmap.readUInt32BE(off + 16 + g * 12), end = cmap.readUInt32BE(off + 20 + g * 12);
          if (start <= KA && KA <= end) { khmer = true; break; }
        }
      }
    }
    return family ? { family: family.trim(), khmer } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

let fontCache: FontInfo[] | null = null;
export const forgetFonts = () => { fontCache = null; };

/** Fonts that can show Khmer: uploaded ones first, then the ones installed in Windows. */
export function listFonts(): FontInfo[] {
  if (fontCache) return fontCache;
  const dirs: [string, boolean][] = [
    [FONTS_DIR, true],
    [path.join(process.env.SystemRoot || "C:\\Windows", "Fonts"), false],
    [path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Windows", "Fonts"), false],
  ];
  const seen = new Set<string>(), out: FontInfo[] = [];
  for (const [dir, uploaded] of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => /\.(ttf|otf|ttc)$/i.test(n)).sort()) {
      const info = readFont(path.join(dir, f));
      if (!info?.khmer || seen.has(info.family.toLowerCase())) continue;
      seen.add(info.family.toLowerCase());
      out.push({ ...info, file: f, uploaded });
    }
  }
  return (fontCache = out);
}

export function saveFont(name: string, data: Buffer): FontInfo {
  const ext = path.extname(name).toLowerCase();
  if (![".ttf", ".otf"].includes(ext)) throw new Error("The font must be a .ttf or .otf file");
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const safe = path.basename(name, ext).replace(/[^\w\-]+/g, "_").slice(0, 60) + ext;
  const file = path.join(FONTS_DIR, safe);
  fs.writeFileSync(file, data);
  const info = readFont(file);
  if (!info) { fs.rmSync(file, { force: true }); throw new Error("This file is not a font that can be read"); }
  if (!info.khmer) { fs.rmSync(file, { force: true }); throw new Error(`"${info.family}" has no Khmer letters - pick a Khmer font`); }
  forgetFonts();
  return { ...info, file: safe, uploaded: true };
}

// ---------------------------------------------------------------- ffmpeg

/** #rrggbb + opacity -> ASS colour &HAABBGGRR (AA: 00 = solid, FF = invisible). */
function assColour(c: string, opacity = 1) {
  const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0");
  return `&H${a}${c.slice(5, 7)}${c.slice(3, 5)}${c.slice(1, 3)}`.toUpperCase();
}

/** libass force_style for burned-in subtitles (sizes are in units of a 288-line-high picture). */
export function forceStyle(s: SubStyle): string {
  const box = s.box
    ? [`BorderStyle=3`, `Outline=${Math.max(2, s.outlineWidth)}`, `OutlineColour=${assColour(s.boxColor, s.boxOpacity)}`,
       `BackColour=${assColour(s.boxColor, s.boxOpacity)}`]
    : [`BorderStyle=1`, `Outline=${s.outlineWidth}`, `OutlineColour=${assColour(s.outline)}`];
  return [`FontName=${s.font}`, `FontSize=${s.size}`, `Bold=${s.bold ? -1 : 0}`, `PrimaryColour=${assColour(s.color)}`,
    ...box, `Shadow=0`, `Alignment=${s.position === "top" ? 8 : 2}`, `MarginV=${s.margin}`].join(",");
}

/**
 * ffmpeg -filter_complex for the picture: burned subtitles and/or the sliding logo. Run with cwd = job folder
 * (paths inside a filter must not contain a drive letter's colon). `logoInput` is the -i index of the logo.
 * `shift` moves the clock (for a preview frame cut from the middle of the video).
 */
export function pictureFilter(o: {
  burn: boolean; sub: SubStyle; logo: LogoOpts | null; logoInput: number; width: number; height: number; shift?: number;
  out?: OutOpts; srt?: string; fx?: FxOpts; title?: string; duration?: number; texts?: string;
}): string | null {
  const steps: string[] = [];
  let last = "0:v";
  if (o.shift) { steps.push(`[${last}]setpts=PTS+${o.shift.toFixed(3)}/TB[t]`); last = "t"; }
  const fx = o.fx ?? DEFAULT_FX;
  if (fx.cover) { // on the source picture, where its own subtitles are
    const y = (fx.coverY / 100).toFixed(4), h = (Math.min(fx.coverH, 100 - fx.coverY) / 100).toFixed(4);
    if (fx.coverMode === "blur") {
      steps.push(`[${last}]split[c0][c1]`, `[c1]crop=iw:ih*${h}:0:ih*${y},boxblur=14:4[cb]`,
        `[c0][cb]overlay=0:main_h*${y}[cv]`);
    } else {
      steps.push(`[${last}]drawbox=x=0:y=ih*${y}:w=iw:h=ih*${h}:color=${fx.coverColor.replace("#", "0x")}@1:t=fill[cv]`);
    }
    last = "cv";
  }
  const color = [
    fx.mirror ? "hflip" : "",
    FILTERS[fx.filter],
    fx.brightness || fx.contrast || fx.saturation
      ? `eq=brightness=${(fx.brightness / 400).toFixed(3)}:contrast=${(1 + fx.contrast / 200).toFixed(3)}:saturation=${(1 + fx.saturation / 100).toFixed(3)}`
      : "",
    fx.sharpen ? "unsharp=5:5:0.7" : "",
  ].filter(Boolean);
  if (color.length) { steps.push(`[${last}]${color.join(",")}[cf]`); last = "cf"; }
  // new shape / size first, so subtitles and logo are drawn at the final resolution
  const { width: W, height: H } = o.out ? outSize(o.out, o.width, o.height) : o;
  if (W !== o.width || H !== o.height) {
    const fit = o.out!.fit;
    if (fit === "blur") { // the picture itself, enlarged and blurred, fills the empty sides
      steps.push(`[${last}]split[fa][fb]`,
        `[fa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:5[bg]`,
        `[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[f]`);
    } else if (fit === "crop") {
      steps.push(`[${last}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[f]`);
    } else { // black bars, or a background colour of your choice
      const pad = fit === "color" ? o.out!.canvas.replace("#", "0x") : "black";
      steps.push(`[${last}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${pad},setsar=1[f]`);
    }
    last = "f";
  }
  if (o.burn) {
    const fontsdir = path.relative(path.join(ROOT, "jobs", "x"), FONTS_DIR).split(path.sep).join("/");
    steps.push(`[${last}]subtitles=${o.srt ?? "km.srt"}:fontsdir='${fontsdir}':force_style='${forceStyle(o.sub)}'[s]`);
    last = "s";
  }
  if (o.title) {
    const fontsdir = path.relative(path.join(ROOT, "jobs", "x"), FONTS_DIR).split(path.sep).join("/");
    steps.push(`[${last}]subtitles=${o.title}:fontsdir='${fontsdir}'[ti]`);
    last = "ti";
  }
  if (o.texts) {
    const fontsdir = path.relative(path.join(ROOT, "jobs", "x"), FONTS_DIR).split(path.sep).join("/");
    steps.push(`[${last}]subtitles=${o.texts}:fontsdir='${fontsdir}'[tx]`);
    last = "tx";
  }
  if (o.logo?.enabled) {
    const { every: E, duration: D } = o.logo;
    const w = Math.max(16, Math.round((W * o.logo.size) / 100 / 2) * 2);
    const y = o.logo.position === "top" ? `H*0.05` : `H-h-H*0.05`;
    steps.push(`[${o.logoInput}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${o.logo.opacity.toFixed(2)}[lg]`);
    // from the left edge to past the right edge in D seconds, every E seconds; hidden in between
    steps.push(`[${last}][lg]overlay=x='-w+(W+w)*mod(t,${E})/${D}':y='${y}':enable='lt(mod(t,${E}),${D})':shortest=1[l]`);
    last = "l";
  }
  const dur = o.duration ?? 0;
  if (fx.progress && dur > 0) { // grows from the left edge to the full width over the video
    const bar = Math.max(4, Math.round(H / 160 / 2) * 2);
    steps.push(`color=c=${fx.progressColor.replace("#", "0x")}:s=${W}x${bar}:r=25[pb]`,
      `[${last}][pb]overlay=x='-w+w*t/${dur.toFixed(3)}':y=H-h:shortest=1[pg]`);
    last = "pg";
  }
  if (fx.fade && dur > 2) {
    steps.push(`[${last}]fade=t=in:st=0:d=0.6,fade=t=out:st=${(dur - 0.6).toFixed(3)}:d=0.6[fd]`);
    last = "fd";
  }
  if (o.out?.fps && !o.shift) { steps.push(`[${last}]fps=${o.out.fps}[fr]`); last = "fr"; }
  if (last === "0:v") return null;
  steps.push(`[${last}]format=yuv420p[v]`);
  return steps.join(";");
}
