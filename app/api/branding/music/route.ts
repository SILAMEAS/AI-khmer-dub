import { fs, path } from "@/lib/rt";
import { musicFile, saveMusic } from "@/lib/branding";
import { forbidden } from "@/lib/guard";
import { MB, readBody, sendFile, uploadFailed } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

/** Your background music (one file, used for every video where its level is above 0). */
export function GET(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const f = musicFile();
  if (!f) return Response.json({ detail: "No music" }, { status: 404 });
  return sendFile(f, { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" }, "No music");
}

/** Upload: the audio file is the request body, its file name in ?name=. */
export async function POST(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const name = new URL(req.url).searchParams.get("name") || "";
  let data: Buffer;
  try { data = await readBody(req, 50 * MB, "The music"); } catch (e) { return uploadFailed(e); } // stops at the limit, not after
  try {
    saveMusic(path.extname(name).toLowerCase(), data);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true, name: path.basename(name) });
}

export function DELETE(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const f = musicFile();
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
