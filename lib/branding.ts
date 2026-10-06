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
};
export const DEFAULT_SUB: SubStyle = {
  font: "Khmer UI", size: 20, bold: false,
  color: "#ffffff", outline: "#000000", outlineWidth: 2,
  box: false, boxColor: "#000000", boxOpacity: 0.6,
  position: "bottom", margin: 28,
};

/** The logo slides across the picture for `duration` seconds, once every `every` seconds. */
export type LogoOpts = {
  enabled: boolean; size: number; every: number; duration: number;
  position: "top" | "bottom"; opacity: number;
};
export const DEFAULT_LOGO: LogoOpts = { enabled: false, size: 12, every: 60, duration: 10, position: "top", opacity: 0.9 };

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
  };
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
}): string | null {
  const steps: string[] = [];
  let last = "0:v";
  if (o.shift) { steps.push(`[${last}]setpts=PTS+${o.shift.toFixed(3)}/TB[t]`); last = "t"; }
  if (o.burn) {
    const fontsdir = path.relative(path.join(ROOT, "jobs", "x"), FONTS_DIR).split(path.sep).join("/");
    steps.push(`[${last}]subtitles=km.srt:fontsdir='${fontsdir}':force_style='${forceStyle(o.sub)}'[s]`);
    last = "s";
  }
  if (o.logo?.enabled) {
    const { every: E, duration: D } = o.logo;
    const w = Math.max(16, Math.round((o.width * o.logo.size) / 100 / 2) * 2);
    const y = o.logo.position === "top" ? `H*0.05` : `H-h-H*0.05`;
    steps.push(`[${o.logoInput}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${o.logo.opacity.toFixed(2)}[lg]`);
    // from the left edge to past the right edge in D seconds, every E seconds; hidden in between
    steps.push(`[${last}][lg]overlay=x='-w+(W+w)*mod(t,${E})/${D}':y='${y}':enable='lt(mod(t,${E}),${D})':shortest=1[l]`);
    last = "l";
  }
  if (last === "0:v") return null;
  steps.push(`[${last}]format=yuv420p[v]`);
  return steps.join(";");
}
