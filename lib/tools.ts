import { spawn } from "node:child_process";
import { fs, path } from "./rt";

export const ROOT = process.cwd();
export const BIN = path.join(ROOT, "bin");
export const MODELS_DIR = path.join(ROOT, "models");
export const JOBS_DIR = path.join(ROOT, "jobs");
export const SR = 44100;

function findExe(name: string): string {
  const exe = name + (process.platform === "win32" ? ".exe" : "");
  const candidates = [path.join(BIN, exe)];
  for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  // winget installs ffmpeg here but the PATH change only reaches newly opened shells
  const winget = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(winget)) {
    for (const pkg of fs.readdirSync(winget).filter((d) => d.startsWith("Gyan.FFmpeg"))) {
      for (const build of fs.readdirSync(path.join(winget, pkg))) {
        candidates.push(path.join(winget, pkg, build, "bin", exe));
      }
    }
  }
  const hit = candidates.find((c) => fs.existsSync(c));
  if (!hit) throw new Error(`${name} not found. Install it (winget install Gyan.FFmpeg) or put ${exe} in ./bin`);
  return hit;
}

let cache: Record<string, string> = {};
export function tool(name: "ffmpeg" | "ffprobe" | "yt-dlp" | "whisper-cli"): string {
  if (cache[name]) return cache[name];
  if (name === "whisper-cli") {
    const p = path.join(BIN, "whisper", "Release", "whisper-cli.exe");
    if (!fs.existsSync(p)) throw new Error("whisper.cpp not found - run: npm run setup");
    return (cache[name] = p);
  }
  return (cache[name] = findExe(name));
}

/**
 * idleTimeout: stop the program when it prints nothing for this many ms (e.g. a download stuck on a blocked network).
 * signal: stop it on request (e.g. a download whose addresses expired: retrying them is no use).
 */
type RunOpts = {
  cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; idleTimeout?: number; signal?: AbortSignal;
};

/** Run a program; resolves with stdout. Rejects with the tail of stderr on failure. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    let partial = "";
    const lines = (chunk: Buffer) => {
      if (!opts.onLine) return;
      partial += chunk.toString("utf8");
      const parts = partial.split(/\r?\n|\r/);
      partial = parts.pop() ?? "";
      parts.forEach((l) => l && opts.onLine!(l));
    };
    let idle: ReturnType<typeof setTimeout> | undefined, stalled = false;
    // the whole tree: yt-dlp.exe, for one, runs its work in a second process
    const stop = () => {
      if (process.platform === "win32" && p.pid) spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
      else p.kill();
    };
    const alive = () => {
      if (!opts.idleTimeout) return;
      clearTimeout(idle);
      idle = setTimeout(() => { stalled = true; stop(); }, opts.idleTimeout);
    };
    alive();
    const onAbort = () => stop();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    p.stdout.on("data", (c: Buffer) => { out.push(c); lines(c); alive(); });
    p.stderr.on("data", (c: Buffer) => { err = (err + c.toString("utf8")).slice(-4000); lines(c); alive(); });
    p.on("error", (e) => { clearTimeout(idle); reject(e); });
    p.on("close", (code) => {
      clearTimeout(idle);
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) reject(new Error(`${path.basename(cmd)} stopped: ${String(opts.signal.reason ?? "")}\n${err.slice(-1500)}`));
      else if (stalled) {
        reject(new Error(`${path.basename(cmd)} timed out: no response for ${Math.round(opts.idleTimeout! / 1000)} s\n${err.slice(-1500)}`));
      } else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(cmd)} failed (code ${code}):\n${err.slice(-1500)}`));
    });
  });
}

/** Width and height of the first video stream. */
export async function probeSize(file: string): Promise<{ width: number; height: number }> {
  const out = await run(tool("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height", "-of", "csv=p=0:s=x", file]);
  const [width, height] = out.toString().trim().split("x").map(Number);
  return { width: width || 1280, height: height || 720 };
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(tool("ffprobe"), ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", file]);
  const d = parseFloat(out.toString());
  if (!Number.isFinite(d)) throw new Error("Cannot read the video duration");
  return d;
}

let filters: Promise<string> | undefined;
/** Whether this ffmpeg build has an audio filter (builds differ, e.g. rubberband is optional). */
export async function hasFilter(name: string): Promise<boolean> {
  filters ??= run(tool("ffmpeg"), ["-hide_banner", "-filters"]).then((b) => b.toString(), () => "");
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(await filters);
}

export async function decodeMono(file: string, af?: string): Promise<Float32Array> {
  const args = ["-v", "error", "-i", file];
  if (af) args.push("-af", af);
  args.push("-f", "f32le", "-ac", "1", "-ar", String(SR), "-");
  const buf = await run(tool("ffmpeg"), args);
  const n = Math.floor(buf.length / 4);
  const a = new Float32Array(n);
  new Uint8Array(a.buffer).set(buf.subarray(0, n * 4));
  return a;
}
