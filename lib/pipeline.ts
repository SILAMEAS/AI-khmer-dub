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
import { MODELS_DIR, SR, decodeMono, hasFilter, probeDuration, probeSize, run, tool } from "./tools";
import { analyzeLines, median } from "./voice";
import { FONTS_DIR, logoFile, parseLogo, parseSubStyle, pictureFilter, type LogoOpts, type SubStyle } from "./branding";
import { BACKGROUND, cloneAvailable, convertVoices, findSpeakers, separate, speakerSample } from "./clone";

export const VOICES = { male: "km-KH-PisethNeural", female: "km-KH-SreymomNeural" } as const;
export type Voice = keyof typeof VOICES;
/** auto: boy or girl per line; clone: each line in the original speaker's own voice (lib/clone.ts). */
export type VoiceChoice = Voice | "auto" | "clone";
export const defaultVoice = (): VoiceChoice => (cloneAvailable() ? "clone" : "auto");
/** Why a requested voice can't be used, or null when it can. */
export function voiceError(v: string): string | null {
  if (v === "clone") return cloneAvailable() ? null : "Voice cloning is not installed - run: npm run setup -- --clone";
  return v in VOICES || v === "auto" ? null : "voice must be clone, auto, male or female";
}
// Natural pitch of each Khmer voice (Hz) and how far it moves per Hz of SSML pitch offset,
// measured from the voices themselves. Used to bring the dub close to the original speaker.
const VOICE_PITCH: Record<Voice, { f0: number; perHz: number }> = {
  male: { f0: 135, perHz: 0.89 },
  female: { f0: 231, perHz: 1.57 },
};
const MATCH = 0.6;        // move this share of the way from the AI voice's pitch to the speaker's
const MAX_TTS_RATE = 60;  // to fit a long line, let the voice itself talk at most this much faster (%)
const MP3_BYTES_PER_SEC = 96000 / 8;
const VOICE_DB = -17;     // average loudness of the dub (dBFS RMS)
const MODELS: Record<string, string> = {
  best: "ggml-large-v3-turbo-q5_0.bin",
  balanced: "ggml-medium-q5_0.bin",
  fast: "ggml-small-q5_1.bin",
};
const VAD_MODEL = "ggml-silero-v5.1.2.bin";
const MAX_SPEEDUP = 1.6; // never speed a Khmer line up more than this
const GAP = 0.05;        // seconds of silence kept between dubbed lines
export const PREVIEW_TEXT = "សួស្តី! នេះគឺជាសំឡេងបញ្ចូលភាសាខ្មែរ សម្រាប់ភាពយន្តរបស់អ្នក។";

/**
 * f0/db: the original speaker's pitch (Hz, 0 = unclear) and loudness; voice: boy or girl for the line (editable);
 * speaker: which person says it (0-based, voice cloning only; editable).
 */
export type Segment = {
  start: number; end: number; text: string; km: string; f0?: number; db?: number; voice?: Voice; speaker?: number;
};
export type Report = (stage: string, frac: number, msg: string) => void;
export type Opts = {
  url: string; inputName?: string; title?: string;
  sourceLang: "auto" | "zh" | "en"; quality: string;
  voice: VoiceChoice; match?: boolean; rate: number; bgMode: "duck" | "none"; burn: boolean; review: boolean;
  sub?: SubStyle; logo?: LogoOpts; // look of the video (lib/branding.ts)
};
export type Meta = {
  input: string; title: string; duration: number; language: string; segments: number; speakers?: number;
};

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

