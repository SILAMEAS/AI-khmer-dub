import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { jobDir, jobs, startJob, type Job } from "@/lib/jobs";
import { VOICES, type Opts } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXT = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".ts", ".mpg", ".mpeg"]);
const bad = (msg: string, status = 400) => Response.json({ detail: msg }, { status });

export function GET() {
  return Response.json([...jobs.values()].sort((a, b) => b.created - a.created).slice(0, 30));
}

/**
 * Two ways in:
 *  - JSON body {url, ...options}                  for a video link
 *  - raw file body, options in the query string   for uploads (streamed to disk, any size)
 */
export async function POST(req: Request) {
  const q = new URL(req.url).searchParams;
  const isJson = (req.headers.get("content-type") || "").includes("application/json");
  const p: Record<string, string> = isJson ? await req.json() : Object.fromEntries(q);

  const voice = (p.voice || "female") as Opts["voice"];
  if (!(voice in VOICES)) return bad("voice must be male or female");
  const opts: Opts = {
    url: isJson ? String(p.url || "").trim() : "",
    sourceLang: (["zh", "en"].includes(p.sourceLang) ? p.sourceLang : "auto") as Opts["sourceLang"],
    quality: p.quality || "best",
    voice,
    rate: Math.max(-50, Math.min(50, Number(p.rate) || 0)),
    bgMode: p.bgMode === "none" ? "none" : "duck",
    burn: String(p.burn) === "true",
    review: String(p.review) !== "false",
  };

  const id = randomUUID().slice(0, 10);
  const jd = jobDir(id);
  if (isJson) {
    if (!/^https?:\/\//i.test(opts.url)) return bad("Paste a valid video link");
    fs.mkdirSync(jd, { recursive: true });
  } else {
    const name = q.get("name") || "";
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return bad(`Unsupported file type ${ext || "(none)"}`);
    if (!req.body) return bad("Empty upload");
    fs.mkdirSync(jd, { recursive: true });
    opts.inputName = "input" + ext;
    opts.title = path.basename(name, ext);
    try {
      await pipeline(Readable.fromWeb(req.body as unknown as WebStream),
        fs.createWriteStream(path.join(jd, opts.inputName)));
    } catch {
      fs.rmSync(jd, { recursive: true, force: true });
      return bad("Upload was interrupted");
    }
  }

  const job: Job = { id, status: "queued", stage: "queued", progress: 0, message: "Waiting in queue",
    opts, title: opts.title || opts.url, created: Date.now() };
  startJob(job);
  return Response.json(job);
}
