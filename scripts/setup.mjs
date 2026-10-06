// One-time setup: downloads whisper.cpp, Whisper models, the VAD model and yt-dlp into ./bin and ./models.
// Usage: npm run setup            (default model: large-v3-turbo)
//        npm run setup -- --all   (also medium + small)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin");
const models = path.join(root, "models");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(models, { recursive: true });

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODELS = {
  best: "ggml-large-v3-turbo-q5_0.bin",
  balanced: "ggml-medium-q5_0.bin",
  fast: "ggml-small-q5_1.bin",
};

async function download(url, dest, label) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return console.log(`✓ ${label} already present`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, last = 0;
  const tmp = dest + ".part";
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct >= last + 10) { last = pct; process.stdout.write(`  ${label} ${pct}%\n`); }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  console.log(`✓ ${label}`);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

// whisper.cpp prebuilt CPU binaries for Windows
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
  fs.mkdirSync(whisperDir, { recursive: true });
  // Windows' own bsdtar unpacks zips; Git's GNU tar (often first on PATH) cannot.
  const winTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(fs.existsSync(winTar) ? winTar : "tar", ["-xf", zip, "-C", whisperDir]);
  fs.unlinkSync(zip);
} else console.log("✓ whisper.cpp already present");

await download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", path.join(bin, "yt-dlp.exe"), "yt-dlp");
await download("https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
  path.join(models, "ggml-silero-v5.1.2.bin"), "VAD model");

const wanted = process.argv.includes("--all") ? Object.values(MODELS) : [MODELS.best];
for (const m of wanted) await download(`${HF}/${m}`, path.join(models, m), m);

console.log("\nSetup complete. Run:  npm run build  then  npm start");