async function transcribe(wav: string, jd: string, lang: string, quality: string, report: Report, also = "") {
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
      "-t", String(Math.min(os.cpus().length, 16)), "-mc", "0", "-bs", "5", // 16 threads: fastest in our tests
      "-ojf", "-of", base, "-pp"]; // full JSON: word timings, to split a line where the speaker changes
    if (useVad) args.push("--vad", "-vm", vad, "-vsd", "400", "-vp", "200");
    if (lang === "zh") args.push("--prompt", "以下是普通话的句子。"); // nudges simplified Chinese + punctuation
    report("transcribe", 0, label);
    await run(tool("whisper-cli"), args, {
      onLine: (l) => {
        const m = l.match(/progress\s*=\s*(\d+)%/);
        if (m) report("transcribe", +m[1] / 100, `${label} ${m[1]}%${also}`);
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
  const lines: RawLine[] = [];
  for (const s of json.transcription ?? []) {
    const text = cleanText(s.text);
    // skip empty lines and sound tags like [Music] / (音乐)
    if (!text || /^[\[(（【♪].*[\])）】♪]$/.test(text)) continue;
    const words = (s.tokens ?? []).filter((t: { text: string }) => !t.text.startsWith("[_"))
      .map((t: { text: string; offsets: { from: number } }) => ({ text: t.text, at: t.offsets.from / 1000 }));
    lines.push({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text, words });
  }
  return { lines, language: String(json.result?.language ?? lang) };
}

/** A whisper line with the start time of each word, before lines are glued into sentences. */
type RawLine = { start: number; end: number; text: string; words: { text: string; at: number }[]; speaker?: number };

const cleanText = (t: string) => String(t).trim().replace(/^["“”「」『』]+|["“”「」『』]+$/g, "").trim();

/** Whisper often cuts mid-sentence: glue the pieces back (same person only) so translation and voice sound natural. */
function glue(lines: RawLine[]): Segment[] {
  const segs: Segment[] = [];
  for (const l of lines) {
    const prev = segs[segs.length - 1];
    if (prev && prev.speaker === l.speaker && !/[.?!。？！…]$/.test(prev.text) && l.start - prev.end < 0.6
        && l.end - prev.start < 15) {
      prev.text += (/[一-鿿]$/.test(prev.text) ? "" : " ") + l.text;
      prev.end = l.end;
    } else {
      segs.push({ start: l.start, end: l.end, text: l.text, km: "", ...(l.speaker !== undefined && { speaker: l.speaker }) });
    }
  }
  return segs;
}

/** Cuts a whisper line in two between words, as close as possible to `at` (seconds); null if it can't. */
function splitLine(l: RawLine, at: number): [RawLine, RawLine] | null {
  let k = -1, best = Infinity;
  // whisper's word pieces: " word" in spaced languages, single characters in Chinese; broken bytes are unusable
  if (!l.words.some((w) => w.text.includes("�"))) {
    l.words.forEach((w, i) => {
      if (i > 0 && /^(\s|[　-鿿＀-￯])/.test(w.text) && Math.abs(w.at - at) < best) {
        best = Math.abs(w.at - at);
        k = i;
      }
    });
  }
  let left: string, right: string;
  if (k > 0) {
    left = l.words.slice(0, k).map((w) => w.text).join("");
    right = l.words.slice(k).map((w) => w.text).join("");
  } else { // no usable word timings: cut the text in proportion to time, at a space or punctuation nearby
    const chars = [...l.text];
    let i = Math.round((chars.length * (at - l.start)) / Math.max(l.end - l.start, 0.01));
    for (let d = 0; d <= 4; d++) {
      if (/[\s，。、,.?!？！]/.test(chars[i + d - 1] ?? "")) { i += d; break; }
      if (/[\s，。、,.?!？！]/.test(chars[i - d - 1] ?? "")) { i -= d; break; }
    }
    left = chars.slice(0, i).join("");
    right = chars.slice(i).join("");
  }
  if (!cleanText(left) || !cleanText(right)) return null;
  return [
    { start: l.start, end: at, text: cleanText(left), words: k > 0 ? l.words.slice(0, k) : [] },
    { start: at, end: l.end, text: cleanText(right), words: k > 0 ? l.words.slice(k) : [] },
  ];
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

/** Who is speaking each line: pitch and loudness of the original voice, and boy or girl for the dub. */
function analyzeSpeakers(jd: string, segs: Segment[], report: Report) {
  report("analyze", 0, "Listening to who speaks each line");
  analyzeLines(path.join(jd, "audio16k.wav"), segs).forEach((v, i) => {
    Object.assign(segs[i], { f0: Math.round(v.f0), db: Math.round(v.db * 10) / 10, voice: v.gender });
  });
}

export async function prepare(jd: string, opts: Opts, report: Report): Promise<Meta> {
  let src: string, title = opts.title || "video";
  if (opts.url) ({ file: src, title } = await download(opts.url, jd, report));
  else src = path.join(jd, opts.inputName!);

  report("extract", 0, "Extracting audio");
  const wav = path.join(jd, "audio16k.wav");
  await run(tool("ffmpeg"), ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav]);
  const duration = await probeDuration(src);

  // voice cloning: split voices from music at the same time as the speech is recognised (they don't depend
  // on each other, and running both at once finishes sooner than one after the other)
  const separating = opts.voice === "clone" ? separate(jd, src, duration, () => {}) : null;
  separating?.catch(() => {}); // a failure is reported where it is awaited
  const { lines, language } = await transcribe(wav, jd, opts.sourceLang, opts.quality, report,
    separating ? " (and separating voices from music)" : "");
  if (!lines.length) throw new Error("No speech was detected in this video");
  if (separating) {
    report("separate", 0.9, "Separating voices from music");
    await separating;
  }
  const meta: Meta = { input: path.basename(src), title, duration, language, segments: 0 };
  const segs = glue(opts.voice === "clone" ? await splitBySpeaker(jd, lines, meta, report) : lines);
  meta.segments = segs.length;
  analyzeSpeakers(jd, segs, report);
  await translate(segs, language, report);
  saveSegments(jd, segs);
  writeSrt(path.join(jd, "original.srt"), segs.map((s) => [s.start, s.end, s.text]));
  writeSrt(path.join(jd, "km.srt"), segs.map((s) => [s.start, s.end, s.km]));
  return meta;
}

/**
 * Voice cloning: split voices from music, find who says each line (and where another person cuts in)
 * and keep a voice sample of each person.
 */
async function speakerPieces(jd: string, lines: { start: number; end: number }[], meta: Meta, report: Report) {
  report("separate", 0, "Separating voices from music");
  await separate(jd, path.join(jd, meta.input), meta.duration,
    (f) => report("separate", f, `Separating voices from music ${Math.round(f * 100)}%`));
  report("analyze", 0, "Finding who speaks each line");
  const pieces = await findSpeakers(jd, lines, (f) => report("analyze", f, "Finding who speaks each line"));
  meta.speakers = new Set(pieces.map((p) => p.speaker)).size;
  return pieces;
}

/** Whisper lines cut wherever another person starts talking, each with its speaker. */
async function splitBySpeaker(jd: string, lines: RawLine[], meta: Meta, report: Report): Promise<RawLine[]> {
  const pieces = await speakerPieces(jd, lines, meta, report);
  const out: RawLine[] = [];
  lines.forEach((l, n) => {
    const mine = pieces.filter((p) => p.line === n).sort((a, b) => a.start - b.start);
    let rest = l, speaker = mine[0]?.speaker ?? 0;
    for (const p of mine.slice(1)) {
      const cut = splitLine(rest, p.start);
      if (!cut) continue; // nothing to cut between: the line stays with the first person
      out.push({ ...cut[0], speaker });
      [rest, speaker] = [cut[1], p.speaker];
    }
    out.push({ ...rest, speaker });
  });
  return out;
}

/** Switching an already transcribed job to cloning: each line goes to the person who says most of it. */
async function assignSpeakers(jd: string, segs: Segment[], meta: Meta, report: Report) {
  const pieces = await speakerPieces(jd, segs, meta, report);
  segs.forEach((s, n) => {
    const mine = pieces.filter((p) => p.line === n);
    s.speaker = mine.sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]?.speaker ?? 0;
  });
}

// ---------------------------------------------------------------- stage 4: Khmer voice

const signed = (n: number, unit: string) => `${n >= 0 ? "+" : ""}${n}${unit}`;

async function synth(tts: MsEdgeTTS, text: string, rate: number, pitch = 0): Promise<Buffer> {
  const { audioStream } = tts.toStream(text, { rate: signed(rate, "%"), pitch: signed(pitch, "Hz") });
  const parts: Buffer[] = [];
  for await (const c of audioStream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

async function newTts(voice: Voice): Promise<MsEdgeTTS> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICES[voice], OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  return tts;
}

/** SSML pitch offset (Hz) that moves the AI voice part of the way toward the speaker's own pitch. */
function pitchOffset(voice: Voice, speakerF0: number): number {
  const { f0, perHz } = VOICE_PITCH[voice];
  if (!speakerF0) return 0;
  // a voice pushed far from its natural pitch sounds robotic, so stay within -20% / +25%
  const target = Math.min(Math.max(f0 + MATCH * (speakerF0 - f0), f0 * 0.8), f0 * 1.25);
  return Math.round((target - f0) / perHz);
}

// cloning starts from the boy or girl voice closest to the speaker; the cloned voice then sets the real pitch
const lineVoice = (s: Segment, choice: VoiceChoice): Voice =>
  choice === "auto" || choice === "clone" ? s.voice ?? "female" : choice;

async function ttsAll(segs: Segment[], opts: Opts, duration: number, dir: string, report: Report) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const items = segs.map((s, i) => ({
    i, text: s.km.trim(), voice: lineVoice(s, opts.voice),
    // time until the next line starts: a dub that runs longer gets sped up
    slot: Math.max((i + 1 < segs.length ? segs[i + 1].start : duration) - s.start - GAP, 0.3),
  })).filter((x) => x.text);
  let next = 0, done = 0;

  const worker = async () => {
    const conns = new Map<Voice, MsEdgeTTS>();
    const conn = async (v: Voice) => conns.get(v) ?? conns.set(v, await newTts(v)).get(v)!;
    const say = async (v: Voice, text: string, rate: number, pitch: number) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const mp3 = await synth(await conn(v), text, rate, pitch);
          if (mp3.length) return mp3;
        } catch { /* reconnect and retry below */ }
        conns.get(v)?.close();
        conns.delete(v);
        if (attempt === 3) return null;
        await sleep(2000 * (attempt + 1));
      }
    };
    while (next < items.length) {
      const { i, text, voice, slot } = items[next++];
      const pitch = opts.match === false || opts.voice === "clone" ? 0 : pitchOffset(voice, segs[i].f0 ?? 0);
      const file = path.join(dir, `${i}.mp3`);
      let mp3 = await say(voice, text, opts.rate, pitch);
      if (mp3) {
        await fsp.writeFile(file, mp3);
        // Too long for its slot: ask the voice to speak faster, which sounds far more natural
        // than speeding the audio up afterwards. Whatever is left over is stretched in placeClips.
        const spoken = trimSilence(await decodeMono(file)).length / SR || mp3.length / MP3_BYTES_PER_SEC;
        if (spoken > slot * 1.05 && opts.rate < MAX_TTS_RATE) {
          const rate = Math.min(MAX_TTS_RATE, Math.ceil((1 + opts.rate / 100) * (spoken / slot) * 100 - 100));
          mp3 = await say(voice, text, rate, pitch);
          if (mp3) await fsp.writeFile(file, mp3);
        }
      }
      report("tts", ++done / items.length, `Generating Khmer voice ${done}/${items.length}`);
    }
    for (const c of conns.values()) c.close();
  };
  // the voices come from Microsoft's servers: more requests at once mostly means less waiting
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, worker));
}

