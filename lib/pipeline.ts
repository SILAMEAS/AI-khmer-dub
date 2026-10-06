/**
 * Khmer dubbing pipeline: download -> transcribe -> translate -> TTS -> mix -> mux.
 * Audio is streamed through ffmpeg in chunks, so a 2-hour movie needs little RAM.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { MODELS_DIR, SR, decodeMono, probeDuration, run, tool } from "./tools";

export const VOICES = { male: "km-KH-PisethNeural", female: "km-KH-SreymomNeural" } as const;
export type Voice = keyof typeof VOICES;
const MODELS: Record<string, string> = {
  best: "ggml-large-v3-turbo-q5_0.bin",
  balanced: "ggml-medium-q5_0.bin",
  fast: "ggml-small-q5_1.bin",
};
const VAD_MODEL = "ggml-silero-v5.1.2.bin";
const MAX_SPEEDUP = 1.6; // never speed a Khmer line up more than this
const GAP = 0.05;        // seconds of silence kept between dubbed lines
export const PREVIEW_TEXT = "សួស្តី! នេះគឺជាសំឡេងបញ្ចូលភាសាខ្មែរ សម្រាប់ភាពយន្តរបស់អ្នក។";

export type Segment = { start: number; end: number; text: string; km: string };
export type Report = (stage: string, frac: number, msg: string) => void;
export type Opts = {
  url: string; inputName?: string; title?: string;
  sourceLang: "auto" | "zh" | "en"; quality: string;
  voice: Voice; rate: number; bgMode: "duck" | "none"; burn: boolean; review: boolean;
};
export type Meta = { input: string; title: string; duration: number; language: string; segments: number };

// ---------------------------------------------------------------- helpers

const clock = (t: number) => {
  t = Math.floor(t);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

function ts(t: number): string {
  let ms = Math.round(Math.max(t, 0) * 1000);
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000); ms -= m * 60_000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function writeSrt(file: string, items: [number, number, string][]): void {
  const out: string[] = [];
  let n = 0;
  for (const [a, b, text] of items) {
    if (!text.trim()) continue;
    out.push(String(++n), `${ts(a)} --> ${ts(b)}`, text.trim(), "");
  }
  fs.writeFileSync(file, "﻿" + out.join("\n"), "utf8"); // BOM helps Windows players
}

export const loadSegments = (jd: string): Segment[] =>
  JSON.parse(fs.readFileSync(path.join(jd, "segments.json"), "utf8"));
export const saveSegments = (jd: string, segs: Segment[]) =>
  fs.writeFileSync(path.join(jd, "segments.json"), JSON.stringify(segs, null, 1), "utf8");

function trimSilence(a: Float32Array, thr = 0.008): Float32Array {
  let s = 0, e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) <= thr) s++;
  while (e > s && Math.abs(a[e]) <= thr) e--;
  if (s >= a.length) return a.subarray(0, 0);
  return a.subarray(Math.max(s - Math.round(0.02 * SR), 0), Math.min(e + Math.round(0.06 * SR), a.length));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stage 1: input

async function download(url: string, jd: string, report: Report): Promise<{ file: string; title: string }> {
  let file = "", title = "video";
  report("download", 0, "Downloading video");
  await run(tool("yt-dlp"), [
    url, "--no-playlist", "--newline", "--progress", "--encoding", "utf-8",
    "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", path.dirname(tool("ffmpeg")),
    "-o", path.join(jd, "input.%(ext)s"),
    "--print", "after_move:FILE:%(filepath)s",
    "--print", "after_move:TITLE:%(title)s",
  ], {
    onLine: (l) => {
      const m = l.match(/\[download\]\s+([\d.]+)%/);
      if (m) report("download", parseFloat(m[1]) / 100, "Downloading video");
      if (l.startsWith("FILE:")) file = l.slice(5).trim();
      if (l.startsWith("TITLE:")) title = l.slice(6).trim();
    },
  });
  if (!file || !fs.existsSync(file)) {
    const f = fs.readdirSync(jd).find((n) => n.startsWith("input.") && !/\.(part|ytdl)$/.test(n));
    if (!f) throw new Error("Download finished but no video file was found");
    file = path.join(jd, f);
  }
  return { file, title };
}

// ---------------------------------------------------------------- stage 2: speech to text

async function transcribe(wav: string, jd: string, lang: string, quality: string, report: Report) {
  let model = path.join(MODELS_DIR, MODELS[quality] ?? MODELS.best);
  if (!fs.existsSync(model)) {
    const any = Object.values(MODELS).map((m) => path.join(MODELS_DIR, m)).find((m) => fs.existsSync(m));
    if (!any) throw new Error("No Whisper model found - run: npm run setup");
    model = any;
  }
  const base = path.join(jd, "whisper");
  const vad = path.join(MODELS_DIR, VAD_MODEL);

  const whisper = async (useVad: boolean, label: string) => {
    const args = ["-m", model, "-f", wav, "-l", lang === "auto" ? "auto" : lang,
      "-t", String(Math.min(os.cpus().length, 12)), "-mc", "0", "-bs", "5",
      "-oj", "-of", base, "-pp"];
    if (useVad) args.push("--vad", "-vm", vad, "-vsd", "400", "-vp", "200");
    if (lang === "zh") args.push("--prompt", "以下是普通话的句子。"); // nudges simplified Chinese + punctuation
    report("transcribe", 0, label);
    await run(tool("whisper-cli"), args, {
      onLine: (l) => {
        const m = l.match(/progress\s*=\s*(\d+)%/);
        if (m) report("transcribe", +m[1] / 100, `${label} ${m[1]}%`);
      },
    });
    return JSON.parse(fs.readFileSync(base + ".json", "utf8"));
  };

  // VAD skips music and silence, but it can reject singing or speech under loud music
  // entirely. If it finds nothing, listen to the whole track instead.
  const hasVad = fs.existsSync(vad);
  let json = await whisper(hasVad, "Recognising speech");
  if (hasVad && !(json.transcription ?? []).length) {
    json = await whisper(false, "No clear speech found - listening to the whole track");
  }
  const segs: Segment[] = [];
  for (const s of json.transcription ?? []) {
    const text = String(s.text).trim().replace(/^["“”「」『』]+|["“”「」『』]+$/g, "").trim();
    // skip empty lines and sound tags like [Music] / (音乐)
    if (!text || /^[\[(（【♪].*[\])）】♪]$/.test(text)) continue;
    const start = s.offsets.from / 1000, end = s.offsets.to / 1000;
    const prev = segs[segs.length - 1];
    // whisper often cuts mid-sentence: glue the pieces back so translation and voice sound natural
    if (prev && !/[.?!。？！…]$/.test(prev.text) && start - prev.end < 0.6 && end - prev.start < 15) {
      prev.text += (/[一-鿿]$/.test(prev.text) ? "" : " ") + text;
      prev.end = end;
    } else {
      segs.push({ start, end, text, km: "" });
    }
  }
  return { segs, language: String(json.result?.language ?? lang) };
}

// ---------------------------------------------------------------- stage 3: translate

// Google blocks Node's HTTP client on the "gtx" endpoint (HTTP 429) but not on the
// Chrome-extension one, so that is tried first. Both keep line breaks.
const ENDPOINTS = [
  async (text: string, src: string) => {
    const res = await fetch(`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${src}&tl=km`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ q: text }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // sl=auto answers [[text, detectedLang]], a fixed source answers [text]
    return String(Array.isArray(data[0]) ? data[0][0] : data[0]);
  },
  async (text: string, src: string) => {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=km&dt=t`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ q: text }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data[0] as [string][]).map((p) => p[0]).join("");
  },
];

async function googleTranslate(text: string, src: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const call of ENDPOINTS) {
      try { return (await call(text, src)).trim(); } catch (e) { lastErr = e; }
    }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`Translation failed: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

async function translate(segs: Segment[], srcLang: string, report: Report) {
  const src = srcLang === "zh" ? "zh-CN" : srcLang === "en" ? "en" : "auto";
  // ~4500-char chunks: far fewer requests and the translator sees context
  const chunks: number[][] = [];
  let cur: number[] = [], size = 0;
  segs.forEach((s, i) => {
    const len = s.text.length + 1;
    if (cur.length && size + len > 4500) { chunks.push(cur); cur = []; size = 0; }
    cur.push(i); size += len;
  });
  if (cur.length) chunks.push(cur);

  let done = 0;
  for (const chunk of chunks) {
    const joined = chunk.map((i) => segs[i].text.replace(/\n/g, " ")).join("\n");
    const lines = (await googleTranslate(joined, src)).split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === chunk.length) chunk.forEach((i, k) => (segs[i].km = lines[k]));
    else for (const i of chunk) segs[i].km = await googleTranslate(segs[i].text, src); // line count drifted
    done += chunk.length;
    report("translate", done / segs.length, `Translating to Khmer ${done}/${segs.length}`);
  }
}

export async function prepare(jd: string, opts: Opts, report: Report): Promise<Meta> {
  let src: string, title = opts.title || "video";
  if (opts.url) ({ file: src, title } = await download(opts.url, jd, report));
  else src = path.join(jd, opts.inputName!);

  report("extract", 0, "Extracting audio");
  const wav = path.join(jd, "audio16k.wav");
  await run(tool("ffmpeg"), ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav]);
  const duration = await probeDuration(src);

  const { segs, language } = await transcribe(wav, jd, opts.sourceLang, opts.quality, report);
  if (!segs.length) throw new Error("No speech was detected in this video");
  await translate(segs, language, report);
  saveSegments(jd, segs);
  writeSrt(path.join(jd, "original.srt"), segs.map((s) => [s.start, s.end, s.text]));
  writeSrt(path.join(jd, "km.srt"), segs.map((s) => [s.start, s.end, s.km]));
  return { input: path.basename(src), title, duration, language, segments: segs.length };
}

// ---------------------------------------------------------------- stage 4: Khmer voice

async function synth(tts: MsEdgeTTS, text: string, rate: number): Promise<Buffer> {
  const { audioStream } = tts.toStream(text, { rate: `${rate >= 0 ? "+" : ""}${rate}%` });
  const parts: Buffer[] = [];
  for await (const c of audioStream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

async function newTts(voice: Voice): Promise<MsEdgeTTS> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICES[voice], OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  return tts;
}

async function ttsAll(segs: Segment[], voice: Voice, rate: number, dir: string, report: Report) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const items = segs.map((s, i) => ({ i, text: s.km.trim() })).filter((x) => x.text);
  let next = 0, done = 0;
  const worker = async () => {
    let tts = await newTts(voice);
    while (next < items.length) {
      const { i, text } = items[next++];
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const mp3 = await synth(tts, text, rate);
          if (mp3.length) { await fsp.writeFile(path.join(dir, `${i}.mp3`), mp3); break; }
        } catch { /* reconnect and retry below */ }
        tts.close();
        await sleep(2000 * (attempt + 1));
        tts = await newTts(voice);
      }
      report("tts", ++done / items.length, `Generating Khmer voice ${done}/${items.length}`);
    }
    tts.close();
  };
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));
}

