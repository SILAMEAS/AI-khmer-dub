/**
 * Bridge to the Python voice-cloning worker (scripts/voice_clone.py), installed by: npm run setup -- --clone
 * Separates voices from music, finds who speaks each line, and re-speaks the Khmer lines in those voices.
 */
import { fs, fsp, path } from "./rt";
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
  // without the PC's own Python settings (e.g. Anaconda's PYTHONPATH): they would load other versions of the packages
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE)$/i.test(k)) delete env[k];
  await run(PYTHON, ["-u", SCRIPT, cmd, reqFile, resFile], {
    env: { ...env, TMP: tmp, TEMP: tmp, PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1" },
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

const STEM_SR = 44100; // Demucs writes 16-bit WAV at this rate: voices mono, music & effects stereo

/**
 * Whether both tracks are there and complete. A track cut short (the app closed while separating, before files
 * were written under a temporary name) or holding only a WAV header does not count: it is made again.
 */
export function stemsReady(jd: string, duration: number) {
  const size = (f: string) => { try { return fs.statSync(path.join(jd, f)).size; } catch { return 0; } };
  const want = (channels: number) => Math.max(4096, duration * STEM_SR * 2 * channels * 0.9);
  return size(VOCALS) >= want(1) && size(BACKGROUND) >= want(2);
}

/** Voices and music/effects as separate tracks (for clean voice samples and a dub without the old voices). */
export function separate(jd: string, input: string, duration: number, onProgress: (f: number) => void): Promise<void> {
  // asked for again while it runs (the background task, then an export): wait for the same run, never two at once
  const busy = (g.__khmerSeparating ??= new Map());
  const now = busy.get(jd);
  if (now) { now.listeners.add(onProgress); return now.done; }
  const listeners = new Set([onProgress]);
  const done = separateOnce(jd, input, duration, (f) => listeners.forEach((l) => l(f))).finally(() => busy.delete(jd));
  busy.set(jd, { done, listeners });
  return done;
}
const g = globalThis as unknown as { __khmerSeparating?: Map<string, { done: Promise<void>; listeners: Set<(f: number) => void> }> };

async function separateOnce(jd: string, input: string, duration: number, onProgress: (f: number) => void) {
  if (stemsReady(jd, duration)) return;
  // written under temporary names and renamed only when complete, so an interrupted run never looks finished
  const part = (f: string) => path.join(jd, f.replace(".wav", ".part.wav"));
  try {
    await worker("separate", jd, {
      input, duration, ffmpeg: tool("ffmpeg"), vocals: part(VOCALS), background: part(BACKGROUND),
    }, onProgress);
    for (const f of [VOCALS, BACKGROUND]) {
      await fsp.rm(path.join(jd, f), { force: true });
      await fsp.rename(part(f), path.join(jd, f));
    }
    if (!stemsReady(jd, duration)) throw new Error("Separating voices from music gave too little sound - does the video have an audio track?");
  } catch (e) {
    for (const f of [VOCALS, BACKGROUND]) await fsp.rm(path.join(jd, f), { force: true });
    throw e;
  } finally {
    for (const f of [VOCALS, BACKGROUND]) await fsp.rm(part(f), { force: true });
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
  // 8 steps, 6 s voice sample, same-person lines converted together: ~4.5 s per line on a 12-core CPU,
  // as alike as 10 steps in our tests
  await worker("convert", jd, { steps: 8, ref_seconds: 6, items }, onProgress);
}
