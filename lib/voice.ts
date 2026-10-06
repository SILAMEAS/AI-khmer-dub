/**
 * Speaker analysis: how high (pitch) and how loud each original line is.
 * Used to pick a boy or girl Khmer voice per line and to shape it like the original speaker.
 */

export type Gender = "male" | "female";
export type VoiceInfo = { f0: number; db: number; gender?: Gender };

const AR = 8000;            // analysis rate: plenty for voice pitch, 4x cheaper than 16 kHz
const FMIN = 65, FMAX = 420; // human speaking pitch range (Hz)
const SPLIT = 160;          // below: man, above: woman or child
const MAX_SECONDS = 8;      // a line's first seconds are enough to judge the voice

/**
 * Pitch track with the YIN method (de Cheveigné & Kawahara, 2002).
 * Returns the pitch (Hz) of every clearly voiced 40 ms frame; quiet or noisy frames are skipped.
 */
export function pitchTrack(x: Float32Array, sr = AR): number[] {
  const tMin = Math.floor(sr / FMAX), tMax = Math.ceil(sr / FMIN);
  const W = Math.round(sr * 0.04), hop = Math.round(sr * 0.02);
  const d = new Float32Array(tMax + 1);

  const rms: number[] = [];
  for (let s = 0; s + W + tMax <= x.length; s += hop) {
    let e = 0;
    for (let j = 0; j < W; j++) e += x[s + j] * x[s + j];
    rms.push(Math.sqrt(e / W));
  }
  // only frames well above the background (music, hum, room noise) are the person speaking
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0, peak = sorted[sorted.length - 1] ?? 0;
  const gate = Math.max(floor * 1.6, peak * 0.2, 0.003);

  const out: number[] = [];
  for (let f = 0, s = 0; f < rms.length; f++, s += hop) {
    if (rms[f] < gate) continue;
    for (let tau = 1; tau <= tMax; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const v = x[s + j] - x[s + j + tau]; sum += v * v; }
      d[tau] = sum;
    }
    // cumulative mean normalised difference; first dip under the threshold is the period
    let run = 0, best = -1;
    for (let tau = 1; tau <= tMax; tau++) {
      run += d[tau];
      d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }
    let lowest = tMin;
    for (let tau = tMin; tau <= tMax; tau++) {
      if (d[tau] < d[lowest]) lowest = tau;
      if (d[tau] < 0.2) {
        while (tau + 1 <= tMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0 && d[lowest] < 0.35) best = lowest; // less clear but still voiced
    if (best < 0) continue;
    // parabolic interpolation for sub-sample accuracy
    const a = d[best - 1] ?? d[best], b = d[best], c = d[best + 1] ?? d[best];
    const den = a - 2 * b + c;
    const t = best + (den > 0 ? (a - c) / (2 * den) : 0);
    out.push(sr / t);
  }
  return out;
}

export const percentile = (v: number[], q: number) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length * q)];
};
export const median = (v: number[]) => percentile(v, 0.5);

/**
 * Typical pitch (median Hz, 0 if unclear), a low pitch used to tell men from women, and loudness (dBFS).
 * An excited or shouting man goes high but keeps dipping low; a woman rarely does, so the 35th
 * percentile separates them better than the median (tested with noise, hum and music behind the voice).
 */
export function voiceInfo(x: Float32Array, sr = AR): VoiceInfo & { low: number } {
  let e = 0;
  for (const v of x) e += v * v;
  const db = x.length ? 10 * Math.log10(e / x.length + 1e-10) : -100;
  const p = pitchTrack(x, sr);
  const ok = p.length >= 8;
  return { f0: ok ? median(p) : 0, low: ok ? percentile(p, 0.35) : 0, db };
}

/** Reads part of a 16-bit mono WAV as float samples at 8 kHz (2:1 average from 16 kHz). */
function wavReader(file: string) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  let off = 12, data = -1, rate = 16000;
  while (off + 8 <= head.length) {
    const id = head.toString("ascii", off, off + 4), size = head.readUInt32LE(off + 4);
    if (id === "fmt ") rate = head.readUInt32LE(off + 12);
    if (id === "data") { data = off + 8; break; }
    off += 8 + size + (size & 1);
  }
  if (data < 0) { fs.closeSync(fd); throw new Error("Unreadable WAV: " + file); }
  const step = Math.max(1, Math.round(rate / AR));
  return {
    read(start: number, end: number): Float32Array {
      const a = Math.max(0, Math.floor(start * rate)), n = Math.max(0, Math.floor((end - start) * rate));
      const buf = Buffer.alloc(n * 2);
      const got = fs.readSync(fd, buf, 0, buf.length, data + a * 2);
      const m = Math.floor(got / 2 / step), x = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        let s = 0;
        for (let k = 0; k < step; k++) s += buf.readInt16LE((i * step + k) * 2);
        x[i] = s / step / 32768;
      }
      return x;
    },
    close: () => fs.closeSync(fd),
  };
}

/**
 * Measures every line in the 16 kHz track and decides boy or girl.
 * Lines with unclear pitch (music, whispering, very short) take the voice of the nearest clear line.
 */
export function analyzeLines(wav: string, lines: { start: number; end: number }[]): VoiceInfo[] {
  const r = wavReader(wav);
  let infos: ReturnType<typeof voiceInfo>[];
  try {
    infos = lines.map((l) => voiceInfo(r.read(l.start, Math.min(l.end, l.start + MAX_SECONDS))));
  } finally { r.close(); }

  const votes = infos.filter((v) => v.low).map((v) => v.low < SPLIT);
  const majority: Gender = votes.filter(Boolean).length > votes.length / 2 ? "male" : "female";
  for (let i = 0; i < infos.length; i++) {
    if (infos[i].low) { infos[i].gender = infos[i].low < SPLIT ? "male" : "female"; continue; }
    // no clear pitch (music, whisper, a short word): a line that follows straight on is
    // most likely the same person, otherwise go with whoever talks most
    const prev = i > 0 && lines[i].start - lines[i - 1].end < 0.3 ? infos[i - 1].gender : undefined;
    infos[i].gender = prev ?? majority;
  }
  return infos.map(({ f0, db, gender }) => ({ f0, db, gender }));
}import { fs } from "./rt";

