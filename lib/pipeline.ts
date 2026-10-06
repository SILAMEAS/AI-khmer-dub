/**
 * Khmer dubbing pipeline: download -> transcribe -> translate -> TTS -> mix -> mux.
 * Audio is streamed through ffmpeg in chunks, so a 2-hour movie needs little RAM.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fs, fsp, path } from "./rt";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { BIN, MODELS_DIR, SR, decodeMono, hasFilter, probeDuration, probeSize, run, tool } from "./tools";
import { analyzeLines, median } from "./voice";
import {
  CRF, FONTS_DIR, logoFile, musicFile, parseFx, parseLogo, parseOut, parseSubStyle, pictureFilter, titleAss,
  type FxOpts, type LogoOpts, type OutOpts, type SubStyle,
} from "./branding";
import { BACKGROUND, VOCALS, cloneAvailable, convertVoices, findSpeakers, separate, speakerSample, stemsReady } from "./clone";

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
  sub?: SubStyle; logo?: LogoOpts; out?: OutOpts; fx?: FxOpts; // look and format of the video (lib/branding.ts)
  trim?: Trim; mix?: MixOpts;
};
/** Part of the video to dub, in seconds of the source (to = 0: until the end). */
export type Trim = { from: number; to: number };
/**
 * Sound levels. music: original soundtrack between lines (%); duck: the soundtrack while someone speaks
 * (%, -1 = automatic); voice: Khmer voice louder or softer (dB); loudnorm: final loudness -14 LUFS, what
 * YouTube, Facebook and TikTok play at, so the video is neither quieter nor louder than the ones around it;
 * bgm: level of your own background music (branding/music.*, %; 0 = none), looped and lowered under speech.
 * split: separate the original voices from the music (Demucs; always so with voice cloning), so that
 * voices: the original voices get their own level (%; 0 = removed) and origTone their own sound;
 * khmerTone: sound of the Khmer voice; parts: other levels for stretches of the video (original sound and
 * Khmer voice, in %).
 */
export type MixOpts = {
  music: number; duck: number; voice: number; loudnorm: boolean; bgm: number;
  split: boolean; voices: number; khmerTone: Tone; origTone: Tone; parts: Part[];
};
/** pitch: semitones; bass / treble: dB; echo: none, a room or a hall. */
export type Tone = { pitch: number; bass: number; treble: number; echo: "none" | "room" | "hall" };
export type Part = { from: number; to: number; orig: number; khmer: number };
const FLAT: Tone = { pitch: 0, bass: 0, treble: 0, echo: "none" };
// the original voices are removed by default (separated from the music when the voice tools are installed)
export const DEFAULT_MIX: MixOpts = {
  music: 80, duck: -1, voice: 0, loudnorm: true, bgm: 0,
  split: true, voices: 0, khmerTone: FLAT, origTone: FLAT, parts: [],
};

const num = (v: unknown, lo: number, hi: number, d: number) =>
  v !== null && v !== "" && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d;
export function parseMix(v: unknown): MixOpts {
  const m = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof MixOpts, unknown>>;
  const duck = num(m.duck, -1, 100, DEFAULT_MIX.duck);
  const tone = (v: unknown): Tone => {
    const t = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof Tone, unknown>>;
    return { pitch: num(t.pitch, -12, 12, 0), bass: num(t.bass, -15, 15, 0), treble: num(t.treble, -15, 15, 0),
      echo: t.echo === "room" || t.echo === "hall" ? t.echo : "none" };
  };
  const parts = (Array.isArray(m.parts) ? m.parts : []).slice(0, 30).map((x: Partial<Record<keyof Part, unknown>>) => ({
    from: num(x?.from, 0, 1e6, 0), to: num(x?.to, 0, 1e6, 0),
    orig: num(x?.orig, 0, 200, 100), khmer: num(x?.khmer, 0, 200, 100),
  })).filter((x) => x.to > x.from);
  return { music: num(m.music, 0, 100, DEFAULT_MIX.music), duck: duck < 0 ? -1 : duck,
    voice: num(m.voice, -10, 10, DEFAULT_MIX.voice), loudnorm: m.loudnorm !== false, bgm: num(m.bgm, 0, 100, 0),
    split: m.split === undefined ? DEFAULT_MIX.split : m.split === true, voices: num(m.voices, 0, 150, 0), khmerTone: tone(m.khmerTone), origTone: tone(m.origTone),
    parts };
}
/** Cut points from the browser; undefined when the whole video is used. */
export function parseTrim(v: unknown): Trim | undefined {
  const t = (v && typeof v === "object" ? v : {}) as Partial<Record<keyof Trim, unknown>>;
  const from = num(t.from, 0, 1e6, 0), to = num(t.to, 0, 1e6, 0);
  if (to && to <= from + 0.5) throw new Error("The end of the cut must be after its start");
  return from || to ? { from, to } : undefined;
}
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

/**
 * Subtitles as shown in the video: km.srt (Khmer), bilingual.srt (Khmer + original) and subs.json, from which
 * the burned-in subtitles are made in the chosen style.
 */
type Sub = [number, number, string, string]; // start, end, Khmer, original
function writeSubs(jd: string, subs: Sub[]) {
  const shown = subs.filter((x) => x[2].trim()); // a line without Khmer text is not dubbed
  fs.writeFileSync(path.join(jd, "subs.json"), JSON.stringify(shown), "utf8");
  writeSrt(path.join(jd, "km.srt"), shown.map(([a, b, km]) => [a, b, km]));
  writeSrt(path.join(jd, "bilingual.srt"), shown.map(([a, b, km, text]) => [a, b, `${km.trim()}\n${text.trim()}`]));
}