export async function voicePreview(voice: Voice, rate: number, out: string) {
  const tts = await newTts(voice);
  try { await fsp.writeFile(out, await synth(tts, PREVIEW_TEXT, rate)); } finally { tts.close(); }
}

// ---------------------------------------------------------------- stage 5: sync + mix

type Clip = { i: number; pos: number; len: number; file: string }; // pos/len in samples

/** Fit each Khmer clip into its slot (speeding it up if needed); saves processed clips as raw f32. */
async function placeClips(segs: Segment[], dir: string, duration: number, report: Report): Promise<Clip[]> {
  const clips: Clip[] = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const mp3 = path.join(dir, `${i}.mp3`);
    if (!fs.existsSync(mp3)) continue;
    let a = trimSilence(await decodeMono(mp3));
    if (!a.length) continue;
    const pos = Math.max(segs[i].start, cursor);
    const nxt = i + 1 < segs.length ? segs[i + 1].start : duration;
    const avail = Math.max(nxt - pos - GAP, 0.1);
    const dur = a.length / SR;
    if (dur > avail) {
      const factor = Math.min(dur / avail, MAX_SPEEDUP);
      a = trimSilence(await decodeMono(mp3, `atempo=${factor.toFixed(4)}`));
    }
    let peak = 0;
    for (const v of a) peak = Math.max(peak, Math.abs(v));
    const out = new Float32Array(a.length);
    const k = peak > 0 ? 0.89 / peak : 1;
    for (let j = 0; j < a.length; j++) out[j] = a[j] * k;
    const file = path.join(dir, `${i}.f32`);
    await fsp.writeFile(file, Buffer.from(out.buffer));
    clips.push({ i, pos: Math.round(pos * SR), len: out.length, file });
    cursor = pos + out.length / SR + GAP;
    if (i % 20 === 0) report("mix", 0.3 * (i / segs.length), "Syncing Khmer voice to the video");
  }
  return clips;
}