export async function voicePreview(voice: Voice, rate: number, out: string) {
  const tts = await newTts(voice);
  try { await fsp.writeFile(out, await synth(tts, PREVIEW_TEXT, rate)); } finally { tts.close(); }
}

// ---------------------------------------------------------------- stage 5: sync + mix

type Clip = { i: number; pos: number; len: number; file: string }; // pos/len in samples

/** Fit each Khmer clip into its slot (speeding it up if needed); saves processed clips as raw f32. */
async function placeClips(segs: Segment[], dir: string, duration: number, match: boolean, report: Report): Promise<Clip[]> {
  const clips: Clip[] = [];
  let cursor = 0;
  // rubberband keeps the voice's tone when speeding up; atempo is the fallback on minimal ffmpeg builds
  const stretch = (await hasFilter("rubberband"))
    ? (f: number) => `rubberband=tempo=${f.toFixed(4)}`
    : (f: number) => `atempo=${f.toFixed(4)}`;
  const dbs = segs.map((s) => s.db).filter((d): d is number => d !== undefined && d > -60);
  const refDb = median(dbs);
  const fadeIn = Math.round(0.01 * SR), fadeOut = Math.round(0.04 * SR);

  // decode every line at once (one ffmpeg per line, many in parallel), then place them in order
  const files = segs.map((_, i) => {
    const cloned = path.join(dir, `${i}.vc.wav`);
    return fs.existsSync(cloned) ? cloned : path.join(dir, `${i}.mp3`);
  });
  const audio = await mapLimit(files, DECODE_JOBS, async (f) => (fs.existsSync(f) ? trimSilence(await decodeMono(f)) : null));
  report("mix", 0.1, "Syncing Khmer voice to the video");
  // lines that run into the next one get sped up; the expected length keeps the following lines in place
  const plan: { i: number; factor: number }[] = [];
  for (let i = 0, at = 0; i < segs.length; i++) {
    const a = audio[i];
    if (!a?.length) continue;
    const pos = Math.max(segs[i].start, at);
    const avail = Math.max((i + 1 < segs.length ? segs[i + 1].start : duration) - pos - GAP, 0.1);
    const factor = a.length / SR > avail ? Math.min(a.length / SR / avail, MAX_SPEEDUP) : 1;
    plan.push({ i, factor });
    at = pos + a.length / SR / factor + GAP;
  }
  await mapLimit(plan.filter((p) => p.factor > 1), DECODE_JOBS, async (p) => {
    audio[p.i] = trimSilence(await decodeMono(files[p.i], stretch(p.factor)));
  });
  report("mix", 0.25, "Syncing Khmer voice to the video");

  for (const { i } of plan) {
    const a = audio[i]!;
    if (!a.length) continue;
    const pos = Math.max(segs[i].start, cursor);
    // follow the original: a shout stays louder than a whisper (half the difference, at most ±6 dB)
    const db = segs[i].db;
    const lift = match && dbs.length && db !== undefined && db > -60 ? Math.max(-6, Math.min(6, (db - refDb) / 2)) : 0;
    let peak = 0, energy = 0;
    for (const v of a) { peak = Math.max(peak, Math.abs(v)); energy += v * v; }
    const rms = Math.sqrt(energy / a.length);
    const k = rms > 0 ? Math.min(10 ** ((VOICE_DB + lift) / 20) / rms, 0.95 / peak) : 1;
    const out = new Float32Array(a.length);
    for (let j = 0; j < a.length; j++) {
      const fade = Math.min(1, j / fadeIn, (a.length - 1 - j) / fadeOut);
      out[j] = a[j] * k * fade;
    }
    const file = path.join(dir, `${i}.f32`);
    await fsp.writeFile(file, Buffer.from(out.buffer));
    clips.push({ i, pos: Math.round(pos * SR), len: out.length, file });
    cursor = pos + out.length / SR + GAP;
  }
  return clips;
}

