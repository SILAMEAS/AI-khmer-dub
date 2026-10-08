// Installs everything the app needs, in one go. Safe to run again: finished steps are skipped.
//
//   npm run setup                       everything, incl. removing the original voices from the music
//   npm run setup -- --no-separation    without it (no Python, ~3 GB less): the original voices can only be lowered
//   npm run setup -- --all              also the medium + small Whisper models
//   npm run setup -- --no-build         don't build the app at the end
//   npm run setup -- --clean            reinstall programs and packages from scratch (keeps the downloaded models)
//
// It also repairs itself: a program that no longer starts is downloaded again, a broken Node or Python
// install is rebuilt, and leftovers of interrupted runs and files the app does not use are removed.
//
// Everything stays inside this folder (bin/, models/, py/), on whatever drive the project is on - nothing is
// installed on the system drive: ffmpeg goes to bin/, a portable Python to py/python (downloaded when missing).
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin");
const models = path.join(root, "models");
const args = process.argv.slice(2);
// (--no-clone: its old name, still in .setup-done.json of installs from when the app also cloned voices)
const wantSeparation = !args.includes("--no-separation") && !args.includes("--no-clone");
// Without the PC's own Python, pip and model-folder settings (for every program setup runs): Anaconda's
// PYTHONPATH would mix other versions of the packages in (PYTHONHOME even stops the venv from starting), a
// PIP_TARGET / PIP_USER / PIP_PREFIX would install outside py/venv, and HF_HUB_CACHE & co. would put the
// models in another folder.
for (const k of Object.keys(process.env)) {
  if (/^(PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|PIP_TARGET|PIP_USER|PIP_PREFIX|PIP_REQUIRE_VIRTUALENV|HF_HUB_CACHE|HUGGINGFACE_HUB_CACHE|TRANSFORMERS_CACHE|HF_HUB_OFFLINE)$/i.test(k)) {
    delete process.env[k];
  }
}
process.env.PYTHONNOUSERSITE = "1";
const known = ["--no-separation", "--no-clone", "--all", "--no-build", "--clean"];
for (const a of args) if (!known.includes(a)) console.warn(`  ! Unknown option ${a} (known: ${known.join(" ")})`);
const win = process.platform === "win32";

