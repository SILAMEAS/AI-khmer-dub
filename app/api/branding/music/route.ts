import { fs, path } from "@/lib/rt";
import { musicFile, saveMusic } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

/** Your background music (one file, used for every video where its level is above 0). */
export function GET() {
  const f = musicFile();
  if (!f) return Response.json({ detail: "No music" }, { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(f)), {
    headers: { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" },
  });
}

/** Upload: the audio file is the request body, its file name in ?name=. */
export async function POST(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > 50 * 1024 * 1024) return Response.json({ detail: "The music must be under 50 MB" }, { status: 400 });
  try {
    saveMusic(path.extname(name).toLowerCase(), data);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true, name: path.basename(name) });
}

export function DELETE() {
  const f = musicFile();
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