const DECODE_JOBS = Math.max(2, Math.min(8, os.cpus().length));

/** Like Promise.all(items.map(fn)), but at most `limit` running at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
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

async function mix(jd: string, src: string, segs: Segment[], duration: number, bgMode: string, match: boolean,
                   report: Report) {
  const clips = await placeClips(segs, path.join(jd, "tts"), duration, match, report);
  const n = Math.ceil(duration * SR);
  // with the original voices removed (voice cloning) the music only dips a little under the dub
  const bg = path.join(jd, BACKGROUND);
  const clean = fs.existsSync(bg);
  const env = bgMode === "duck"
    ? duckKeypoints([...segs.map((s) => [s.start, s.end] as [number, number]),
        ...clips.map((c) => [c.pos / SR, (c.pos + c.len) / SR] as [number, number])], clean ? 0.5 : 0.12, 0.8)
    : null;

  const ffmpeg = tool("ffmpeg");
  const decArgs = bgMode === "duck"
    ? ["-v", "error", "-i", clean ? bg : src, "-vn", "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"]
    : ["-v", "error", "-f", "lavfi", "-i", `anullsrc=r=${SR}:cl=stereo`, "-t", String(duration),
       "-f", "f32le", "-"];
  const dec = spawn(ffmpeg, decArgs, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const out = path.join(jd, "dub_audio.m4a");
  const enc = spawn(ffmpeg, ["-y", "-v", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-",
    // fast AAC coder: half the encoding time, same quality within 0.2 dB in our test
    "-c:a", "aac", "-aac_coder", "fast", "-b:a", "192k", out], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let encErr = "";
  enc.stderr.on("data", (c: Buffer) => (encErr = (encErr + c).slice(-2000)));
  const encDone = new Promise<number>((r) => enc.on("close", (code) => r(code ?? 1)));

  await pipeline(dec.stdout, new Mixer(n, clips, env, report), enc.stdin);
  if ((await encDone) !== 0) throw new Error("Audio encoding failed:\n" + encErr);
  return clips;
}

// ---------------------------------------------------------------- stage 6: final video

/** Picture filters (burned subtitles, sliding logo) for this job's options, plus the extra logo input. */
async function look(jd: string, src: string, opts: Opts, shift?: number) {
  const logo = opts.logo?.enabled ? logoFile() : null;
  if (!opts.burn && !logo) return { inputs: [] as string[], filter: null };
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const filter = pictureFilter({
    burn: opts.burn, sub: parseSubStyle(opts.sub), logo: logo ? parseLogo(opts.logo) : null,
    logoInput: 3, ...(await probeSize(path.join(jd, path.basename(src)))), shift,
  });
  return { inputs: logo ? ["-loop", "1", "-i", logo] : [], filter };
}