let stepNo = 0;
const TOTAL = wantSeparation ? 8 : 6;
const step = (title) => console.log(`\n[${++stepNo}/${TOTAL}] ${title}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };
// a part that could not be updated (e.g. no internet) but still works: the app starts, setup runs again next time
let incomplete = false;

// One setup at a time: a second one (start.cmd opened twice during the first install) would delete the first
// one's half-finished downloads and install the same packages at the same time.
const lockFile = path.join(root, ".setup.lock");
const otherPid = fs.existsSync(lockFile) ? Number(fs.readFileSync(lockFile, "utf8")) : 0;
if (otherPid && otherPid !== process.pid) {
  let alive = true;
  try { process.kill(otherPid, 0); } catch (e) { alive = e.code === "EPERM"; } // ESRCH: that setup is gone
  if (alive) fail(`Setup is already running in another window (process ${otherPid}) - wait for it to finish.`);
}
fs.writeFileSync(lockFile, String(process.pid));
process.on("exit", () => { try { if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile); } catch { /* gone */ } });

// ---------------------------------------------------------------- helpers

// Behind a proxy (start.ps1 puts Windows' proxy in HTTPS_PROXY) Node's fetch() can't get out - it ignores
// proxies. Windows' own curl.exe follows HTTPS_PROXY, so downloads go through it then.
const proxied = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
const curlExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe");
const viaCurl = proxied && win && fs.existsSync(curlExe);
if (viaCurl) console.log(`Downloading through the proxy ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`);

/** The text at an address (JSON of the GitHub API, etc.); null when it can't be reached. */
async function getText(url, timeoutMs = 30_000) {
  if (viaCurl) {
    try {
      return execFileSync(curlExe, ["-sSL", "--fail", "-m", String(timeoutMs / 1000), "-A", "khmer-dubber", url],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 << 20 });
    } catch { return null; }
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": "khmer-dubber" }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

// A file only gets its final name once it is complete, so a file that is there is a whole one.
// A dropped connection or a cut-short file is tried again (3 times).
async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return ok(`${label} already present`);
  const tmp = dest + ".part";
  for (let attempt = 1; ; attempt++) {
    try {
      if (viaCurl) {
        console.log(`    ${label}...`);
        execFileSync(curlExe, ["-L", "--fail", "-sS", "--retry", "2", "-A", "khmer-dubber", "-o", tmp, url], { stdio: "inherit", windowsHide: true });
        fs.renameSync(tmp, dest);
        return ok(label);
      }
      const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "khmer-dubber" } });
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
      const total = Number(res.headers.get("content-length")) || 0;
      let got = 0, last = 0;
      const body = Readable.fromWeb(res.body);
      body.on("data", (c) => {
        got += c.length;
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct >= last + 10) { last = pct; console.log(`    ${label} ${pct}%`); }
      });
      await pipeline(body, fs.createWriteStream(tmp));
      if (total && fs.statSync(tmp).size !== total) throw new Error(`${label}: download was cut short`);
      fs.renameSync(tmp, dest);
      return ok(label);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (attempt >= 3) throw e;
      console.log(`    ${label}: ${e.message} - trying again (${attempt + 1}/3)`);
    }
  }
}

/** Whether a program starts and exits normally (it is there, whole, and its DLLs are found). */
function healthy(exe, cmdArgs = ["--version"]) {
  if (!fs.existsSync(exe)) return false;
  try {
    execFileSync(exe, cmdArgs, { stdio: "ignore", windowsHide: true, timeout: 60_000 });
    return true;
  } catch { return false; }
}

/** Deletes a program that no longer starts, so the step below downloads it again. */
function dropIfBroken(exe, cmdArgs, label) {
  if (fs.existsSync(exe) && !healthy(exe, cmdArgs)) {
    console.log(`  ${label} does not start - downloading it again`);
    fs.rmSync(exe, { force: true });
  }
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

// ---------------------------------------------------------------- 1. checks + node packages

step("Checking this PC and installing Node packages");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 9)) fail(`Node.js 20.9 or newer is needed (this is ${process.version}). Get it from https://nodejs.org`);
ok(`Node.js ${process.version}`);
try {
  const s = fs.statfsSync(root);
  const freeGb = (s.bavail * s.bsize) / 1e9;
  const needGb = wantSeparation ? 6 : 3;
  const drive = path.parse(root).root;
  if (freeGb < needGb) console.warn(`  ! Only ${freeGb.toFixed(1)} GB free on ${drive} - about ${needGb} GB is needed`);
  else ok(`${freeGb.toFixed(0)} GB free on ${drive} (everything is installed inside ${root})`);
} catch { /* statfs is not available everywhere */ }

// --clean: programs and packages from scratch; the big model downloads (models/) are kept
if (args.includes("--clean")) {
  console.log("  --clean: removing installed programs and packages (models are kept)");
  for (const d of ["node_modules", ".next", "bin/whisper", "py/venv", "py/cache"]) {
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  for (const n of ["ffmpeg", "ffprobe", "yt-dlp", "deno", "aria2c"]) fs.rmSync(path.join(bin, n + (win ? ".exe" : "")), { force: true });
}

// leftovers of an interrupted run: half-downloaded files, unpacked archives, temporary folders
const appRunning = await fetch("http://127.0.0.1:5000/api/capabilities", { signal: AbortSignal.timeout(1500) })
  .then(() => true, () => false);
for (const dir of [bin, models, path.join(root, "py")]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (/\.part$|-tmp$|^(ffmpeg\.(zip|7z)|whisper\.zip|deno\.zip|aria2\.zip|python\.nupkg|7zr\.exe)$/.test(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}
if (!appRunning) { // the running app may be using its temporary files
  for (const dir of [path.join(root, "tmp"), path.join(root, "py", "tmp")]) {
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}
ok("leftovers of earlier runs cleaned up");

// whisper.cpp and PyTorch are built with Microsoft's C++ compiler and need its runtime DLLs. Most PCs have them;
// a fresh Windows does not, and then speech recognition fails with "code 3221225781" (a DLL is missing).
if (win) {
  const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const vcDlls = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"];
  const vcMissing = () => vcDlls.filter((d) => !fs.existsSync(path.join(sys32, d)));
  if (vcMissing().length) {
    console.log(`  Microsoft Visual C++ runtime is missing (${vcMissing().join(", ")}) - installing it`);
    console.log("  (Windows asks for permission: click Yes)");
    const tmpDir = path.join(root, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const exe = path.join(tmpDir, "vc_redist.x64.exe");
    await download("https://aka.ms/vs/17/release/vc_redist.x64.exe", exe, "Visual C++ runtime");
    try {
      execFileSync(exe, ["/install", "/passive", "/norestart"], { stdio: "ignore" });
    } catch (e) { // 3010: installed, restart wanted; 1638: a newer one is already there
      if (![3010, 1638].includes(e.status)) console.warn(`  ! Visual C++ runtime installer ended with code ${e.status}`);
    }
    fs.rmSync(exe, { force: true });
    if (vcMissing().length) {
      fail("The Microsoft Visual C++ runtime could not be installed. Install it from "
        + "https://aka.ms/vs/17/release/vc_redist.x64.exe, then run start.cmd again.");
    }
  }
  ok("Microsoft Visual C++ runtime");
}

// Node packages: exactly those in package-lock.json (npm ci; npm install could rewrite the lock file, and git
// pull then refuses to update it). Installed again when the lock file's content changed (git pull) or when
// node_modules is broken (an interrupted install, or copied from another PC).
const lockHash = createHash("sha256").update(fs.readFileSync(path.join(root, "package-lock.json"), "utf8").replace(/\r/g, "")).digest("hex");
const lockMark = path.join(root, "node_modules", ".installed-lock");
const nextOk = () => healthy(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "--version"]);
if (!nextOk() || !fs.existsSync(lockMark) || fs.readFileSync(lockMark, "utf8") !== lockHash) {
  execSync("npm ci --prefer-offline --no-audit --no-fund", { cwd: root, stdio: "inherit" });
  if (!nextOk()) fail("The Node packages could not be installed - see the message above.");
  fs.writeFileSync(lockMark, lockHash);
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
const inBin = (name) => path.join(bin, win ? `${name}.exe` : name);
fs.mkdirSync(bin, { recursive: true });
if (!healthy(inBin("ffmpeg"), ["-version"]) || !healthy(inBin("ffprobe"), ["-version"])) {
  for (const n of ["ffmpeg", "ffprobe"]) fs.rmSync(inBin(n), { force: true }); // a broken or half copy
}
let ffmpeg = fs.existsSync(inBin("ffmpeg")) && fs.existsSync(inBin("ffprobe")) ? inBin("ffmpeg") : null;
if (!ffmpeg) {
  const elsewhere = findFfmpeg();
  // on Windows only a gyan.dev build is copied: other builds tested do not draw Khmer subtitles correctly
  const usable = elsewhere && fs.existsSync(path.join(path.dirname(elsewhere), win ? "ffprobe.exe" : "ffprobe"))
    && (!win || (tryRun(elsewhere, ["-hide_banner", "-version"]) ?? "").includes("gyan.dev"));
  if (usable) {
    // installed somewhere else (e.g. by winget on the system drive): keep a copy here
    for (const n of ["ffmpeg", "ffprobe"]) fs.copyFileSync(path.join(path.dirname(elsewhere), path.basename(inBin(n))), inBin(n));
    ok(`ffmpeg copied into ./bin (from ${path.dirname(elsewhere)})`);
  } else if (win) {
    // gyan.dev's full build, straight into ./bin: it has rubberband, and its subtitle renderer shapes Khmer
    // correctly (other builds tested draw subscript consonants and vowels out of place). The same build is on
    // GitHub as a .zip (faster, and every Windows can unpack it), pinned to the version tested with Khmer
    // subtitles - every PC gets the same one. gyan.dev's own .7z (its newest) is the fallback.
    const FFMPEG_VERSION = "9.0.2";
    const sources = [
      [`https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-full_build.zip`, ".zip"],
      ["https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z", ".7z"],
    ];
    let archive = "";
    const tmpDir = path.join(bin, "ffmpeg-tmp");
    for (const [url, ext] of sources) {
      archive = path.join(bin, "ffmpeg" + ext);
      try { await download(url, archive, `ffmpeg ${ext === ".zip" ? FFMPEG_VERSION : "(newest)"}`); break; }
      catch (e) { if (ext === ".7z") throw e; console.log(`    GitHub not reachable (${e.message}) - trying gyan.dev`); }
    }
    try {
      unzip(archive, tmpDir); // Windows' tar reads .zip (and .7z on Windows 11)
    } catch { // a .7z on older Windows: 7-Zip's own small command-line extractor
      const sevenZip = path.join(bin, "7zr.exe");
      await download("https://www.7-zip.org/a/7zr.exe", sevenZip, "7-Zip extractor");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      execFileSync(sevenZip, ["x", archive, `-o${tmpDir}`, "-y"], { stdio: "ignore", windowsHide: true });
    }
    for (const n of ["ffmpeg.exe", "ffprobe.exe"]) {
      const f = findFile(tmpDir, n);
      if (!f) fail(`${n} was not found in the ffmpeg download`);
      fs.copyFileSync(f, path.join(bin, n));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  } else {
    fail("ffmpeg is missing: install it (e.g. sudo apt install ffmpeg), then run npm run setup again.");
  }
  ffmpeg = inBin("ffmpeg");
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
const whisperCli = path.join(whisperDir, "Release", "whisper-cli.exe"); // where lib/tools.ts looks for it
if (fs.existsSync(whisperDir) && !healthy(whisperCli, ["--help"])) {
  console.log("  whisper.cpp is missing or does not start - downloading it again");
  fs.rmSync(whisperDir, { recursive: true, force: true });
}
// The build this app was tested with: every PC gets the same one (a newer one may need other files, or behave
// differently), and no GitHub API call is needed (it allows only 60 calls an hour per internet address).
const WHISPER_BUILD = "b5454";
if (!fs.existsSync(whisperCli)) {
  const rel = { tag_name: WHISPER_BUILD };
  const zip = path.join(bin, "whisper.zip");
  await download(`https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/whisper-bin-x64.zip`, zip,
    `whisper.cpp ${rel.tag_name}`);
  unzip(zip, whisperDir);
  fs.unlinkSync(zip);
  const found = findFile(whisperDir, "whisper-cli.exe"); // a release laid out differently: move it into Release/
  if (found && path.dirname(found) !== path.dirname(whisperCli)) {
    const moved = path.join(bin, "whisper-moving");
    fs.renameSync(path.dirname(found), moved);
    fs.rmSync(whisperDir, { recursive: true, force: true });
    fs.mkdirSync(whisperDir);
    fs.renameSync(moved, path.dirname(whisperCli));
  }
  if (!healthy(whisperCli, ["--help"])) fail(`whisper.cpp ${rel.tag_name} does not start on this PC (${whisperCli})`);
  ok(`whisper.cpp ${rel.tag_name}`);
} else ok("whisper.cpp already present");
// The download also has demos, tests, a chat program and other speech models (~40 files): only the two programs
// the app runs (lib/pipeline.ts) and the libraries they load are kept. (ggml-cpu-*.dll: one per CPU generation,
// the fitting one is picked at start.)
for (const d of fs.readdirSync(whisperDir)) {
  if (d !== "Release") fs.rmSync(path.join(whisperDir, d), { recursive: true, force: true });
}
for (const f of fs.readdirSync(path.dirname(whisperCli))) {
  if (!/^(whisper-cli\.exe|whisper-vad-speech-segments\.exe|whisper\.dll|ggml[\w-]*\.dll)$/i.test(f)) fs.rmSync(path.join(path.dirname(whisperCli), f), { recursive: true, force: true });
}
// still starting without the removed files? (otherwise the next run downloads it whole again)
if (!healthy(whisperCli, ["--help"])) {
  fs.rmSync(whisperDir, { recursive: true, force: true });
  fail("whisper.cpp needs a file that was removed - run start.cmd again (it is downloaded again).");
}
dropIfBroken(path.join(bin, "yt-dlp.exe"), ["--version"], "yt-dlp");
dropIfBroken(path.join(bin, "deno.exe"), ["--version"], "Deno");
dropIfBroken(path.join(bin, "aria2c.exe"), ["--version"], "aria2c");
await download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", path.join(bin, "yt-dlp.exe"), "yt-dlp");
// YouTube only gives its videos to a downloader that runs its JavaScript; yt-dlp needs Deno for that
// (the Node.js running this app is often too old for it). Without it: 480p at most, or "not a bot" errors.
if (!fs.existsSync(path.join(bin, "deno.exe"))) {
  const zip = path.join(bin, "deno.zip");
  await download("https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip", zip, "Deno (for YouTube)");
  unzip(zip, bin);
  fs.unlinkSync(zip);
} else ok("Deno already present");
// aria2c: downloads each file over 8 connections - many times faster where each connection is slowed down
if (!fs.existsSync(path.join(bin, "aria2c.exe"))) {
  const zip = path.join(bin, "aria2.zip"), tmpDir = path.join(bin, "aria2-tmp");
  await download("https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip", zip, "aria2c (faster downloads)");
  unzip(zip, tmpDir);
  fs.renameSync(findFile(tmpDir, "aria2c.exe"), path.join(bin, "aria2c.exe"));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(zip);
} else ok("aria2c already present");

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

// ---------------------------------------------------------------- 5-6. removing the original voices (Python)

if (wantSeparation) {
  step("Python for removing the original voices from the music");
  const py = path.join(root, "py");
  const tmp = path.join(py, "tmp"); // big temp files go here, not on the system drive
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMP: tmp, TEMP: tmp, PIP_CACHE_DIR: path.join(py, "cache", "pip"),
    HF_HOME: path.join(models, "hf"), TORCH_HOME: path.join(models, "torch"), PYTHONIOENCODING: "utf-8",
    PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  const sh = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: "inherit", env });
  const venvPy = path.join(py, "venv", win ? "Scripts/python.exe" : "bin/python");

  /** The portable Python kept in ./py/python (3.12, the version the pinned packages were tested with). */
  const ownPython = path.join(py, "python", win ? "python.exe" : "bin/python3");
  async function portablePython() {
    if (fs.existsSync(ownPython)) return ownPython;
    if (!win) return null;
    // the "python" NuGet package is a complete Python (venv and pip included) that needs no installer
    const pkg = path.join(py, "python.nupkg"), tmpDir = path.join(py, "python-tmp");
    await download("https://www.nuget.org/api/v2/package/python/3.12.10", pkg, "Python 3.12 (portable)");
    unzip(pkg, tmpDir);
    fs.renameSync(path.join(tmpDir, "tools"), path.join(py, "python"));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(pkg, { force: true });
    return fs.existsSync(ownPython) ? ownPython : null;
  }

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

  // A venv made from a Python outside this folder (e.g. on the system drive): copy that Python into
  // ./py/python and point the venv at it, so everything lives here (the packages stay as they are).
  const cfgFile = path.join(py, "venv", "pyvenv.cfg");
  // a portable Python that does not start (half unpacked, or damaged): unpacked again below
  if (fs.existsSync(ownPython) && tryRun(ownPython, ["-c", "print(1)"]) !== "1") {
    console.log("  The portable Python does not start - downloading it again");
    fs.rmSync(path.join(py, "python"), { recursive: true, force: true });
    fs.rmSync(path.join(py, "venv"), { recursive: true, force: true });
  }
  // The project folder was moved or copied (another drive, another PC): the venv still names the old
  // folder's Python. Point it at this folder's own copy.
  if (win && fs.existsSync(cfgFile) && fs.existsSync(ownPython)) {
    const home = (fs.readFileSync(cfgFile, "utf8").match(/^home\s*=\s*(.+)$/m) ?? [])[1]?.trim();
    const own = path.dirname(ownPython);
    // compared as real paths: the same folder reached through a link (junction) is not a move
    const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return null; } };
    if (home && real(home) !== real(own)) {
      console.log(`  The project folder was moved: pointing the Python environment at ${own}`);
      fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").split(home).join(own));
    }
  }
  if (win && fs.existsSync(cfgFile) && !fs.existsSync(ownPython)) {
    const home = (fs.readFileSync(cfgFile, "utf8").match(/^home\s*=\s*(.+)$/m) ?? [])[1]?.trim();
    if (home && fs.existsSync(path.join(home, "python.exe")) && !path.resolve(home).startsWith(root)) {
      console.log(`  Moving the Python this app uses into ./py/python (from ${home})`);
      fs.cpSync(home, path.join(py, "python"), { recursive: true });
      fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").split(home).join(path.join(py, "python")));
    }
  }
  // a venv whose base Python was removed no longer starts: build a new one
  if (fs.existsSync(venvPy) && tryRun(venvPy, ["-c", "print(1)"]) !== "1") {
    console.log("  The Python environment is broken (its Python was removed) - rebuilding it");
    fs.rmSync(path.join(py, "venv"), { recursive: true, force: true });
  }
  async function makeVenv() {
    let base = process.env.PYTHON ? findPython() : await portablePython();
    if (!base) base = findPython(); // not Windows: the system's python3.11 / 3.12
    if (!base) throw new Error("Python 3.11 or 3.12 is needed - install it, or set PYTHON to its python.exe");
    ok(`Python: ${base}`);
    sh(base, ["-m", "venv", path.join(py, "venv")]);
  }
  // Removing the original voices is optional: when a part of it cannot be installed, the app still starts (the
  // original voices can then only be lowered), and setup tries again next time.
  let sepBroken = false;
  const sepFailed = (e) => {
    sepBroken = true; incomplete = true;
    console.warn(`
  ! Removing the original voices could not be installed: ${e.message ?? e}`);
    console.warn("    The app works without it (they are lowered instead). Setup tries again the next time start.cmd runs.");
  };
  try {
    if (!fs.existsSync(venvPy)) await makeVenv();
    ok("Python environment in ./py/venv");
  } catch (e) { sepFailed(e); }

  step("Voice separation packages and models (~2 GB, takes a while the first time)");
  const pip = (...a) => sh(venvPy, ["-m", "pip", "install", "--quiet", ...a]);
  // An interrupted pip leaves half-removed packages behind as "~name" folders ("Ignoring invalid distribution")
  const sitePackages = win ? path.join(py, "venv", "Lib", "site-packages") : null;
  // and two versions of one package (two "name-1.2.dist-info" folders) confuse pip and Python: the newest
  // stays, and the pinned installs below put the tested version back where it is not that one
  function removeBrokenPackages() {
    if (!sitePackages || !fs.existsSync(sitePackages)) return;
    for (const d of fs.readdirSync(sitePackages).filter((d) => d.startsWith("~"))) {
      fs.rmSync(path.join(sitePackages, d), { recursive: true, force: true });
    }
    const byName = {};
    for (const d of fs.readdirSync(sitePackages)) {
      const m = /^(.+?)-\d[^-]*\.dist-info$/i.exec(d);
      if (m) (byName[m[1].toLowerCase().replace(/[-_.]+/g, "_")] ??= []).push(d);
    }
    for (const dirs of Object.values(byName).filter((d) => d.length > 1)) {
      const newest = dirs.sort((a, b) => fs.statSync(path.join(sitePackages, b)).mtimeMs - fs.statSync(path.join(sitePackages, a)).mtimeMs)[0];
      for (const d of dirs.slice(1)) {
        console.log(`  - duplicate package ${d} (keeping ${newest})`);
        fs.rmSync(path.join(sitePackages, d), { recursive: true, force: true });
      }
    }
  }
  // versions this app was tested with (scripts/separate.py uses these; demucs brings what it needs itself)
  const PACKAGES = [
    ["PyTorch (CPU)", "torch==2.14.1", "torchaudio==2.11.0", "--index-url", "https://download.pytorch.org/whl/cpu"],
    ["Voice separation packages", "numpy==2.5.3", "soundfile==0.14.0", "demucs==4.1.0", "huggingface_hub==0.36.2",
      "einops==0.8.2", "pyyaml==6.0.3", "openvino==2026.4.1"], // openvino: separation on Intel graphics and CPUs
  ];
  // installed is not enough: they have to load (a missing DLL or a mix of versions shows up only here)
  const packagesLoad = () => tryRun(venvPy, ["-c",
    "import torch, torchaudio, numpy, soundfile, demucs.pretrained, openvino; print('ok')"]) === "ok";
  // Everything else in the environment is left from older versions of the app (voice cloning brought
  // transformers, librosa, matplotlib, ... ~1 GB): what the packages above need is followed through their
  // requirements, the rest is uninstalled.
  function removeUnusedPackages() {
    const roots = PACKAGES.flatMap(([, ...p]) => p.filter((x) => !x.startsWith("-") && !x.startsWith("http")).map((x) => x.split("==")[0]));
    const walk = [
      "import importlib.metadata as md, json, sys",
      "from pip._vendor.packaging.requirements import Requirement",
      "from pip._vendor.packaging.utils import canonicalize_name as c",
      "dists = {c(d.metadata['Name']): d for d in md.distributions() if d.metadata['Name']}",
      "need, todo = set(), [c(r) for r in json.loads(sys.argv[1])] + ['pip', 'setuptools', 'wheel']",
      "while todo:",
      "    n = todo.pop()",
      "    if n in need or n not in dists: continue",
      "    need.add(n)",
      "    for r in dists[n].requires or []:",
      "        q = Requirement(r)",
      "        if q.marker is None or q.marker.evaluate({'extra': ''}): todo.append(c(q.name))",
      "print(json.dumps(sorted(set(dists) - need)))",
    ].join("\n");
    const out = tryRun(venvPy, ["-c", walk, JSON.stringify(roots)]);
    const extra = out ? JSON.parse(out) : [];
    if (!extra.length) return;
    console.log(`  Removing ${extra.length} Python packages the app no longer uses (${extra.slice(0, 6).join(", ")}${extra.length > 6 ? ", ..." : ""})`);
    sh(venvPy, ["-m", "pip", "uninstall", "-y", "--quiet", ...extra]);
  }
  // the package list installed last time: the same list, still loading, needs no pip (fast, and works offline)
  const installedMark = path.join(py, "venv", ".packages.json"), wanted = JSON.stringify(PACKAGES);
  function installPackages() {
    removeBrokenPackages();
    try { pip("--upgrade", "pip"); } catch { console.log("  (pip could not update itself - carrying on with this one)"); }
    for (const [label, ...pkgs] of PACKAGES) { console.log(`  ${label}...`); pip(...pkgs); }
    removeUnusedPackages();
    if (!packagesLoad()) throw new Error("the Python packages are installed but do not load");
    fs.writeFileSync(installedMark, wanted);
  }
  if (sepBroken) { /* no Python environment */ }
  else if (fs.existsSync(installedMark) && fs.readFileSync(installedMark, "utf8") === wanted && packagesLoad()) {
    ok("Python packages already installed");
  } else {
    try {
      installPackages();
    } catch (e) {
      const online = (await getText("https://pypi.org/simple/pip/", 15_000)) !== null;
      if (!online) {
        // never take a working environment apart because the internet is down
        if (packagesLoad()) { console.warn("  ! No internet: the Python packages could not be updated - using the installed ones"); incomplete = true; }
        else sepFailed(new Error("no connection to pypi.org to download the Python packages (nothing was removed)"));
      } else {
        // a damaged environment (an interrupted install, packages of different versions): build it again, once
        console.log(`\n  The Python packages are broken (${e.message}) - rebuilding the Python environment from scratch`);
        fs.rmSync(path.join(py, "venv"), { recursive: true, force: true });
        try { await makeVenv(); installPackages(); } catch (e2) { sepFailed(e2); }
      }
    }
    if (!sepBroken) ok("Python packages");
  }
  if (!sepBroken) try {
    console.log("  Separation models (MDX-Net Kim Vocal 2, Demucs)...");
    sh(venvPy, [path.join(root, "scripts", "separate.py"), "download", "-", "-"]);
    // pip's copies of the downloaded packages (~0.4 GB) are not needed once they are installed
    fs.rmSync(path.join(py, "cache"), { recursive: true, force: true });
    // OpenVINO's compiled copy of the separation model (~1.6 GB, makes loading 7 s -> 0.4 s) is made for one
    // OpenVINO version: after an upgrade a new one is made beside the old one. Start it afresh then.
    const ovCache = path.join(models, "mdx", "cache"), ovMark = path.join(ovCache, ".openvino-version");
    const ovVersion = tryRun(venvPy, ["-c", "import openvino; print(openvino.__version__)"]);
    if (ovVersion && fs.existsSync(ovCache)) {
      const was = fs.existsSync(ovMark) ? fs.readFileSync(ovMark, "utf8").trim() : null;
      if (was && was !== ovVersion) { // (no mark yet: the cache was made by this version)
        console.log(`  OpenVINO changed (${was} -> ${ovVersion}): removing its old compiled models`);
        for (const f of fs.readdirSync(ovCache)) {
          try { // OpenVINO makes them read-only
            fs.chmodSync(path.join(ovCache, f), 0o666);
            fs.rmSync(path.join(ovCache, f), { recursive: true, force: true });
          } catch { /* in use by the running app: next time */ }
        }
      }
      fs.writeFileSync(ovMark, ovVersion);
    }
    ok("removing the original voices ready");
  } catch (e) { sepFailed(e); }
}

// ---------------------------------------------------------------- 7. duplicates and unused files

// Only what the app uses is kept: older versions of a model, second copies, programs and packages nothing
// uses any more are removed. (lib/pipeline.ts, lib/tools.ts and scripts/separate.py name what is used.)
step("Removing duplicates and files the app does not use");
let freed = 0;
const sizeOf = (p) => {
  try {
    const s = fs.lstatSync(p);
    return s.isDirectory() ? fs.readdirSync(p).reduce((n, e) => n + sizeOf(path.join(p, e)), 0) : s.size;
  } catch { return 0; }
};
function remove(p, why) {
  const n = sizeOf(p);
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
  } catch (e) { return console.log(`  ! could not remove ${path.relative(root, p)} (${e.code}): in use? next time then`); }
  freed += n;
  console.log(`  - ${path.relative(root, p)}  (${why}, ${(n / 1e6).toFixed(0)} MB)`);
}
/** Removes everything in dir that is not named in keep. */
function keepOnly(dir, keep, why) {
  if (!fs.existsSync(dir)) return;
  const k = keep.map((n) => n.toLowerCase());
  for (const name of fs.readdirSync(dir)) if (!k.includes(name.toLowerCase())) remove(path.join(dir, name), why);
}

// programs: one copy of each (not while the app runs: yt-dlp may be updating itself in there)
if (!appRunning) {
  keepOnly(bin, ["ffmpeg", "ffprobe", "yt-dlp", "deno", "aria2c"].map((n) => path.basename(inBin(n)))
    .concat(["whisper", "node", ".yt-dlp-checked"]), "not used by the app");
}
// speech models: the three sizes the app offers and the VAD model; any other ggml file is another version
keepOnly(models, [...Object.values(MODELS), "ggml-silero-v5.1.2.bin", "hf", "mdx", "torch"], "not used by the app");
keepOnly(path.join(models, "mdx"), ["Kim_Vocal_2.onnx", "cache"], "not used by the app");
keepOnly(path.join(root, "py"), ["python", "venv", "tmp", "cache"], "not used by the app"); // (src/: voice cloning's code)

// voice models (Hugging Face cache): when a model is updated, the old version stays next to the new one
// (not while the app runs: it may be downloading a model into there right now)
const hub = path.join(models, "hf", "hub");
if (fs.existsSync(hub) && !appRunning) {
  // only Demucs (scripts/separate.py) comes from here; the rest is voice cloning's (Seed-VC, BigVGAN, Whisper-small)
  const HUB_MODELS = ["models--adefossez--HTDemucs"];
  for (const repo of fs.readdirSync(hub).filter((d) => d.startsWith("models--") && !HUB_MODELS.includes(d))) {
    remove(path.join(hub, repo), "model not used by the app any more");
    fs.rmSync(path.join(hub, ".locks", repo), { recursive: true, force: true });
  }
  for (const repo of fs.readdirSync(hub).filter((d) => d.startsWith("models--"))) {
    const dir = path.join(hub, repo), refs = path.join(dir, "refs"), snaps = path.join(dir, "snapshots");
    if (!fs.existsSync(refs) || !fs.existsSync(snaps)) continue;
    const current = fs.readdirSync(refs, { withFileTypes: true }).filter((r) => r.isFile()) // (refs/pr/ is a folder)
      .map((r) => fs.readFileSync(path.join(refs, r.name), "utf8").trim());
    if (!current.length) continue;
    keepOnly(snaps, current, `older version of ${repo.slice(8).replace("--", "/")}`);
    // with symbolic links the files live in blobs/: keep the ones the current version links to
    const used = new Set();
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name);
        if (e.isSymbolicLink()) used.add(path.basename(fs.readlinkSync(f)));
        else if (e.isDirectory()) walk(f);
      }
    };
    walk(snaps);
    const blobs = path.join(dir, "blobs");
    if (fs.existsSync(blobs)) keepOnly(blobs, [...used], "older version or unfinished download");
  }
}

