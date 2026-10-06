// Installs everything the app needs, in one go. Safe to run again: finished steps are skipped.
//
//   npm run setup                  everything, incl. voice cloning ("original voices")
//   npm run setup -- --no-clone    skip voice cloning (saves ~5 GB and the Python install)
//   npm run setup -- --all         also the medium + small Whisper models
//   npm run setup -- --no-build    don't build the app at the end
//
// Large files stay inside this folder (bin/, models/, py/), on whatever drive the project is on.
// Missing programs (ffmpeg, Python) are installed with winget.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin");
const models = path.join(root, "models");
const args = process.argv.slice(2);
const wantClone = !args.includes("--no-clone");
const win = process.platform === "win32";

let stepNo = 0;
const TOTAL = wantClone ? 7 : 5;
const step = (title) => console.log(`\n[${++stepNo}/${TOTAL}] ${title}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

// ---------------------------------------------------------------- helpers

async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return ok(`${label} already present`);
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "khmer-dubber" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, last = 0;
  const tmp = dest + ".part";
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= last + 10) { last = pct; console.log(`    ${label} ${pct}%`); }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  ok(label);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

// Windows' own bsdtar unpacks zips; Git's GNU tar (often first on PATH) cannot.
function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(fs.existsSync(winTar) ? winTar : "tar", ["-xf", zip, "-C", dest]);
}

/** Runs a program; returns its trimmed output, or null if it is missing or fails. */
function tryRun(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch { return null; }
}

function winget(id, label, extra = []) {
  if (!win || tryRun("winget", ["--version"]) === null) {
    fail(`${label} is missing and winget is not available. Install ${label} yourself, then run npm run setup again.`);
  }
  console.log(`  Installing ${label} with winget (a Windows prompt may appear)...`);
  execFileSync("winget", ["install", "-e", "--id", id, ...extra, "--silent",
    "--accept-source-agreements", "--accept-package-agreements"], { stdio: "inherit" });
}

// ---------------------------------------------------------------- 1. checks + node packages

step("Checking this PC and installing Node packages");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 9)) fail(`Node.js 20.9 or newer is needed (this is ${process.version}). Get it from https://nodejs.org`);
ok(`Node.js ${process.version}`);
try {
  const s = fs.statfsSync(root);
  const freeGb = (s.bavail * s.bsize) / 1e9;
  const needGb = wantClone ? 9 : 3;
  const drive = path.parse(root).root;
  if (freeGb < needGb) console.warn(`  ! Only ${freeGb.toFixed(1)} GB free on ${drive} - about ${needGb} GB is needed`);
  else ok(`${freeGb.toFixed(0)} GB free on ${drive} (everything is installed inside ${root})`);
} catch { /* statfs is not available everywhere */ }
if (!fs.existsSync(path.join(root, "node_modules", "next"))) {
  execSync("npm install", { cwd: root, stdio: "inherit" });
}
ok("Node packages");

// ---------------------------------------------------------------- 2. ffmpeg

step("ffmpeg (audio and video processing)");
function findFfmpeg() {
  const exe = win ? "ffmpeg.exe" : "ffmpeg";
  const dirs = [bin, ...(process.env.PATH || process.env.Path || "").split(path.delimiter)];
  const wingetDir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(wingetDir)) {
    for (const pkg of fs.readdirSync(wingetDir).filter((d) => d.startsWith("Gyan.FFmpeg"))) {
      for (const build of fs.readdirSync(path.join(wingetDir, pkg))) dirs.push(path.join(wingetDir, pkg, build, "bin"));
    }
  }
  return dirs.map((d) => d && path.join(d, exe)).find((p) => p && fs.existsSync(p)) || null;
}
let ffmpeg = findFfmpeg();
if (!ffmpeg) {
  winget("Gyan.FFmpeg", "ffmpeg");
  ffmpeg = findFfmpeg();
  if (!ffmpeg) fail("ffmpeg was installed but not found - open a new terminal and run npm run setup again.");
}
ok(`ffmpeg: ${ffmpeg}`);
const filters = tryRun(ffmpeg, ["-hide_banner", "-filters"]) || "";
if (!/\srubberband\s/.test(filters)) {
  console.log("  (this ffmpeg has no rubberband filter: long lines are sped up with atempo instead - works, slightly less smooth)");
}

// ---------------------------------------------------------------- 3. whisper.cpp + yt-dlp

step("Speech recognition (whisper.cpp) and video downloader (yt-dlp)");
fs.mkdirSync(bin, { recursive: true });
const whisperDir = path.join(bin, "whisper");
if (!fs.existsSync(whisperDir) || !findFile(whisperDir, "whisper-cli.exe")) {
  // The newest release sometimes has no binaries yet: take the newest one that does.
  const releases = await (await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10",
    { headers: { "User-Agent": "khmer-dubber" } })).json();
  const rel = releases.find((r) => r.assets?.some((a) => a.name === "whisper-bin-x64.zip"));
  if (!rel) throw new Error("Could not find whisper-bin-x64.zip in recent whisper.cpp releases");
  const asset = rel.assets.find((a) => a.name === "whisper-bin-x64.zip");
  const zip = path.join(bin, "whisper.zip");
  await download(asset.browser_download_url, zip, `whisper.cpp ${rel.tag_name}`);
  unzip(zip, whisperDir);
  fs.unlinkSync(zip);
} else ok("whisper.cpp already present");
await download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", path.join(bin, "yt-dlp.exe"), "yt-dlp");