async function mux(jd: string, src: string, opts: Opts, report: Report) {
  const { inputs, filter } = await look(jd, src, opts);
  report("mux", 0, filter ? "Adding subtitles and logo to the picture" : "Building final video");
  const ffmpeg = tool("ffmpeg");
  const base = ["-y", "-v", "error", "-i", path.basename(src), "-i", "dub_audio.m4a", "-i", "km.srt", ...inputs];
  const streams = ["-map", "1:a:0", "-map", "2:0"];
  const tail = ["-c:a", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=khm",
    "-metadata:s:a:0", "language=khm", "-movflags", "+faststart", "output.mp4"];
  // no -shortest: it also counts the subtitle track and would cut the video after the last line
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  if (filter) {
    await run(ffmpeg, [...base, "-filter_complex", filter, "-map", "[v]", ...streams, ...encode, ...tail], { cwd: jd });
    return;
  }
  try {
    await run(ffmpeg, [...base, "-map", "0:v:0", ...streams, "-c:v", "copy", ...tail], { cwd: jd });
  } catch { // source codec can't go into MP4 as-is
    await run(ffmpeg, [...base, "-map", "0:v:0", ...streams, ...encode, ...tail], { cwd: jd });
  }
}

/** Only the picture changed (subtitle style, logo): rebuild the video from the existing Khmer audio. */
export async function render(jd: string, opts: Opts, meta: Meta, report: Report) {
  await mux(jd, path.join(jd, meta.input), opts, report);
}

