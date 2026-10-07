/**
 * Edits to the video's timeline, applied at export: parts cut out (by hand, like Premiere's ripple delete, or the
 * silent parts found for you), the speed of the whole video and image stickers. Shared by the server and the editor
 * (no Node imports here).
 *
 * Everything else (subtitles, voices, sound parts, stickers) stays in the source's time; the cut and the speed are
 * the very last step, on picture and sound together, so they can never drift apart.
 */

export type Range = { from: number; to: number };
/** An image on the picture from `from` to `to` (source seconds), centred at x / y (% of the picture), `size` % wide. */
export type Sticker = { id: string; file: string; from: number; to: number; x: number; y: number; size: number };
export type EditOpts = { speed: number; cuts: Range[]; stickers: Sticker[] };
export const DEFAULT_EDIT: EditOpts = { speed: 1, cuts: [], stickers: [] };

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const STICKER_FILE = /^[\w-]{1,60}\.(png|jpe?g|webp|gif)$/i;

const num = (v: unknown, lo: number, hi: number, d: number) =>
  v !== null && v !== "" && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;

/** Ranges sorted, overlapping or touching ones joined, very short ones dropped. */
export function mergeRanges(rs: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...rs].filter((x) => x.to - x.from >= 0.05).sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 0.01) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

/** Cleans edit values coming from the browser; anything missing or invalid falls back to the default. */
export function parseEdit(v: unknown): EditOpts {
  const e = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof EditOpts, unknown>>;
  const list = (x: unknown) => (Array.isArray(x) ? x : []) as Record<string, unknown>[];
  const cuts = mergeRanges(list(e.cuts).slice(0, 2000).map((r) => {
    const from = num(r?.from, 0, 1e6, 0);
    return { from, to: num(r?.to, from, 1e6, from) };
  }));
  const stickers = list(e.stickers).slice(0, 50).map((s, i): Sticker => {
    const from = num(s?.from, 0, 1e6, 0);
    return {
      id: typeof s?.id === "string" ? s.id.slice(0, 40) : `s${i}`,
      file: typeof s?.file === "string" && STICKER_FILE.test(s.file) ? s.file : "",
      from, to: Math.max(from + 0.1, num(s?.to, 0, 1e6, from + 3)),
      x: num(s?.x, 0, 100, 50), y: num(s?.y, 0, 100, 50), size: num(s?.size, 3, 100, 20),
    };
  }).filter((s) => s.file);
  return { speed: num(e.speed, 0.5, 2, 1), cuts, stickers };
}

export const timelineEdited = (e: EditOpts) => e.speed !== 1 || e.cuts.length > 0;

/** Seconds cut out before source time `t`. */
export function removedBefore(cuts: Range[], t: number): number {
  let r = 0;
  for (const c of cuts) {
    if (c.from >= t) break;
    r += Math.min(t, c.to) - c.from;
  }
  return r;
}

/** Where source time `t` ends up in the exported video. */
export const toOutput = (e: EditOpts, t: number) => (t - removedBefore(e.cuts, t)) / e.speed;

/** Length of the exported video (before an intro / outro). */
export const outputDuration = (e: EditOpts, duration: number) =>
  (duration - removedBefore(e.cuts.filter((c) => c.from < duration), duration)) / e.speed;

/** The cut containing `t`, if any. */
export const cutAt = (cuts: Range[], t: number) => cuts.find((c) => t >= c.from && t < c.to);

/**
 * A subtitle from a to b in source time, in the exported video's time; null when it is cut out entirely.
 * A line partly cut keeps the part left.
 */
export function mapRange(e: EditOpts, a: number, b: number): [number, number] | null {
  let x = a, y = b;
  for (const c of e.cuts) {
    if (c.from <= x && x < c.to) x = c.to;
    if (c.from < y && y <= c.to) y = c.from;
  }
  if (y - x < 0.05) return null;
  return [toOutput(e, x), toOutput(e, y)];
}

/**
 * ffmpeg expressions for the cut: which frames stay (select / aselect) and how far each one moves back
 * (setpts / asetpts), as sums over the cuts, so the filter streams through any length of video.
 */
export function cutExpressions(cuts: Range[]) {
  const f = (n: number) => n.toFixed(3);
  const keep = cuts.length ? `not(${cuts.map((c) => `between(t,${f(c.from)},${f(c.to)})`).join("+")})` : "1";
  const shift = cuts.length ? cuts.map((c) => `clip(T-${f(c.from)},0,${f(c.to - c.from)})`).join("+") : "0";
  return { keep, shift };
}

// ---------------------------------------------------------------- zoom (Ken Burns / punch-in)

export type ZoomMode = "none" | "slow" | "punch";
const SLOW_ZOOM = 0.08, SLOW_PERIOD = 12, PUNCH_ZOOM = 0.12;

/** Punch-in: every other line, from its start to the next line's start (at most 8 s), zoomed in a little. */
export function punchRanges(lines: { start: number }[], duration: number): Range[] {
  const out: Range[] = [];
  for (let i = 1; i < lines.length; i += 2) {
    const from = lines[i].start, next = i + 1 < lines.length ? lines[i + 1].start : duration;
    out.push({ from, to: Math.min(next, from + 8) });
  }
  return out;
}

/** How much the picture is enlarged at `t` (1 = not at all); the same numbers as zoomExpr. */
export function zoomAt(mode: ZoomMode, t: number, punch: Range[]): number {
  if (mode === "slow") return 1 + SLOW_ZOOM * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / SLOW_PERIOD));
  if (mode === "punch") return punch.some((r) => t >= r.from && t <= r.to) ? 1 + PUNCH_ZOOM : 1;
  return 1;
}

/** zoomAt as an ffmpeg expression of t; "" when there is no zoom. */
export function zoomExpr(mode: ZoomMode, punch: Range[]): string {
  if (mode === "slow") return `1+${SLOW_ZOOM}*(0.5-0.5*cos(2*PI*t/${SLOW_PERIOD}))`;
  if (mode === "punch" && punch.length) {
    return `1+${PUNCH_ZOOM}*gt(${punch.map((r) => `between(t,${r.from.toFixed(3)},${r.to.toFixed(3)})`).join("+")},0)`;
  }
  return "";
}

/** atempo for any speed (one atempo goes from 0.5 to 2; slower ones are chained). */
export function atempo(speed: number): string {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  while (s > 2) { out.push("atempo=2"); s /= 2; }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${s.toFixed(4)}`);
  return out.join(",");
}
