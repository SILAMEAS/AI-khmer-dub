/**
 * Subtitles the video already has (English or Chinese), used instead of listening with Whisper: a subtitle track
 * inside the file (mkv / mp4), or the uploader's own subtitles on the video site (YouTube, Bilibili...).
 * Burned-in subtitles (part of the picture) are not read.
 */
import { fs, fsp, path } from "./rt";
import { run, tool } from "./tools";
import { CAPTIONS_DIR } from "./download";

export type Cue = { start: number; end: number; text: string };
export type Captions = { lines: Cue[]; language: "en" | "zh"; from: string };

const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);
const MIN_CUES = 5; // fewer is a sign or a title card, not the dialogue

/** "00:01:02,345", "01:02.345" or "1:02:03.4" -> seconds. */
function seconds(t: string): number {
  const p = t.trim().replace(",", ".").split(":").map(Number);
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

/** One line of text without styling, sound tags ([Music], (laughs), ♪) or speaker dashes. */
function clean(t: string): string {
  return t
    .replace(/\{\\[^}]*\}/g, "")        // ASS tags
    .replace(/<[^>]+>/g, "")            // <i>, <font>, <c.colorE5E5E5>, VTT timestamps
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[\[(（【][^\])）】]*[\])）】]/g, "") // sound tags
    .replace(/♪/g, "")
    .replace(/^\s*[-–]\s*/, "")        // "- line" when two people speak in one cue
    .trim();
}

/** SRT or WebVTT text -> cues in time order; repeated cues (rolling captions) are merged. */
export function parseSubs(raw: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of raw.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const rows = block.split("\n");
    const at = rows.findIndex((r) => r.includes("-->"));
    if (at < 0) continue;
    const m = rows[at].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const start = seconds(m[1]), end = seconds(m[2]);
    const parts = rows.slice(at + 1).map(clean).filter(Boolean);
    if (!parts.length || !(end > start)) continue;
    // Chinese lines join without a space
    const text = parts.reduce((a, b) => a + (/[　-鿿＀-￯]$/.test(a) ? "" : " ") + b);
    const prev = cues[cues.length - 1];
    if (prev && prev.text === text && start - prev.end < 0.5) { prev.end = Math.max(prev.end, end); continue; }
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Chinese, English or neither, from the text itself (tags on tracks are often missing or wrong). */
function detect(cues: Cue[]): "en" | "zh" | null {
  const all = cues.map((c) => c.text).join(" ");
  const letters = all.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters.length) return null;
  const cjk = (letters.match(/[㐀-鿿]/g) ?? []).length;
  const kana = (letters.match(/[぀-ヿ가-힯]/g) ?? []).length; // Japanese or Korean, not Chinese
  if (cjk / letters.length > 0.5 && kana / letters.length < 0.05) return "zh";
  const ascii = (letters.match(/[a-zA-Z]/g) ?? []).length;
  if (ascii / letters.length > 0.95 && / (the|you|to|and|is|it|I) /i.test(` ${all} `)) return "en";
  return null;
}

/** Shifted to a cut of the video (`from`..`to` seconds of the source; to = 0: until the end). */
function shift(cues: Cue[], from: number, to: number): Cue[] {
  return cues
    .filter((c) => c.end > from + 0.2 && (!to || c.start < to - 0.2))
    .map((c) => ({ start: Math.max(0, c.start - from), end: (to ? Math.min(c.end, to) : c.end) - from, text: c.text }));
}

type Found = { cues: Cue[]; language: "en" | "zh"; from: string };

/** Subtitle tracks inside the video file. */
async function embedded(file: string, jd: string): Promise<Found[]> {
  const out = await run(tool("ffprobe"), ["-v", "error", "-select_streams", "s", "-show_entries",
    "stream=index,codec_name:stream_tags=language:stream_disposition=forced,hearing_impaired", "-of", "json", file]);
  const streams: { index: number; codec_name?: string; tags?: { language?: string }; disposition?: { forced?: number } }[] =
    JSON.parse(out.toString("utf8")).streams ?? [];
  const found: Found[] = [];
  const text = streams.filter((s) => TEXT_CODECS.has(s.codec_name ?? "") && !s.disposition?.forced);
  const srt = (s: { index: number }) => path.join(jd, `captions_${s.index}.srt`);
  const extract = (list: typeof text) => run(tool("ffmpeg"), ["-y", "-v", "error", "-i", file,
    ...list.flatMap((s) => ["-map", `0:${s.index}`, "-f", "srt", srt(s)])]);
  // every track in one read of the file (a 4 GB film with 15 tracks was read 15 times); should one of them not
  // convert, each on its own as before, so the others are still used
  let together = false;
  if (text.length > 1) together = await extract(text).then(() => true, (e) => { console.error(e); return false; });
  for (const s of text) {
    try {
      if (!together) await extract([s]);
      const cues = parseSubs(await fsp.readFile(srt(s), "utf8"));
      const language = detect(cues);
      if (language) found.push({ cues, language, from: `the video's ${language === "zh" ? "Chinese" : "English"} subtitle track` });
    } catch (e) { console.error(e); } finally { await fsp.rm(srt(s), { force: true }); }
  }
  return found;
}

/** The uploader's own subtitles on the video site, downloaded with the video (lib/download.ts). */
async function online(jd: string): Promise<Found[]> {
  const dir = path.join(jd, CAPTIONS_DIR);
  if (!fs.existsSync(dir)) return [];
  const found: Found[] = [];
  for (const n of fs.readdirSync(dir).filter((n) => /\.(srt|vtt)$/i.test(n))) {
    const cues = parseSubs(await fsp.readFile(path.join(dir, n), "utf8"));
    const language = detect(cues);
    if (language) found.push({ cues, language, from: `the ${language === "zh" ? "Chinese" : "English"} subtitles on the video page` });
  }
  return found;
}

/**
 * The best subtitles the video has: in the chosen original language when one was chosen, otherwise English
 * (it translates to Khmer best), then Chinese. null when there are none: Whisper listens instead.
 */
export async function findCaptions(file: string, jd: string, sourceLang: string,
                                   trim?: { from: number; to: number }): Promise<Captions | null> {
  const found = [...await embedded(file, jd).catch(() => []), ...await online(jd)]
    .map((f) => ({ ...f, cues: trim ? shift(f.cues, trim.from, trim.to) : f.cues }))
    .filter((f) => f.cues.length >= MIN_CUES);
  if (sourceLang === "en" || sourceLang === "zh") {
    const pick = found.filter((f) => f.language === sourceLang).sort((a, b) => b.cues.length - a.cues.length)[0];
    return pick ? { lines: pick.cues, language: pick.language, from: pick.from } : null;
  }
  const rank = (f: Found) => (f.language === "en" ? 0 : 1);
  const pick = found.sort((a, b) => rank(a) - rank(b) || b.cues.length - a.cues.length)[0];
  return pick ? { lines: pick.cues, language: pick.language, from: pick.from } : null;
}