/** Ducking envelope: original audio drops to `low` while anyone speaks, `high` elsewhere. */
function duckKeypoints(intervals: [number, number][], low: number, high: number, ramp = 0.25) {
  const merged: [number, number][] = [];
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 2 * ramp + 0.1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const t = [0], g = [high];
  for (const [a, b] of merged) {
    t.push(Math.max(a - ramp, t[t.length - 1]), Math.max(a, t[t.length - 1]), b, b + ramp);
    g.push(high, low, low, high);
  }
  return { t, g };
}

/** Streams stereo f32 background in, adds the Khmer clips + ducking, streams the mix out. */
class Mixer extends Transform {
  private cursor = 0;
  private rem = Buffer.alloc(0);
  private nextClip = 0;
  private active: { pos: number; data: Float32Array }[] = [];
  private k = 0;
  private lastReport = 0;

  constructor(private n: number, private clips: Clip[], private env: { t: number[]; g: number[] } | null,
              private report: Report) { super(); }

  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    try {
      const buf = this.rem.length ? Buffer.concat([this.rem, chunk]) : chunk;
      const frames = Math.floor(buf.length / 8);
      this.rem = Buffer.from(buf.subarray(frames * 8));
      if (frames) this.push(this.mix(buf.subarray(0, frames * 8), frames));
      cb();
    } catch (e) { cb(e as Error); }
  }

  _flush(cb: TransformCallback) {
    // background shorter than the video (or missing): keep going on silence
    while (this.cursor < this.n) {
      const k = Math.min(SR * 10, this.n - this.cursor);
      this.push(this.mix(Buffer.alloc(k * 8), k));
    }
    cb();
  }

  private gain(t: number): number {
    if (!this.env) return 1;
    const { t: kt, g: kg } = this.env;
    while (this.k < kt.length - 1 && kt[this.k + 1] <= t) this.k++;
    if (this.k >= kt.length - 1) return kg[kg.length - 1];
    const t0 = kt[this.k], t1 = kt[this.k + 1];
    return t1 > t0 ? kg[this.k] + ((kg[this.k + 1] - kg[this.k]) * (t - t0)) / (t1 - t0) : kg[this.k + 1];
  }

  private mix(raw: Buffer, frames: number): Buffer {
    frames = Math.min(frames, this.n - this.cursor);
    if (frames <= 0) return Buffer.alloc(0);
    const s = new Float32Array(frames * 2);
    new Uint8Array(s.buffer).set(raw.subarray(0, frames * 8));
    const a = this.cursor, b = a + frames;

    while (this.nextClip < this.clips.length && this.clips[this.nextClip].pos < b) {
      const c = this.clips[this.nextClip++];
      const bytes = fs.readFileSync(c.file);
      const data = new Float32Array(bytes.length / 4);
      new Uint8Array(data.buffer).set(bytes);
      this.active.push({ pos: c.pos, data });
    }
    const dub = new Float32Array(frames);
    for (const c of this.active) {
      const from = Math.max(a, c.pos), to = Math.min(b, c.pos + c.data.length);
      for (let t = from; t < to; t++) dub[t - a] += c.data[t - c.pos];
    }
    this.active = this.active.filter((c) => c.pos + c.data.length > b);

    for (let j = 0; j < frames; j++) {
      const g = this.gain((a + j) / SR);
      const l = s[2 * j] * g + dub[j], r = s[2 * j + 1] * g + dub[j];
      s[2 * j] = l > 1 ? 1 : l < -1 ? -1 : l;
      s[2 * j + 1] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
    this.cursor = b;
    if (b - this.lastReport > SR * 30) {
      this.lastReport = b;
      this.report("mix", 0.3 + 0.7 * (b / this.n), "Mixing Khmer voice with the soundtrack");
    }
    return Buffer.from(s.buffer);
  }
}

