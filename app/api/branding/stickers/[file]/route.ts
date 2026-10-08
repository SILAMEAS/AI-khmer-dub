import { path } from "@/lib/rt";
import { stickerPath } from "@/lib/branding";
import { sendFile } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  let name: string;
  try { name = decodeURIComponent((await params).file); } catch { name = ""; } // a broken %-escape is no sticker
  const f = stickerPath(name);
  if (!f) return Response.json({ detail: "No such sticker" }, { status: 404 });
  return sendFile(f, { "Content-Type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "max-age=3600" },
    "No such sticker");
}