// Node packages that are not in package-lock.json (left from an older version of the app)
const lockPkgs = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages ?? {};
const nm = path.join(root, "node_modules");
for (const name of fs.existsSync(nm) ? fs.readdirSync(nm).filter((n) => !n.startsWith(".")) : []) {
  const names = name.startsWith("@") ? fs.readdirSync(path.join(nm, name)).map((s) => `${name}/${s}`) : [name];
  for (const n of names) if (!lockPkgs[`node_modules/${n}`]) remove(path.join(nm, n), "Node package not used any more");
}
ok(!freed ? "no duplicates or unused files" : freed >= 1e9 ? `${(freed / 1e9).toFixed(1)} GB freed` : `${Math.ceil(freed / 1e6)} MB freed`);

// ---------------------------------------------------------------- 8. build

step("Building the app");
if (args.includes("--no-build")) ok("skipped (--no-build)");
else {
  execSync("npm run build", { cwd: root, stdio: "inherit" });
  ok("built");
}

// start.ps1 runs setup again only when this fingerprint no longer matches (installer or packages changed)
// (line endings ignored: git may check the same file out with CRLF or LF; and a byte-order mark, which
// start.ps1's reading drops - an editor may save one)
const fingerprint = ["scripts/setup.mjs", "package-lock.json"].map((f) => createHash("sha256")
  .update(fs.readFileSync(path.join(root, f), "utf8").replace(/^\uFEFF/, "").replace(/\r/g, ""), "utf8")
  .digest("hex").toUpperCase()).join("");
// something could not be updated (no internet) but works: not marked done, so the next start tries again
if (!incomplete) {
  fs.writeFileSync(path.join(root, ".setup-done.json"),
    JSON.stringify({ fingerprint, args: args.filter((a) => a !== "--no-build" && a !== "--clean"), at: new Date().toISOString() }, null, 1));
}

console.log(`
Setup complete${incomplete ? " (some parts could not be updated - setup tries again next time)" : ""}.
  Start the app:  start.cmd   ->  http://127.0.0.1:5000
${wantSeparation ? "" : "  Removing the original voices was left out (--no-separation); add it later with: npm run setup\n"}`);
