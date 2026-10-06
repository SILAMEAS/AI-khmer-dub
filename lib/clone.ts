/**
 * Bridge to the Python voice-cloning worker (scripts/voice_clone.py), installed by: npm run setup -- --clone
 * Separates voices from music, finds who speaks each line, and re-speaks the Khmer lines in those voices.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ROOT, run, tool } from "./tools";

const PY_DIR = path.join(ROOT, "py");
const PYTHON = path.join(PY_DIR, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const SCRIPT = path.join(ROOT, "scripts", "voice_clone.py");

export const cloneAvailable = () =>
  fs.existsSync(PYTHON) && fs.existsSync(path.join(PY_DIR, "src", "seed-vc")) && fs.existsSync(SCRIPT);

/** Runs one worker command; `onProgress` gets 0..1. Request and result travel as JSON files in the job folder. */
async function worker<T>(cmd: string, jd: string, req: object, onProgress: (frac: number) => void): Promise<T> {
  if (!cloneAvailable()) throw new Error("Voice cloning is not installed - run: npm run setup -- --clone");
  const reqFile = path.join(jd, `clone_${cmd}.json`), resFile = path.join(jd, `clone_${cmd}.result.json`);
  await fsp.writeFile(reqFile, JSON.stringify(req), "utf8");
  await fsp.rm(resFile, { force: true });
  const tmp = path.join(PY_DIR, "tmp"); // keep big temp files next to the models, not on the system drive
  await fsp.mkdir(tmp, { recursive: true });
  await run(PYTHON, ["-u", SCRIPT, cmd, reqFile, resFile], {
    env: { ...process.env, TMP: tmp, TEMP: tmp, PYTHONIOENCODING: "utf-8" },
    onLine: (l) => {
      const m = l.match(/^PROGRESS (\d+) (\d+)/);
      if (m && +m[2] > 0) onProgress(+m[1] / +m[2]);
    },
  });
  const res = JSON.parse(await fsp.readFile(resFile, "utf8")) as T;
  await fsp.rm(reqFile, { force: true });
  await fsp.rm(resFile, { force: true });
  return res;
}

export const VOCALS = "vocals.wav", BACKGROUND = "background.wav", VOICES_DIR = "voices";

/** Voices and music/effects as separate tracks (for clean voice samples and a dub without the old voices). */
export async function separate(jd: string, input: string, duration: number, onProgress: (f: number) => void) {
  if (fs.existsSync(path.join(jd, VOCALS)) && fs.existsSync(path.join(jd, BACKGROUND))) return;
  try {
    await worker("separate", jd, {
      input, duration, ffmpeg: tool("ffmpeg"),
      vocals: path.join(jd, VOCALS), background: path.join(jd, BACKGROUND),
    }, onProgress);
  } catch (e) { // a half-written pair must not count as done
    await fsp.rm(path.join(jd, VOCALS), { force: true });
    await fsp.rm(path.join(jd, BACKGROUND), { force: true });
    throw e;
  }
}

/** A stretch of a line said by one person (`line` indexes the lines passed in; times in seconds). */
export type Piece = { line: number; start: number; end: number; speaker: number };

/**
 * Who says each line, split where another person cuts in, plus a voice sample per speaker
 * in jobs/<id>/voices/speaker_<n+1>.wav.
 */
export async function findSpeakers(jd: string, lines: { start: number; end: number }[],
                                   onProgress: (f: number) => void): Promise<Piece[]> {
  const out = path.join(jd, VOICES_DIR);
  await fsp.rm(out, { recursive: true, force: true });
  const res = await worker<{ pieces: Piece[] }>("speakers", jd, {
    vocals: path.join(jd, VOCALS), out_dir: out,
    // a little margin: whisper's timestamps often clip the first and last syllable
    lines: lines.map((l) => ({ start: Math.max(0, l.start - 0.1), end: l.end + 0.1 })),
  }, onProgress);
  return res.pieces;
}

export const speakerSample = (jd: string, speaker: number) => path.join(jd, VOICES_DIR, `speaker_${speaker + 1}.wav`);

/** Re-speaks each line (`src`) in the voice of its speaker sample (`ref`), writing `out`. */
export async function convertVoices(jd: string, items: { src: string; ref: string; out: string }[],
                                    onProgress: (f: number) => void) {
  if (!items.length) return;
  // 10 steps with a 6 s sample: best likeness per second of CPU in our tests (~9 s per line on a 12-core CPU)
  await worker("convert", jd, { steps: 10, ref_seconds: 6, items }, onProgress);
}