// ---------------------------------------------------------------- 4. whisper models

step("Speech recognition models");
fs.mkdirSync(models, { recursive: true });
const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODELS = { best: "ggml-large-v3-turbo-q5_0.bin", balanced: "ggml-medium-q5_0.bin", fast: "ggml-small-q5_1.bin" };
await download("https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
  path.join(models, "ggml-silero-v5.1.2.bin"), "VAD model (skips music and silence)");
for (const m of args.includes("--all") ? Object.values(MODELS) : [MODELS.best]) {
  await download(`${HF}/${m}`, path.join(models, m), m);
}

// ---------------------------------------------------------------- 5-6. voice cloning

if (wantClone) {
  step("Python for voice cloning");
  const py = path.join(root, "py");
  const tmp = path.join(py, "tmp"); // big temp files go here, not on the system drive
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMP: tmp, TEMP: tmp, PIP_CACHE_DIR: path.join(py, "cache", "pip"),
    HF_HOME: path.join(models, "hf"), TORCH_HOME: path.join(models, "torch"), PYTHONIOENCODING: "utf-8",
    PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  const sh = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: "inherit", env });
  const venvPy = path.join(py, "venv", win ? "Scripts/python.exe" : "bin/python");

  /** A Python 3.11 or 3.12 on this PC (the versions the pinned packages were tested with). */
  function findPython() {
    const ask = "import sys; print(sys.executable); print('%d.%d' % sys.version_info[:2])";
    const tries = [
      ...(process.env.PYTHON ? [[process.env.PYTHON, []]] : []),
      ["py", ["-3.12"]], ["py", ["-3.11"]], ["python", []], ["python3", []],
      ...["Python312", "Python311"].map((v) => [path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", v, "python.exe"), []]),
    ];
    for (const [cmd, pre] of tries) {
      const out = tryRun(cmd, [...pre, "-c", ask]);
      if (!out) continue;
      const [exe, ver] = out.split(/\r?\n/);
      if (["3.11", "3.12"].includes(ver)) return exe;
    }
    return null;
  }

  // a venv whose base Python was uninstalled no longer starts: build a new one
  if (fs.existsSync(venvPy) && tryRun(venvPy, ["-c", "print(1)"]) !== "1") {
    console.log("  The Python environment is broken (its Python was removed) - rebuilding it");
    fs.rmSync(path.join(py, "venv"), { recursive: true, force: true });
  }
  if (!fs.existsSync(venvPy)) {
    let base = findPython();
    if (!base) {
      winget("Python.Python.3.12", "Python 3.12", ["--scope", "user"]);
      base = findPython();
      if (!base) fail("Python 3.12 was installed but not found - open a new terminal and run npm run setup again.");
    }
    ok(`Python: ${base}`);
    sh(base, ["-m", "venv", path.join(py, "venv")]);
  }
  ok("Python environment in ./py/venv");

  step("Voice cloning packages and models (~5 GB, takes a while the first time)");
  const pip = (...a) => sh(venvPy, ["-m", "pip", "install", "--quiet", ...a]);
  pip("--upgrade", "pip");
  // versions this app was tested with
  console.log("  PyTorch (CPU)...");
  pip("torch==2.14.1", "torchaudio==2.11.0", "--index-url", "https://download.pytorch.org/whl/cpu");
  console.log("  Voice separation and cloning packages...");
  pip("numpy==2.5.3", "scipy==1.18.1", "librosa==1.0.0", "soundfile==0.14.0", "munch==4.0.0", "einops==0.8.2",
    "transformers==4.57.6", "huggingface_hub==0.36.2", "pyyaml==6.0.3", "matplotlib==3.11.2", "demucs==4.1.0");
  ok("Python packages");

  // Seed-VC (zero-shot voice conversion) source, pinned to the tested commit; a zip, so git is not needed
  const SEED_VC_COMMIT = "51383efd921027683c89e5348211d93ff12ac2a8";
  const seedVc = path.join(py, "src", "seed-vc");
  if (!fs.existsSync(path.join(seedVc, "inference.py"))) {
    const zip = path.join(tmp, "seed-vc.zip");
    await download(`https://codeload.github.com/Plachtaa/seed-vc/zip/${SEED_VC_COMMIT}`, zip, "Seed-VC download");
    const out = path.join(py, "src");
    fs.rmSync(seedVc, { recursive: true, force: true });
    unzip(zip, out);
    fs.renameSync(path.join(out, `seed-vc-${SEED_VC_COMMIT}`), seedVc);
    fs.unlinkSync(zip);
  }
  ok("Seed-VC source");
  console.log("  Voice models (Demucs, Seed-VC, Whisper-small, BigVGAN)...");
  sh(venvPy, [path.join(root, "scripts", "voice_clone.py"), "download", "-", "-"]);
  ok("voice cloning ready");
}

// ---------------------------------------------------------------- 7. build

step("Building the app");
if (args.includes("--no-build")) ok("skipped (--no-build)");
else {
  execSync("npm run build", { cwd: root, stdio: "inherit" });
  ok("built");
}

console.log(`
Setup complete.
  Start the app:  .\\start.ps1   (or: npm start)  ->  http://127.0.0.1:5000
${wantClone ? "" : "  Voice cloning was skipped; add it later with: npm run setup\n"}`);