// how a burned-in line appears (ASS tags, which ffmpeg also reads in .srt)
const ANIM: Record<SubStyle["anim"], string> = {
  none: "", fade: "{\\fad(180,120)}", pop: "{\\fscx70\\fscy70\\t(0,160,\\fscx100\\fscy100)}",
};

/**
 * The subtitle file to burn in: km.srt, or one made for the style: the original in smaller letters under the
 * Khmer (bilingual) and / or an animation on each line.
 */
function burnSrt(jd: string, sub: SubStyle, name: string): string {
  const file = path.join(jd, "subs.json");
  if ((!sub.bilingual && sub.anim === "none") || !fs.existsSync(file)) return "km.srt";
  const subs: Sub[] = JSON.parse(fs.readFileSync(file, "utf8"));
  const small = Math.max(8, Math.round(sub.size * 0.72));
  // ffmpeg reads <font> tags in .srt; < > { } in the text itself would be taken as tags
  const clean = (t: string) => t.replace(/[<>{}]/g, "").trim();
  writeSrt(path.join(jd, name), subs.map(([a, b, km, text]) =>
    [a, b, ANIM[sub.anim] + clean(km) + (sub.bilingual ? `\n<font size="${small}">${clean(text)}</font>` : "")]));
  return name;
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

/*
 * Speech recognition. Whisper's own VAD glues the speech together and maps the lines back to the video, but not
 * the word timings: a line could then stretch over a minute of music with its words in the wrong place, and the
 * captions showed a stray word while people were talking. So the speech stretches are found here (Silero VAD),
 * glued with a map of where each piece came from, and every word is put back at its real time. A line is cut at
 * every real pause, and stretches that came back without words are listened to a second time.
 */
const PAUSE = 1.0;     // seconds without words that start a new line
const STRETCH_PAD = 0.15;

/** Speech stretches (seconds) in a 16 kHz wav, found by Silero VAD; [] when the VAD tool or model is missing. */
async function speechStretches(wav: string): Promise<[number, number][]> {
  const exe = path.join(BIN, "whisper", "Release", `whisper-vad-speech-segments${process.platform === "win32" ? ".exe" : ""}`);
  const vad = path.join(MODELS_DIR, VAD_MODEL);
  if (!fs.existsSync(exe) || !fs.existsSync(vad)) return [];
  const out = (await run(exe, ["-np", "-vm", vad, "-f", wav, "-vsd", "300", "-vp", "150", "-t", "8"])).toString();
  const raw = [...out.matchAll(/start = ([\d.]+), end = ([\d.]+)/g)].map((m) => [+m[1] / 100, +m[2] / 100] as [number, number]);
  const merged: [number, number][] = [];
  for (const [x, y] of raw) {
    const a = Math.max(0, x - STRETCH_PAD), b = y + STRETCH_PAD, last = merged[merged.length - 1];
    if (last && a <= last[1] + 0.3) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Where the 16-bit samples of a WAV file start, and how many bytes they take. */
function wavData(file: string) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8192);
  const got = fs.readSync(fd, head, 0, head.length, 0);
  for (let p = 12; p + 8 <= got;) {
    const id = head.toString("latin1", p, p + 4), size = head.readUInt32LE(p + 4);
    if (id === "data") return { fd, offset: p + 8, bytes: Math.min(size, fs.fstatSync(fd).size - p - 8) };
    p += 8 + size + (size & 1);
  }
  fs.closeSync(fd);
  throw new Error(`Cannot read the audio file ${path.basename(file)}`);
}

type TimeMap = { c0: number; c1: number; o0: number }[]; // glued time c0..c1 is video time o0..

/** The speech stretches of a 16 kHz mono wav, one after the other with `gap` s of silence, and where each came from. */
function glueSpeech(src: string, stretches: [number, number][], out: string, gap: number): TimeMap {
  const hz = 16000, { fd, offset, bytes } = wavData(src);
  const outFd = fs.openSync(out, "w");
  const silence = Buffer.alloc(Math.round(gap * hz) * 2);
  const map: TimeMap = [];
  let pos = 44, c = 0; // samples go after the 44-byte header, written last
  for (const [a, b] of stretches) {
    const s0 = Math.floor(a * hz), s1 = Math.min(bytes / 2, Math.ceil(b * hz));
    if (s1 <= s0) continue;
    if (map.length) { fs.writeSync(outFd, silence, 0, silence.length, pos); pos += silence.length; c += gap; }
    const buf = Buffer.alloc((s1 - s0) * 2);
    fs.readSync(fd, buf, 0, buf.length, offset + s0 * 2);
    fs.writeSync(outFd, buf, 0, buf.length, pos);
    pos += buf.length;
    map.push({ c0: c, c1: c + (s1 - s0) / hz, o0: s0 / hz });
    c += (s1 - s0) / hz;
  }
  const h = Buffer.alloc(44), data = pos - 44;
  h.write("RIFF", 0, "latin1"); h.writeUInt32LE(36 + data, 4); h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(hz, 24);
  h.writeUInt32LE(hz * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36, "latin1"); h.writeUInt32LE(data, 40);
  fs.writeSync(outFd, h, 0, 44, 0);
  fs.closeSync(outFd);
  fs.closeSync(fd);
  return map;
}

/** Glued time -> video time (a moment in the silence between two pieces goes to the nearer one). */
function unglue(map: TimeMap, t: number): number {
  if (!map.length) return t;
  for (let i = 0; i < map.length; i++) {
    const m = map[i];
    if (t < m.c0) {
      const prev = map[i - 1];
      return prev && t - prev.c1 < m.c0 - t ? prev.o0 + (prev.c1 - prev.c0) : m.o0;
    }
    if (t <= m.c1) return m.o0 + (t - m.c0);
  }
  const last = map[map.length - 1];
  return last.o0 + (last.c1 - last.c0);
}

type WhisperJson = {
  transcription?: { text: string; offsets: { from: number; to: number }; tokens?: { text: string; offsets: { from: number; to: number } }[] }[];
  result?: { language?: string };
};

/** Whisper lines -> lines in video time, each word at its real time and a new line at every real pause. */
function toLines(json: WhisperJson, map: TimeMap): RawLine[] {
  const lines: RawLine[] = [];
  const wordStart = (t: string) => /^(\s|[　-鿿＀-￯])/.test(t);
  for (const seg of json.transcription ?? []) {
    const text = cleanText(seg.text);
    // skip empty lines and sound tags like [Music] / (音乐)
    if (!text || /^[\[(（【♪].*[\])）】♪]$/.test(text)) continue;
    const toks = (seg.tokens ?? []).filter((t) => !t.text.startsWith("[_"))
      .map((t) => ({ text: t.text, a: unglue(map, t.offsets.from / 1000), b: unglue(map, t.offsets.to / 1000) }));
    if (!toks.length) {
      lines.push({ start: unglue(map, seg.offsets.from / 1000), end: unglue(map, seg.offsets.to / 1000), text, words: [] });
      continue;
    }
    const pieces: (typeof toks)[] = [[toks[0]]];
    for (const t of toks.slice(1)) {
      const cur = pieces[pieces.length - 1];
      if (t.a - cur[cur.length - 1].b > PAUSE && wordStart(t.text)) pieces.push([t]);
      else cur.push(t);
    }
    // Chinese characters can come split over two tokens (shown as �): then the line's own text is shared out
    // over the pieces by their number of tokens, cut at punctuation nearby when there is some
    const broken = toks.some((t) => t.text.includes("�"));
    const chars = [...text];
    let used = 0;
    pieces.forEach((pc, k) => {
      let piece: string;
      if (!broken || pieces.length === 1) piece = pieces.length === 1 ? text : cleanText(pc.map((t) => t.text).join(""));
      else {
        let cutAt = k === pieces.length - 1 ? chars.length
          : Math.round((chars.length * pieces.slice(0, k + 1).reduce((n, x) => n + x.length, 0)) / toks.length);
        for (let d = 0; d <= 3 && k < pieces.length - 1; d++) {
          if (/[，。、,.?!？！\s]/.test(chars[cutAt + d - 1] ?? "")) { cutAt += d; break; }
          if (/[，。、,.?!？！\s]/.test(chars[cutAt - d - 1] ?? "")) { cutAt -= d; break; }
        }
        piece = cleanText(chars.slice(used, Math.max(used, cutAt)).join(""));
        used = Math.max(used, cutAt);
      }
      if (!piece) return;
      const start = pc[0].a, end = Math.max(pc[pc.length - 1].b, start + 0.3);
      lines.push({ start, end, text: piece, words: broken ? [] : pc.map((t) => ({ text: t.text, at: t.a })) });
    });
  }
  return lines.sort((x, y) => x.start - y.start);
}

async function transcribe(wav: string, jd: string, lang: string, quality: string, report: Report, also = "") {
  let model = path.join(MODELS_DIR, MODELS[quality] ?? MODELS.best);
  if (!fs.existsSync(model)) {
    const any = Object.values(MODELS).map((m) => path.join(MODELS_DIR, m)).find((m) => fs.existsSync(m));
    if (!any) throw new Error("No Whisper model found - run: npm run setup");
    model = any;
  }
  const base = path.join(jd, "whisper");

  const whisper = async (file: string, language: string, label: string): Promise<WhisperJson> => {
    const args = ["-m", model, "-f", file, "-l", language === "auto" ? "auto" : language,
      "-t", String(Math.min(os.cpus().length, 16)), "-mc", "0", "-bs", "5", // 16 threads: fastest in our tests
      "-ojf", "-of", base, "-pp"]; // full JSON: the time of every word
    if (language === "zh") args.push("--prompt", "以下是普通话的句子。"); // nudges simplified Chinese + punctuation
    report("transcribe", 0, label);
    await run(tool("whisper-cli"), args, {
      onLine: (l) => {
        const m = l.match(/progress\s*=\s*(\d+)%/);
        if (m) report("transcribe", +m[1] / 100, `${label} ${m[1]}%${also}`);
      },
    });
    return JSON.parse(fs.readFileSync(base + ".json", "utf8"));
  };

  report("transcribe", 0, "Finding where people speak");
  const stretches = await speechStretches(wav);
  if (!stretches.length) { // no VAD, or it heard nothing (singing, speech under loud music): the whole track
    const json = await whisper(wav, lang, stretches.length ? "Recognising speech" : "Listening to the whole track");
    return { lines: toLines(json, []), language: String(json.result?.language ?? lang) };
  }
  const glued = path.join(jd, "speech16k.wav");
  const map = glueSpeech(wav, stretches, glued, 0.3);
  const json = await whisper(glued, lang, "Recognising speech");
  const language = String(json.result?.language ?? lang);
  const lines = toLines(json, map);

  // second pass: speech stretches that came back without a single word
  const missed = stretches.filter(([a, b]) => b - a >= 0.6
    && !lines.some((l) => l.start < b + 0.2 && l.end > a - 0.2));
  if (missed.length) {
    const again = glueSpeech(wav, missed, glued, 0.5);
    const more = toLines(await whisper(glued, language, `Listening again to ${missed.length} missed part${missed.length > 1 ? "s" : ""}`), again);
    lines.push(...more);
    lines.sort((x, y) => x.start - y.start);
  }
  fs.rmSync(glued, { force: true });
  if (!lines.length) { // speech was found but nothing understood: listen to the whole track once more
    const json = await whisper(wav, lang, "Listening to the whole track");
    return { lines: toLines(json, []), language: String(json.result?.language ?? language) };
  }
  return { lines, language };
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
  // a video downloaded before (the first try failed later on) is used again instead of downloading it twice
  const downloaded = opts.url ? fs.readdirSync(jd).find((n) => /^input\.(mp4|mkv|webm|mov)$/i.test(n)) : undefined;
  if (opts.url && downloaded) {
    src = path.join(jd, downloaded);
    if (!opts.title) { // made before titles were kept: ask the site for the title only (no download)
      const out = await run(tool("yt-dlp"), [opts.url, "--no-playlist", "--skip-download", "--encoding", "utf-8", "--print", "title"])
        .catch(() => Buffer.from(""));
      opts.title = out.toString("utf8").trim().split(/\r?\n/)[0] || "video";
    }
    title = opts.title;
  } else if (opts.url) {
    ({ file: src, title } = await download(opts.url, jd, report));
    opts.title = title;
  }
  else src = path.join(jd, opts.inputName!);

  if (opts.trim) src = await cut(jd, src, opts.trim, report);

  report("extract", 0, "Extracting audio");
  const wav = path.join(jd, "audio16k.wav");
  await run(tool("ffmpeg"), ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", wav]);
  const duration = await probeDuration(src);

  // voices apart from the music first (when wanted): speech under music is then recognised far better
  let speechWav = wav;
  if (opts.voice === "clone" || wantsStems(opts)) {
    try {
      report("separate", 0, "Separating voices from music");
      await separate(jd, src, duration, (f) => report("separate", f, `Separating voices from music ${Math.round(f * 100)}%`));
      speechWav = path.join(jd, "vocals16k.wav");
      await run(tool("ffmpeg"), ["-y", "-v", "error", "-i", path.join(jd, VOCALS), "-ac", "1", "-ar", "16000", speechWav]);
    } catch (e) {
      if (opts.voice === "clone") throw e; // cloning needs the voices; otherwise the full sound will do
      console.error(e);
    }
  }
  const { lines, language } = await transcribe(speechWav, jd, opts.sourceLang, opts.quality, report);
  if (!lines.length) throw new Error("No speech was detected in this video");
  const meta: Meta = { input: path.basename(src), title, duration, language, segments: 0 };
  const segs = glue(opts.voice === "clone" ? await splitBySpeaker(jd, lines, meta, report) : lines);
  meta.segments = segs.length;
  analyzeSpeakers(jd, segs, report);
  await translate(segs, language, report);
  saveSegments(jd, segs);
  writeSrt(path.join(jd, "original.srt"), segs.map((s) => [s.start, s.end, s.text]));
  writeSubs(jd, segs.map((s) => [s.start, s.end, s.km, s.text]));
  return meta;
}

/** Only the chosen part of the video, cut to the frame (re-encoded: a copy could only cut at keyframes). */
async function cut(jd: string, src: string, { from, to }: Trim, report: Report): Promise<string> {
  const total = await probeDuration(src);
  if (from >= total - 0.5) throw new Error(`The cut starts at ${clock(from)}, but the video is only ${clock(total)} long`);
  const len = (to && to < total ? to : total) - from;
  const out = path.join(jd, "input_cut.mp4");
  const label = `Cutting ${clock(from)} – ${clock(from + len)}`;
  report("extract", 0, label);
  await run(tool("ffmpeg"), ["-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-ss", from.toFixed(3), "-i", src,
    "-t", len.toFixed(3), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out], {
    onLine: (l) => {
      const m = l.match(/^out_time_us=(\d+)/);
      if (m) report("extract", Math.min(1, +m[1] / 1e6 / len), label);
    },
  });
  return out;
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

/**
 * Khmer voice for every line. A line made before with the same text, voice, speed and pitch is kept
 * (tts/<i>.key remembers what it was made from), so after editing a few lines only those are made again.
 */
async function ttsAll(segs: Segment[], opts: Opts, duration: number, dir: string, report: Report): Promise<number[]> {
  await fsp.mkdir(dir, { recursive: true });
  const all = segs.map((s, i) => {
    const voice = lineVoice(s, opts.voice);
    // time until the next line starts: a dub that runs longer gets sped up
    const slot = Math.max((i + 1 < segs.length ? segs[i + 1].start : duration) - s.start - GAP, 0.3);
    const pitch = opts.match === false || opts.voice === "clone" ? 0 : pitchOffset(voice, s.f0 ?? 0);
    const text = s.km.trim();
    return { i, text, voice, slot, pitch, key: JSON.stringify([text, voice, opts.rate, pitch, Math.round(slot * 20)]) };
  });
  const keyFile = (i: number) => path.join(dir, `${i}.key`);
  for (const x of all) { // a line emptied since: nothing may be left of its old voice
    if (!x.text) for (const f of [`${x.i}.mp3`, `${x.i}.vc.wav`, `${x.i}.key`, `${x.i}.vckey`]) await fsp.rm(path.join(dir, f), { force: true });
  }
  const items = all.filter((x) => x.text && !(fs.existsSync(path.join(dir, `${x.i}.mp3`))
    && fs.existsSync(keyFile(x.i)) && fs.readFileSync(keyFile(x.i), "utf8") === x.key));
  const kept = all.filter((x) => x.text).length - items.length;
  if (kept) report("tts", 0, `Keeping ${kept} Khmer lines already made`);
  let next = 0, done = 0;
  const failed: number[] = [];

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
      const { i, text, voice, slot, pitch, key } = items[next++];
      const file = path.join(dir, `${i}.mp3`);
      // the old voice of this line goes first: it no longer matches the text
      for (const f of [keyFile(i), file, path.join(dir, `${i}.vc.wav`), path.join(dir, `${i}.vckey`)]) await fsp.rm(f, { force: true });
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
        await fsp.writeFile(keyFile(i), key, "utf8");
      } else failed.push(i);
      report("tts", ++done / items.length, `Generating Khmer voice ${done}/${items.length}`);
    }
    for (const c of conns.values()) c.close();
  };
  // the voices come from Microsoft's servers: more requests at once mostly means less waiting
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, worker));
  return failed.sort((a, b) => a - b);
}

