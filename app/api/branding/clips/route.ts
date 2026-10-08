import { fs, path } from "@/lib/rt";
import { clipFile, saveClipFile, type ClipKind } from "@/lib/branding";
import { forbidden } from "@/lib/guard";
import { GB, saveBody, sendFile, uploadFailed } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Your channel's intro and outro clips (kept for every video): ?kind=intro|outro. */
const kindOf = (req: Request): ClipKind | null => {
  const k = new URL(req.url).searchParams.get("kind");
  return k === "intro" || k === "outro" ? k : null;
};

// an intro or outro is seconds to a few minutes long; far more than that is a wrong file, not a clip
const MAX_CLIP = 2 * GB;

export function GET(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const kind = kindOf(req);
  if (!kind) {
    const info = (k: ClipKind) => { const f = clipFile(k); return f ? { url: `/api/branding/clips?kind=${k}&v=${Math.round(fs.statSync(f).mtimeMs)}` } : null; };
    return Response.json({ intro: info("intro"), outro: info("outro") });
  }
  const f = clipFile(kind);
  if (!f) return Response.json({ detail: "None" }, { status: 404 });
  return sendFile(f, { "Content-Type": "video/mp4", "Cache-Control": "no-store" }, "None");
}

/** Upload: the video is the request body (streamed to disk), its file name in ?name=. */
export async function POST(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const kind = kindOf(req);
  const name = new URL(req.url).searchParams.get("name") || "";
  if (!kind || !req.body) return Response.json({ detail: "Say which clip: intro or outro" }, { status: 400 });
  let file: string;
  try { file = saveClipFile(kind, path.extname(name).toLowerCase()); } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  try { await saveBody(req, file, MAX_CLIP, "An intro or outro clip"); } catch (e) { return uploadFailed(e); } // no half file is left
  return Response.json({ ok: true });
}

export function DELETE(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const kind = kindOf(req);
  const f = kind && clipFile(kind);
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
