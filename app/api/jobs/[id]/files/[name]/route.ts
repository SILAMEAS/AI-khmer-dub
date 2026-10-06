import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { jobDir, jobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES: Record<string, [string, string]> = { // name -> [content type, download name suffix]
  "output.mp4": ["video/mp4", " [Khmer].mp4"],
  "km.srt": ["application/x-subrip; charset=utf-8", ".km.srt"],
  "original.srt": ["application/x-subrip; charset=utf-8", ".original.srt"],
  "dub_audio.m4a": ["audio/mp4", " [Khmer audio].m4a"],
};

/** Serves results with HTTP Range support so the video player can seek. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  const job = jobs.get(id);
  const file = path.join(jobDir(id), name);
  if (!job || !FILES[name] || !fs.existsSync(file)) return Response.json({ detail: "File not ready" }, { status: 404 });
  const [type, suffix] = FILES[name];
  const size = fs.statSync(file).size;
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (new URL(req.url).searchParams.get("download")) {
    const stem = (job.meta?.title || id).replace(/[\\/:*?"<>|]/g, "").slice(0, 80);
    headers["Content-Disposition"] =
      `attachment; filename="download${path.extname(name)}"; filename*=UTF-8''${encodeURIComponent(stem + suffix)}`;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    start = m[1] ? +m[1] : Math.max(size - +m[2], 0);
    end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
  return new Response(stream, { status, headers });
}