export async function voicePreview(voice: Voice, rate: number, out: string) {
  const tts = await newTts(voice);
  try { await fsp.writeFile(out, await synth(tts, PREVIEW_TEXT, rate)); } finally { tts.close(); }
}

// ---------------------------------------------------------------- stage 5: sync + mix

type Clip = { i: number; pos: number; len: number; file: string }; // pos/len in samples

/** ffmpeg audio filters for a Tone ("" when it leaves the sound as it is). */
function toneFilter(t: Tone, rubberband: boolean): string {
  const f: string[] = [];
  if (t.pitch) {
    const r = 2 ** (t.pitch / 12);
    // rubberband keeps the length and sounds natural; the fallback plays faster or slower, then restores the length
    f.push(rubberband ? `rubberband=pitch=${r.toFixed(4)}:formant=preserved`
      : `aresample=${SR},asetrate=${Math.round(SR * r)},aresample=${SR},atempo=${(1 / r).toFixed(4)}`);
  }
  if (t.bass) f.push(`bass=g=${t.bass}`);
  if (t.treble) f.push(`treble=g=${t.treble}`);
  if (t.echo === "room") f.push("apad=pad_dur=0.3,aecho=0.8:0.7:35|55:0.22|0.15");
  if (t.echo === "hall") f.push("apad=pad_dur=0.8,aecho=0.8:0.8:90|170|260:0.3|0.2|0.12");
  return f.join(",");
}