async function mix(jd: string, src: string, segs: Segment[], duration: number, bgMode: string, report: Report) {
  const clips = await placeClips(segs, path.join(jd, "tts"), duration, report);
  const n = Math.ceil(duration * SR);
  const env = bgMode === "duck"
    ? duckKeypoints([...segs.map((s) => [s.start, s.end] as [number, number]),
        ...clips.map((c) => [c.pos / SR, (c.pos + c.len) / SR] as [number, number])], 0.12, 0.8)
    : null;

  const ffmpeg = tool("ffmpeg");
  const decArgs = bgMode === "duck"
    ? ["-v", "error", "-i", src, "-vn", "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"]
    : ["-v", "error", "-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=stereo`, "-t", String(duration),
       "-f", "f32le", "-"];
  const dec = spawn(ffmpeg, decArgs, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const out = path.join(jd, "dub_audio.m4a");
  const enc = spawn(ffmpeg, ["-y", "-v", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-",
    "-c:a", "aac", "-b:a", "192k", out], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let encErr = "";
  enc.stderr.on("data", (c: Buffer) => (encErr = (encErr + c).slice(-2000)));
  const encDone = new Promise<number>((r) => enc.on("close", (code) => r(code ?? 1)));

  await pipeline(dec.stdout, new Mixer(n, clips, env, report), enc.stdin);
  if ((await encDone) !== 0) throw new Error("Audio encoding failed:\n" + encErr);
  return clips;
}

// ---------------------------------------------------------------- stage 6: final video

async function mux(jd: string, src: string, burn: boolean, report: Report) {
  report("mux", 0, burn ? "Burning subtitles into the video" : "Building final video");
  const ffmpeg = tool("ffmpeg");
  const base = ["-y", "-v", "error", "-i", path.basename(src), "-i", "dub_audio.m4a", "-i", "km.srt",
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:0"];
  const tail = ["-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=khm",
    "-metadata:s:a:0", "language=khm", "-movflags", "+faststart", "-shortest", "output.mp4"];
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  if (burn) {
    const style = "FontName=Khmer UI,FontSize=20,Outline=2,Shadow=0,MarginV=28";
    await run(ffmpeg, [...base, "-vf", `subtitles=km.srt:force_style='${style}'`, ...encode, ...tail], { cwd: jd });
    return;
  }
  try {
    await run(ffmpeg, [...base, "-c:v", "copy", ...tail], { cwd: jd });
  } catch { // source codec can't go into MP4 as-is
    await run(ffmpeg, [...base, ...encode, ...tail], { cwd: jd });
  }
}

export async function dub(jd: string, opts: Opts, meta: Meta, report: Report) {
  const segs = loadSegments(jd);
  const src = path.join(jd, meta.input);
  await ttsAll(segs, opts.voice, opts.rate, path.join(jd, "tts"), report);
  const clips = await mix(jd, src, segs, meta.duration, opts.bgMode, report);

  // Khmer subtitles follow the dubbed speech, held until the original line ends
  const placed = new Map<number, [number, number]>(clips.map((c) => [c.i, [c.pos / SR, (c.pos + c.len) / SR]]));
  const items: [number, number, string][] = segs.map((s, i) => {
    const [a, b] = placed.get(i) ?? [s.start, s.start];
    let nxt = meta.duration;
    for (let j = i + 1; j < segs.length; j++) {
      const p = placed.get(j);
      if (p) { nxt = p[0]; break; }
    }
    return [a, Math.min(Math.max(b, s.end, a + 1), Math.max(nxt - 0.02, b)), s.km];
  });
  writeSrt(path.join(jd, "km.srt"), items);
  await mux(jd, src, opts.burn, report);
}
