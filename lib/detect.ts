/**
 * Finds what the source video already has burned into its picture: a channel logo (sharp edges that stay put
 * while everything around them changes) and its own subtitles (a band of text strokes while people speak).
 * Works on small grey frames (320 px wide) taken at a few moments, so it takes a few seconds even for a film.
 */
import { probeSize, run, tool } from "./tools";

/** A part of the picture, in % of its width (x, w) and height (y, h). */
export type Area = { x: number; y: number; w: number; h: number };

const FW = 320; // frames are analysed this wide for logos
const SW = 640; // and this wide for subtitles: the small strokes of Chinese characters blur away at 320

async function grab(src: string, t: number, w: number, h: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  // -ss before -i: jumps to the nearest keyframe instead of decoding everything before it (fast in long films)
  const out = await run(tool("ffmpeg"), ["-v", "error", "-ss", t.toFixed(2), "-i", src, "-frames:v", "1",
    "-vf", `scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"], { signal }).catch(() => null);
  return out && out.length >= w * h ? new Uint8Array(out.buffer, out.byteOffset, w * h) : null;
}

async function grabAll(src: string, times: number[], w: number, h: number, signal?: AbortSignal) {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < times.length; i += 4) { // 4 at a time
    const got = await Promise.all(times.slice(i, i + 4).map((t) => grab(src, t, w, h, signal)));
    for (const f of got) if (f) frames.push(f);
  }
  return frames;
}

/** Edge strength (horizontal + vertical difference) of every pixel. */
function edges(f: Uint8Array, h: number) {
  const g = new Uint16Array(FW * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < FW - 1; x++) {
      const i = y * FW + x;
      g[i] = Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + FW] - f[i - FW]);
    }
  }
  return g;
}

const pct = (v: number, of: number) => (v / of) * 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
const clampArea = (a: Area): Area => {
  const x = Math.max(0, a.x), y = Math.max(0, a.y);
  return { x: r1(x), y: r1(y), w: r1(Math.min(100 - x, a.w)), h: r1(Math.min(100 - y, a.h)) };
};

/**
 * Logos: pixels with a strong edge in nearly every frame whose brightness hardly changes, grouped into boxes.
 * A video whose picture barely moves (a slideshow, a still) can't be told apart from its logo: then none.
 */
function findLogos(frames: Uint8Array[], h: number): Area[] {
  const n = frames.length, size = FW * h;
  const sum = new Float64Array(size), sq = new Float64Array(size), strong = new Uint16Array(size);
  for (const f of frames) {
    const g = edges(f, h);
    for (let i = 0; i < size; i++) { sum[i] += f[i]; sq[i] += f[i] * f[i]; if (g[i] > 40) strong[i]++; }
  }
  const std = new Float32Array(size);
  for (let i = 0; i < size; i++) std[i] = Math.sqrt(Math.max(0, sq[i] / n - (sum[i] / n) ** 2));
  const sorted = Float32Array.from(std).sort();
  if (sorted[Math.floor(size / 2)] < 8) return []; // the picture hardly changes: everything looks like a logo
  const mask = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (strong[i] >= n * 0.8 && std[i] < 18) mask[i] = 1;
  // close small gaps between the strokes of a logo (3 px), then group the pixels that touch
  const grown = new Uint8Array(size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < FW; x++) {
      if (!mask[y * FW + x]) continue;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < FW) grown[yy * FW + xx] = 1;
        }
      }
    }
  }
  const seen = new Uint8Array(size), boxes: (Area & { px: number })[] = [];
  for (let start = 0; start < size; start++) {
    if (!grown[start] || seen[start]) continue;
    let x0 = FW, y0 = h, x1 = 0, y1 = 0, px = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!, x = i % FW, y = (i - x) / FW;
      if (mask[i]) { // the box: around the logo's own pixels, not the gap-closing margin
        px++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      for (const j of [i - 1, i + 1, i - FW, i + FW]) {
        if (j >= 0 && j < size && grown[j] && !seen[j] && Math.abs((j % FW) - x) <= 1) { seen[j] = 1; stack.push(j); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // a logo: not tiny, not a frame-wide line (letterbox edge, a horizon that never moves), at most ~6% of the picture
    if (px < 25 || bw > FW * 0.45 || bh > h * 0.3 || bw * bh > size * 0.06 || bw < 6 || bh < 4) continue;
    const padX = Math.max(2, bw * 0.12), padY = Math.max(2, bh * 0.15);
    boxes.push({ ...clampArea({ x: pct(x0 - padX, FW), y: pct(y0 - padY, h), w: pct(bw + 2 * padX, FW), h: pct(bh + 2 * padY, h) }), px });
  }
  return boxes.sort((a, b) => b.px - a.px).slice(0, 4).map(({ px: _, ...a }) => a);
}

/**
 * Subtitles: burned-in subtitles are bright text with a dark outline or shadow, so they show as bright pixels
 * right next to dark ones - far more than a busy picture has. The rows rich in those while people speak are the
 * band (lower half first, else the top); it is widened over the weaker rows next to it (a second line of
 * Chinese has fewer of them), and the columns its text reaches. null when nothing stands out.
 */
function findSubtitles(frames: Uint8Array[], h: number, logos: Area[]): Area | null {
  if (!frames.length) return null;
  const W = SW;
  const inLogo = (x: number, y: number) => logos.some((a) => {
    const px = (x / W) * 100, py = (y / h) * 100;
    return px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h;
  });
  const rows = new Float64Array(h), cols = new Float64Array(W * h);
  for (const f of frames) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (f[i] > 170 && f[i] - Math.min(f[i - 2], f[i + 2]) > 60 && !inLogo(x, y)) { rows[y]++; cols[i]++; }
      }
    }
  }
  for (let y = 0; y < h; y++) rows[y] /= frames.length;
  const sorted = Float64Array.from(rows).sort();
  const median = sorted[Math.floor(h / 2)], p90 = sorted[Math.floor(h * 0.9)];
  const hot = (y: number) => rows[y] > Math.max(median * 2.2, p90 * 1.4, 3);
  const warm = (y: number) => rows[y] > median * 1.1 && rows[y] > 1;
  // runs of hot rows (small gaps inside a line of text: ~1% of the height)
  const runs: { y0: number; y1: number; score: number }[] = [];
  for (let y = 0; y < h; y++) {
    if (!hot(y)) continue;
    const last = runs[runs.length - 1];
    if (last && y - last.y1 <= Math.max(4, h * 0.012)) { last.y1 = y; last.score += rows[y]; } else runs.push({ y0: y, y1: y, score: rows[y] });
  }
  const fit = runs.filter((r) => r.y1 - r.y0 >= 2 && r.y1 - r.y0 <= h * 0.25);
  const pick = (from: number, to: number) => fit.filter((r) => r.y0 >= from && r.y1 <= to).sort((a, b) => b.score - a.score)[0];
  const band = pick(h * 0.5, h) ?? pick(0, h * 0.3);
  if (!band) return null;
  // widen over warm rows nearby: across a gap of up to ~4% of the height (between two lines of text), at most 15%
  const grow = (from: number, dir: 1 | -1) => {
    let edge = from, cold = 0;
    for (let y = from + dir; y >= 0 && y < h && cold <= Math.max(8, h * 0.04) && Math.abs(y - from) < h * 0.15; y += dir) {
      if (warm(y)) { edge = y; cold = 0; } else cold++;
    }
    return edge;
  };
  band.y0 = grow(band.y0, -1);
  band.y1 = grow(band.y1, 1);
  // The columns: where the band has more text strokes than the picture just above it (a busy picture has
  // bright edges everywhere), smoothed over ~2% of the width; the outermost columns clearly above that.
  const bandH = band.y1 - band.y0 + 1, refY0 = Math.max(0, band.y0 - 2 * bandH), refH = Math.max(1, band.y0 - refY0);
  const score = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let inBand = 0, above = 0;
    for (let y = band.y0; y <= band.y1; y++) inBand += cols[y * W + x];
    for (let y = refY0; y < band.y0; y++) above += cols[y * W + x];
    score[x] = inBand / bandH - above / refH;
  }
  const r = Math.max(1, Math.round(W * 0.01)), smooth = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { s += score[k]; n++; }
    smooth[x] = s / n;
  }
  const top = Math.max(...smooth);
  let x0 = 0, x1 = W - 1;
  while (x0 < x1 && smooth[x0] < top * 0.1) x0++;
  while (x1 > x0 && smooth[x1] < top * 0.1) x1--;
  const padY = Math.max(2, (band.y1 - band.y0) * 0.25), padX = W * 0.05;
  return clampArea({ x: pct(x0 - padX, W), y: pct(band.y0 - padY, h), w: pct(x1 - x0 + 2 * padX, W),
    h: pct(band.y1 - band.y0 + 2 * padY, h) });
}

/** The logos and the subtitle band of a video. `speech`: times when people speak (subtitles show then). */
export async function detectBurnedIn(src: string, duration: number, speech: number[], signal?: AbortSignal) {
  const { width, height } = await probeSize(src);
  const fh = Math.max(2, Math.round((FW * height) / width / 2) * 2);
  const even = (k: number) => Array.from({ length: k }, (_, i) => duration * (0.05 + (0.9 * (i + 0.5)) / k));
  const logoFrames = await grabAll(src, even(24), FW, fh, signal);
  const logos = logoFrames.length >= 6 ? findLogos(logoFrames, fh) : [];
  // moments when someone speaks, spread over the video (or evenly, when there is no transcript)
  const step = Math.max(1, Math.floor(speech.length / 24));
  const talk = speech.length ? speech.filter((_, i) => i % step === 0).slice(0, 24) : even(24);
  const sh = Math.max(2, Math.round((SW * height) / width / 2) * 2);
  const subtitle = findSubtitles(await grabAll(src, talk, SW, sh, signal), sh, logos);
  return { logos, subtitle };
}