/** Fit each Khmer clip into its slot (speeding it up if needed); saves processed clips as raw f32. */
async function placeClips(segs: Segment[], dir: string, duration: number, match: boolean, clone: boolean,
                          report: Report): Promise<Clip[]> {
  const clips: Clip[] = [];
  let cursor = 0;
  // rubberband keeps the voice's tone when speeding up; atempo is the fallback on minimal ffmpeg builds
  const rb = await hasFilter("rubberband");
  const stretch = (f: number) => (rb ? `rubberband=tempo=${f.toFixed(4)}` : `atempo=${f.toFixed(4)}`);
  const dbs = segs.map((s) => s.db).filter((d): d is number => d !== undefined && d > -60);
  const refDb = median(dbs);
  const fadeIn = Math.round(0.01 * SR), fadeOut = Math.round(0.04 * SR);

  // decode every line at once (one ffmpeg per line, many in parallel), then place them in order
  const files = segs.map((_, i) => {
    const cloned = path.join(dir, `${i}.vc.wav`);
    return clone && fs.existsSync(cloned) ? cloned : path.join(dir, `${i}.mp3`);
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

/**
 * The Khmer voice alone, every line in its place (voice_track.m4a): mixed with the soundtrack below, and played by
 * the browser's live preview, which applies the Khmer voice's level and sound itself.
 */
async function writeVoiceTrack(jd: string, clips: Clip[], duration: number) {
  const n = Math.ceil(duration * SR);
  async function* samples() {
    const sorted = [...clips].sort((a, b) => a.pos - b.pos);
    let next = 0, active: { pos: number; data: Float32Array }[] = [];
    for (let a = 0; a < n; a += SR * 10) {
      const b = Math.min(n, a + SR * 10), out = new Float32Array(b - a);
      while (next < sorted.length && sorted[next].pos < b) {
        const bytes = await fsp.readFile(sorted[next].file), data = new Float32Array(bytes.length / 4);
        new Uint8Array(data.buffer).set(bytes);
        active.push({ pos: sorted[next++].pos, data });
      }
      for (const c of active) {
        const from = Math.max(a, c.pos), to = Math.min(b, c.pos + c.data.length);
        for (let t = from; t < to; t++) out[t - a] += c.data[t - c.pos];
      }
      active = active.filter((c) => c.pos + c.data.length > b);
      yield Buffer.from(out.buffer);
    }
  }
  const enc = spawn(tool("ffmpeg"), ["-y", "-v", "error", "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", "-",
    "-c:a", "aac", "-aac_coder", "fast", "-b:a", "128k", path.join(jd, VOICE_TRACK)],
  { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  enc.stderr.on("data", (c: Buffer) => (err = (err + c).slice(-2000)));
  const done = new Promise<number>((r) => enc.on("close", (code) => r(code ?? 1)));
  await pipeline(Readable.from(samples()), enc.stdin);
  if ((await done) !== 0) throw new Error("Writing the Khmer voice track failed:\n" + err);
}
export const VOICE_TRACK = "voice_track.m4a";

/**
 * Streams the sound in as 5 channels of f32 (music & effects L/R, original voices L/R, Khmer voice), dips the
 * music while someone speaks, applies the per-part levels, streams stereo out.
 */
class Mixer extends Transform {
  private cursor = 0;
  private rem = Buffer.alloc(0);
  private k = 0;
  private lastReport = 0;
  private po = 1; // per-part level of the original sound and of the Khmer voice at the current sample
  private pk = 1;

  constructor(private n: number, private env: { t: number[]; g: number[] } | null,
              private parts: Part[], private report: Report) { super(); }

  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    try {
      const buf = this.rem.length ? Buffer.concat([this.rem, chunk]) : chunk;
      const frames = Math.floor(buf.length / FRAME);
      this.rem = Buffer.from(buf.subarray(frames * FRAME));
      if (frames) this.push(this.mix(buf.subarray(0, frames * FRAME), frames));
      cb();
    } catch (e) { cb(e as Error); }
  }

  _flush(cb: TransformCallback) {
    // background shorter than the video (or missing): keep going on silence
    while (this.cursor < this.n) {
      const k = Math.min(SR * 10, this.n - this.cursor);
      this.push(this.mix(Buffer.alloc(k * FRAME), k));
    }
    cb();
  }

  /** Levels of the parts covering `t`, with a short ramp at their edges so nothing clicks. */
  private part(t: number) {
    let o = 1, k = 1;
    for (const p of this.parts) {
      const r = Math.min(1, (t - p.from) / PART_RAMP, (p.to - t) / PART_RAMP);
      if (r <= 0) continue;
      o *= 1 + (p.orig / 100 - 1) * r;
      k *= 1 + (p.khmer / 100 - 1) * r;
    }
    this.po = o; this.pk = k;
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
    const s = new Float32Array(frames * 5);
    new Uint8Array(s.buffer).set(raw.subarray(0, frames * FRAME));
    const a = this.cursor, b = a + frames;

    const out = new Float32Array(frames * 2);
    for (let j = 0; j < frames; j++) {
      const t = (a + j) / SR, g = this.gain(t);
      if (this.parts.length) this.part(t);
      const o = this.po, k = this.pk;
      const dub = s[5 * j + 4] * k;
      const l = (s[5 * j] * g + s[5 * j + 2]) * o + dub;
      const r = (s[5 * j + 1] * g + s[5 * j + 3]) * o + dub;
      out[2 * j] = l > 1 ? 1 : l < -1 ? -1 : l;
      out[2 * j + 1] = r > 1 ? 1 : r < -1 ? -1 : r;
    }
    this.cursor = b;
    if (b - this.lastReport > SR * 30) {
      this.lastReport = b;
      this.report("mix", 0.3 + 0.7 * (b / this.n), "Mixing Khmer voice with the soundtrack");
    }
    return Buffer.from(out.buffer);
  }
}
const FRAME = 20;       // bytes per sample frame coming in: 5 channels of f32
const PART_RAMP = 0.15; // seconds to move to and from a part's levels

async function mix(jd: string, src: string, segs: Segment[], clips: Clip[], duration: number, opts: Opts, report: Report) {
  const { bgMode } = opts, m = parseMix(opts.mix);
  const n = Math.ceil(duration * SR);
  // voices and music as separate tracks (voice cloning, or asked for): the voices get their own level and sound,
  // and the music only dips a little under the dub
  const bg = path.join(jd, BACKGROUND), vocals = path.join(jd, VOCALS);
  const stems = (opts.voice === "clone" || m.split) && stemsReady(jd, duration);
  const high = m.music / 100;
  const low = m.duck >= 0 ? m.duck / 100 : ((stems ? 0.5 : 0.12) * high) / 0.8; // automatic: follows the music level
  const music = m.bgm > 0 ? musicFile() : null;
  // levels are set when decoding (soundtrack: high, your music: bgm); the envelope only dips them while
  // someone speaks - your own music too, also when the original soundtrack is left out
  const dip = high > 0 ? Math.min(1, low / high) : 0.15;
  const env = bgMode === "duck" || music
    ? duckKeypoints([...segs.map((s) => [s.start, s.end] as [number, number]),
        ...clips.map((c) => [c.pos / SR, (c.pos + c.len) / SR] as [number, number])], dip, 1)
    : null;

  const ffmpeg = tool("ffmpeg");
  const voices = bgMode === "duck" && stems && m.voices > 0;
  const inputs = [
    ...(bgMode === "duck" ? ["-i", stems ? bg : src]
      : ["-f", "lavfi", "-t", duration.toFixed(3), "-i", `anullsrc=r=${SR}:cl=stereo`]),
    ...(voices ? ["-i", vocals] : []),
    ...(music ? ["-stream_loop", "-1", "-i", music] : []),
    "-i", path.join(jd, VOICE_TRACK),
  ];
  const khmerIn = (voices ? 2 : 1) + (music ? 1 : 0);
  const rb = await hasFilter("rubberband");
  const khmerTone = toneFilter(m.khmerTone, rb);
  const stereo = `aformat=channel_layouts=stereo,aresample=${SR}`;
  const origTone = toneFilter(m.origTone, rb);
  // channels 1-2: music & effects (and your music), 3-4: the original voices (silent when not kept), 5: Khmer voice
  const graph = [
    `[0:a]${stereo},volume=${high.toFixed(3)}[m0]`,
    music ? `[${voices ? 2 : 1}:a]${stereo},volume=${(m.bgm / 100).toFixed(3)}[bm];[m0][bm]amix=inputs=2:duration=first:normalize=0[m]`
      : "[m0]anull[m]",
    voices ? `[1:a]${stereo}${origTone ? "," + origTone : ""},volume=${(m.voices / 100).toFixed(3)}[v]`
      : `anullsrc=r=${SR}:cl=stereo[v]`,
    `[${khmerIn}:a]aformat=channel_layouts=mono,aresample=${SR}${khmerTone ? "," + khmerTone : ""},volume=${(10 ** (m.voice / 20)).toFixed(4)}[k]`,
    // all in one sample format, or amerge can't put them together; padded, as any of them may end early
    `[m]aformat=sample_fmts=flt:sample_rates=${SR}:channel_layouts=stereo,apad[m2]`,
    `[v]aformat=sample_fmts=flt:sample_rates=${SR}:channel_layouts=stereo,apad[v2]`,
    `[k]aformat=sample_fmts=flt:sample_rates=${SR}:channel_layouts=mono,apad[k2]`,
    "[m2][v2][k2]amerge=inputs=3[o]",
  ].join(";");
  const decArgs = ["-v", "error", ...inputs, "-filter_complex", graph, "-map", "[o]", "-t", duration.toFixed(3),
    "-f", "f32le", "-ar", String(SR), "-"];
  const dec = spawn(ffmpeg, decArgs, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let decErr = "";
  dec.stderr.on("data", (c: Buffer) => (decErr = (decErr + c).slice(-2000)));
  const decDone = new Promise<number>((r) => dec.on("close", (code) => r(code ?? 1)));
  const out = path.join(jd, "dub_audio.m4a");
  const enc = spawn(ffmpeg, ["-y", "-v", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-",
    ...(m.loudnorm ? ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", String(SR)] : []),
    // fast AAC coder: half the encoding time, same quality within 0.2 dB in our test
    "-c:a", "aac", "-aac_coder", "fast", "-b:a", "192k", out], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let encErr = "";
  enc.stderr.on("data", (c: Buffer) => (encErr = (encErr + c).slice(-2000)));
  const encDone = new Promise<number>((r) => enc.on("close", (code) => r(code ?? 1)));

  await pipeline(dec.stdout, new Mixer(n, env, m.parts, report), enc.stdin);
  if ((await decDone) !== 0) throw new Error("Reading the original sound failed:\n" + decErr);
  if ((await encDone) !== 0) throw new Error("Audio encoding failed:\n" + encErr);
  return clips;
}

// ---------------------------------------------------------------- stage 6: final video

/**
 * Picture filters (format, effects, burned subtitles, title, sliding logo) for this job's options, plus the extra
 * logo input. `preview`: files for a preview frame get their own names, so a video being built is not disturbed.
 */
async function look(jd: string, src: string, opts: Opts, duration: number, shift?: number, preview = false) {
  const logo = opts.logo?.enabled ? logoFile() : null;
  fs.mkdirSync(FONTS_DIR, { recursive: true });
  const sub = parseSubStyle(opts.sub), fx = parseFx(opts.fx);
  let title: string | undefined;
  if (fx.title) {
    title = preview ? "title_preview.ass" : "title.ass";
    fs.writeFileSync(path.join(jd, title), titleAss(fx, sub.font), "utf8");
  }
  const filter = pictureFilter({
    burn: opts.burn, sub, logo: logo ? parseLogo(opts.logo) : null, out: parseOut(opts.out), fx, title, duration,
    logoInput: 3, ...(await probeSize(path.join(jd, path.basename(src)))), shift,
    srt: opts.burn ? burnSrt(jd, sub, preview ? "burn_preview.srt" : "burn.srt") : undefined,
  });
  return { inputs: logo ? ["-loop", "1", "-i", logo] : [], filter };
}

async function mux(jd: string, src: string, opts: Opts, duration: number, report: Report) {
  const { inputs, filter } = await look(jd, src, opts, duration);
  report("mux", 0, filter ? "Making the picture (subtitles, effects, format)" : "Building final video");
  const ffmpeg = tool("ffmpeg");
  const base = ["-y", "-v", "error", "-i", path.basename(src), "-i", "dub_audio.m4a", "-i", "km.srt", ...inputs];
  const streams = ["-map", "1:a:0", "-map", "2:0"];
  // fading to black fades the sound too, which means encoding it again (it is copied otherwise)
  const audio = parseFx(opts.fx).fade && duration > 2
    ? ["-af", `afade=t=in:d=0.6,afade=t=out:st=${(duration - 0.6).toFixed(3)}:d=0.6`, "-c:a", "aac", "-b:a", "192k"]
    : ["-c:a", "copy"];
  const tail = [...audio, "-c:s", "mov_text", "-metadata:s:s:0", "language=khm",
    "-metadata:s:a:0", "language=khm", "-movflags", "+faststart", "output.mp4"];
  // no -shortest: it also counts the subtitle track and would cut the video after the last line
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(CRF[parseOut(opts.out).quality]),
    "-pix_fmt", "yuv420p"];
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
  await mux(jd, path.join(jd, meta.input), opts, meta.duration, report);
}

/** One frame at `t` seconds with the subtitles and logo exactly as the video will show them (PNG). */
export async function previewFrame(jd: string, opts: Opts, meta: Meta, t: number): Promise<Buffer> {
  const src = path.join(jd, meta.input);
  const { inputs, filter } = await look(jd, src, { ...opts, burn: true }, meta.duration, t, true);
  return run(tool("ffmpeg"), ["-v", "error", "-ss", t.toFixed(3), "-i", path.basename(src),
    "-f", "lavfi", "-i", "anullsrc", "-f", "lavfi", "-i", "anullsrc", ...inputs,
    "-filter_complex", filter!, "-map", "[v]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], { cwd: jd });
}

/** Makes the voices and the layers; returns a warning when some lines could not be voiced. */
export async function dub(jd: string, opts: Opts, meta: Meta, report: Report): Promise<string | undefined> {
  const segs = loadSegments(jd);
  if (segs.some((s) => !s.voice) && fs.existsSync(path.join(jd, "audio16k.wav"))) { // jobs from before analysis
    analyzeSpeakers(jd, segs, report);
    saveSegments(jd, segs);
  }
  if (opts.voice === "clone" && (segs.some((s) => s.speaker === undefined) || !fs.existsSync(speakerSample(jd, 0)))) {
    await assignSpeakers(jd, segs, meta, report); // switched to cloning after the transcription
    saveSegments(jd, segs);
  }
  const ttsDir = path.join(jd, "tts");
  const failed = await ttsAll(segs, opts, meta.duration, ttsDir, report);
  if (opts.voice === "clone") {
    // a line already spoken in the same person's voice from the same Khmer line is kept
    const vcKey = (i: number, ref: string) => {
      const k = path.join(ttsDir, `${i}.key`);
      return JSON.stringify([fs.existsSync(k) ? fs.readFileSync(k, "utf8") : "", ref, fs.existsSync(ref) ? fs.statSync(ref).mtimeMs : 0]);
    };
    const items = segs.map((s, i) => {
      const ref = speakerSample(jd, s.speaker ?? 0);
      return { i, src: path.join(ttsDir, `${i}.mp3`), ref, out: path.join(ttsDir, `${i}.vc.wav`), key: vcKey(i, ref) };
    }).filter((x) => fs.existsSync(x.src) && fs.existsSync(x.ref)).filter((x) => {
      const kf = path.join(ttsDir, `${x.i}.vckey`);
      return !(fs.existsSync(x.out) && fs.existsSync(kf) && fs.readFileSync(kf, "utf8") === x.key);
    });
    report("clone", 0, `Speaking in the original voices 0/${items.length}`);
    await convertVoices(jd, items.map(({ src, ref, out }) => ({ src, ref, out })), (f) =>
      report("clone", f, `Speaking in the original voices ${Math.round(f * items.length)}/${items.length}`));
    for (const x of items) if (fs.existsSync(x.out)) fs.writeFileSync(path.join(ttsDir, `${x.i}.vckey`), x.key, "utf8");
  }
  await layers(jd, segs, opts, meta, report);
  if (failed.length) {
    return `No Khmer voice for line${failed.length > 1 ? "s" : ""} ${failed.map((i) => i + 1).join(", ")} `
      + "(no internet, or nothing to say in it) - edit it or try Update voices again";
  }
}

/**
 * The separate layers the editor previews live: the Khmer voice track, subtitles timed to it and, when asked for,
 * the original voices apart from the music. Nothing is merged here - that is export's job.
 */
async function layers(jd: string, segs: Segment[], opts: Opts, meta: Meta, report: Report): Promise<Clip[]> {
  const src = path.join(jd, meta.input);
  if (wantsStems(opts)) await separateVoices(jd, meta, report); // done once per video, then kept
  const clips = await placeClips(segs, path.join(jd, "tts"), meta.duration, opts.match !== false, opts.voice === "clone", report);
  await writeVoiceTrack(jd, clips, meta.duration);
  writeSubs(jd, timedSubs(segs, clips, meta.duration));
  return clips;
}

/**
 * Whether the original voices are to be handled apart from the music (removed or at their own level). Without the
 * voice tools they can't be separated: the original sound is then only lowered under the Khmer.
 */
const wantsStems = (opts: Opts) => parseMix(opts.mix).split && opts.bgMode === "duck" && cloneAvailable();

/** Splits the original sound into voices and music & effects (vocals.wav, background.wav); kept once made. */
export async function separateVoices(jd: string, meta: Meta, report: Report) {
  if (!cloneAvailable()) throw new Error("Separating voices from music needs the voice tools - run: npm run setup");
  report("separate", 0, "Separating voices from music");
  await separate(jd, path.join(jd, meta.input), meta.duration,
    (f) => report("separate", f, `Separating voices from music ${Math.round(f * 100)}%`));
}

/** Export: merge every layer, with the settings chosen in the editor, into one video. */
export async function remix(jd: string, opts: Opts, meta: Meta, report: Report) {
  if (!fs.existsSync(path.join(jd, "tts"))) throw new Error("Generate the Khmer voice first");
  await finish(jd, loadSegments(jd), opts, meta, report);
}

async function finish(jd: string, segs: Segment[], opts: Opts, meta: Meta, report: Report) {
  const src = path.join(jd, meta.input);
  const clips = await layers(jd, segs, opts, meta, report);
  await mix(jd, src, segs, clips, meta.duration, opts, report);
  await mux(jd, src, opts, meta.duration, report);
}

/** Khmer subtitles follow the dubbed speech, held until the original line ends. */
function timedSubs(segs: Segment[], clips: Clip[], duration: number): Sub[] {

  const placed = new Map<number, [number, number]>(clips.map((c) => [c.i, [c.pos / SR, (c.pos + c.len) / SR]]));
  return segs.map((s, i) => {
    const [a, b] = placed.get(i) ?? [s.start, s.start];
    let nxt = duration;
    for (let j = i + 1; j < segs.length; j++) {
      const p = placed.get(j);
      if (p) { nxt = p[0]; break; }
    }
    return [a, Math.min(Math.max(b, s.end, a + 1), Math.max(nxt - 0.02, b)), s.km, s.text];
  });
}
