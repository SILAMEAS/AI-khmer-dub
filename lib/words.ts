/**
 * Karaoke subtitles: a line cut into words, each with the moment it is said. The Khmer voice gives no word
 * timings, so a line's time is shared out by how long each word is to say (its letters) - close enough to follow
 * the voice. Khmer writes no spaces between words; Intl.Segmenter knows its words. Shared by the server and the
 * editor (no Node imports here).
 */

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter("km", { granularity: "word" }) : null;

/** The line's words; joined together they give the line back (spaces and punctuation stay with the word before). */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  const pieces = segmenter ? [...segmenter.segment(text)] : text.split(/(\s+)/).map((segment) => ({ segment, isWordLike: !/^\s*$/.test(segment) }));
  for (const p of pieces) {
    if (p.isWordLike || !out.length) out.push(p.segment);
    else out[out.length - 1] += p.segment;
  }
  // very short pieces (a single letter) are joined to the next, so the highlight does not flicker
  const merged: string[] = [];
  for (const w of out) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && weight(prev) < 2) merged[merged.length - 1] = prev + w;
    else merged.push(w);
  }
  return merged;
}

/** How long a word takes to say, roughly: its letters without spaces, punctuation and Khmer signs. */
function weight(w: string): number {
  return Math.max(1, [...w.replace(/[\s.,!?។៕៖ៗ"'“”()\-–—]/g, "").replace(/[ា-៓៝]/g, "")].length);
}

export type TimedWord = { text: string; from: number; to: number };

/** Words of a line said from `from` to `to` (seconds). */
export function timeWords(text: string, from: number, to: number): TimedWord[] {
  const words = splitWords(text.trim());
  const total = words.reduce((s, w) => s + weight(w), 0);
  let at = from;
  return words.map((w) => {
    const len = ((to - from) * weight(w)) / total;
    const word = { text: w, from: at, to: at + len };
    at += len;
    return word;
  });
}
