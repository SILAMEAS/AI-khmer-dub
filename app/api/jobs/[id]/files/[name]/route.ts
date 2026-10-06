import fs from "node:fs";
import path from "node:path";
import { VOICES_DIR } from "@/lib/clone";
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
  const sample = /^speaker_\d+\.wav$/.test(name); // voice sample of each person found in the video
  const file = sample ? path.join(jobDir(id), VOICES_DIR, name) : path.join(jobDir(id), name);
  if (!job || !(FILES[name] || sample) || !fs.existsSync(file)) {
    return Response.json({ detail: "File not ready" }, { status: 404 });
  }
  const [type, suffix] = FILES[name] ?? ["audio/wav", ` ${name}`];
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
  return new Response(fileStream(file, start, end), { status, headers });
}

/**
 * File bytes as a web stream that stops quietly when the browser cancels. Video players cancel range
 * requests all the time; Readable.toWeb then throws "Controller is already closed" and takes the server down.
 */
function fileStream(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  const src = fs.createReadStream(file, { start, end });
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      src.on("data", (chunk) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk as Buffer));
        if ((controller.desiredSize ?? 1) <= 0) src.pause(); // let the browser catch up
      });
      src.on("end", () => { if (!done) { done = true; controller.close(); } });
      src.on("error", (e) => { if (!done) { done = true; controller.error(e); } });
    },
    pull() { src.resume(); },
    cancel() { done = true; src.destroy(); },
  });
}
