/**
 * Bridge to the Python worker (scripts/separate.py), installed by: npm run setup (start.cmd).
 * Separates the original voices from the music and effects, so the dub can remove or lower them on their own.
 */
import { fs, fsp, path } from "./rt";
import { ROOT, run, tool } from "./tools";

const PY_DIR = path.join(ROOT, "py");
const PYTHON = path.join(PY_DIR, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const SCRIPT = path.join(ROOT, "scripts", "separate.py");

// .packages.json: written by setup only once the packages installed and load (a half-finished install has none)
export const separationAvailable = () =>
  fs.existsSync(PYTHON) && fs.existsSync(path.join(PY_DIR, "venv", ".packages.json")) && fs.existsSync(SCRIPT);

/** Runs one worker command; `onProgress` gets 0..1. Request and result travel as JSON files in the job folder. */
async function worker<T>(cmd: string, jd: string, req: object, onProgress: (frac: number) => void): Promise<T> {
  if (!separationAvailable()) {
    throw new Error("Separating voices from music is not installed - close the app and run start.cmd again (setup installs it)");
  }
  const reqFile = path.join(jd, `py_${cmd}.json`), resFile = path.join(jd, `py_${cmd}.result.json`);
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

export const VOCALS = "vocals.wav", BACKGROUND = "background.wav";

const STEM_SR = 44100; // the worker writes 16-bit WAV at this rate: voices mono, music & effects stereo

/**
 * Whether both tracks are there and complete. A track cut short (the app closed while separating, before files
 * were written under a temporary name) or holding only a WAV header does not count: it is made again.
 */
export function stemsReady(jd: string, duration: number) {
  const size = (f: string) => { try { return fs.statSync(path.join(jd, f)).size; } catch { return 0; } };
  const want = (channels: number) => Math.max(4096, duration * STEM_SR * 2 * channels * 0.9);
  return size(VOCALS) >= want(1) && size(BACKGROUND) >= want(2);
}

/** Voices and music/effects as separate tracks (for a dub without the old voices). */
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