/** One frame at `t` seconds with the subtitles and logo exactly as the video will show them (PNG). */
export async function previewFrame(jd: string, opts: Opts, meta: Meta, t: number): Promise<Buffer> {
  const src = path.join(jd, meta.input);
  const { inputs, filter } = await look(jd, src, { ...opts, burn: true }, t);
  return run(tool("ffmpeg"), ["-v", "error", "-ss", t.toFixed(3), "-i", path.basename(src),
    "-f", "lavfi", "-i", "anullsrc", "-f", "lavfi", "-i", "anullsrc", ...inputs,
    "-filter_complex", filter!, "-map", "[v]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { cwd: jd });
}

export async function dub(jd: string, opts: Opts, meta: Meta, report: Report) {
  const segs = loadSegments(jd);
  const src = path.join(jd, meta.input);
  if (segs.some((s) => !s.voice) && fs.existsSync(path.join(jd, "audio16k.wav"))) { // jobs from before analysis
    analyzeSpeakers(jd, segs, report);
    saveSegments(jd, segs);
  }
  if (opts.voice === "clone" && (segs.some((s) => s.speaker === undefined) || !fs.existsSync(speakerSample(jd, 0)))) {
    await assignSpeakers(jd, segs, meta, report); // switched to cloning after the transcription
    saveSegments(jd, segs);
  }
  const ttsDir = path.join(jd, "tts");
  await ttsAll(segs, opts, meta.duration, ttsDir, report);
  if (opts.voice === "clone") {
    const items = segs.map((s, i) => ({ src: path.join(ttsDir, `${i}.mp3`), ref: speakerSample(jd, s.speaker ?? 0),
      out: path.join(ttsDir, `${i}.vc.wav`) })).filter((x) => fs.existsSync(x.src) && fs.existsSync(x.ref));
    report("clone", 0, `Speaking in the original voices 0/${items.length}`);
    await convertVoices(jd, items, (f) =>
      report("clone", f, `Speaking in the original voices ${Math.round(f * items.length)}/${items.length}`));
  }
  const clips = await mix(jd, src, segs, meta.duration, opts.bgMode, opts.match !== false, report);

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
  await mux(jd, src, opts, report);
}
