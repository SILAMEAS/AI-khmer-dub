/** Types and small helpers shared by the editor's parts. */

export type Voice = "male" | "female";
export type VoiceChoice = Voice | "auto" | "clone";
export type Segment = { start: number; end: number; text: string; km: string; f0?: number; voice?: Voice; speaker?: number };

/** pitch: semitones; bass / treble: dB; echo: none, a small room or a big hall. */
export type Tone = { pitch: number; bass: number; treble: number; echo: "none" | "room" | "hall" };
/** A stretch of the video with its own levels (%) for the original sound and the Khmer voice. */
export type Part = { from: number; to: number; orig: number; khmer: number };
/**
 * Sound mix: original sound between lines and while someone speaks (%, duck -1 = automatic), Khmer voice (dB),
 * -14 LUFS, your own music (%), voices separated from music, original voices (%), sound of both voices, parts.
 */
export type Mix = {
  music: number; duck: number; voice: number; loudnorm: boolean; bgm: number;
  split: boolean; voices: number; khmerTone: Tone; origTone: Tone; parts: Part[];
};
export const FLAT: Tone = { pitch: 0, bass: 0, treble: 0, echo: "none" };
/** By default the original voices are removed (separated from the music), the music and effects stay. */
export const DEFAULT_MIX: Mix = {
  music: 80, duck: -1, voice: 0, loudnorm: true, bgm: 0, split: true, voices: 0, khmerTone: FLAT, origTone: FLAT, parts: [],
};
/** A mix saved earlier (or sent by the server), completed with defaults for settings added since. */
export const fullMix = (m: Partial<Mix> | undefined): Mix => ({
  ...DEFAULT_MIX, ...m, khmerTone: { ...FLAT, ...m?.khmerTone }, origTone: { ...FLAT, ...m?.origTone }, parts: m?.parts ?? [],
});

export type Job = {
  id: string; status: "queued" | "running" | "review" | "done" | "error";
  stage: string; progress: number; message: string; error?: string; title: string; version?: number; exported?: number;
  opts: {
    url: string; voice: VoiceChoice; match?: boolean; rate: number; bgMode: "duck" | "none"; burn: boolean;
    sub?: object; logo?: object; out?: object; fx?: object; mix?: Partial<Mix>; trim?: { from: number; to: number };
  };
  meta?: { title: string; duration: number; language: string; segments: number; speakers?: number; captions?: string };
  tracks?: { voice: boolean; vocals: boolean; output: boolean };
  task?: { name: "separate"; progress: number; message: string }; // runs in the background, the editor stays usable
  taskError?: string;
};

export const clock = (t: number, tenths = false) => {
  t = Math.max(0, t);
  const f = tenths ? `.${Math.floor((t % 1) * 10)}` : "";
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}${f}`;
};

/** "1:23", "1:02:03" or "83.5" -> seconds; "" -> 0; NaN when it can't be read. */
export function parseTime(v: string): number {
  v = v.trim();
  if (!v) return 0;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(v)) return NaN;
  return v.split(":").reduce((t, part) => t * 60 + parseFloat(part), 0);
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

/** XHR upload so big movies show upload progress; the file body streams straight to disk. */
export function uploadFile(file: File, params: Record<string, string>, onPct: (p: number) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/jobs?" + new URLSearchParams({ ...params, name: file.name }));
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      const j = JSON.parse(x.responseText || "{}");
      x.status < 300 ? resolve(j) : reject(new Error(j.detail || x.statusText));
    };
    x.onerror = () => reject(new Error("Upload failed"));
    x.send(file);
  });
}

/** The line being said at `t` (index), or -1. */
export function lineAt(segs: Segment[] | null, t: number): number {
  if (!segs) return -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].start <= t && t < Math.max(segs[i].end, segs[i].start + 0.8)) return i;
    if (segs[i].start > t) break;
  }
  return -1;
}
