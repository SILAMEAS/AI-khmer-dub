import { fs, path } from "@/lib/rt";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { clipFile, saveClipFile, type ClipKind } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Your channel's intro and outro clips (kept for every video): ?kind=intro|outro. */
const kindOf = (req: Request): ClipKind | null => {
  const k = new URL(req.url).searchParams.get("kind");
  return k === "intro" || k === "outro" ? k : null;
};

export function GET(req: Request) {
  const kind = kindOf(req);
  if (!kind) {
    const info = (k: ClipKind) => { const f = clipFile(k); return f ? { url: `/api/branding/clips?kind=${k}&v=${Math.round(fs.statSync(f).mtimeMs)}` } : null; };
    return Response.json({ intro: info("intro"), outro: info("outro") });
  }
  const f = clipFile(kind);
  if (!f) return Response.json({ detail: "None" }, { status: 404 });
  return new Response(Readable.toWeb(fs.createReadStream(f)) as ReadableStream, {
    headers: { "Content-Type": "video/mp4", "Content-Length": String(fs.statSync(f).size), "Cache-Control": "no-store" },
  });
}

/** Upload: the video is the request body (streamed to disk), its file name in ?name=. */
export async function POST(req: Request) {
  const kind = kindOf(req);
  const name = new URL(req.url).searchParams.get("name") || "";
  if (!kind || !req.body) return Response.json({ detail: "Say which clip: intro or outro" }, { status: 400 });
  let file: string;
  try { file = saveClipFile(kind, path.extname(name).toLowerCase()); } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as WebStream), fs.createWriteStream(file));
  } catch {
    fs.rmSync(file, { force: true });
    return Response.json({ detail: "Upload was interrupted" }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export function DELETE(req: Request) {
  const kind = kindOf(req);
  const f = kind && clipFile(kind);
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
