import { fs, path } from "@/lib/rt";
import { stickerPath } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const f = stickerPath(decodeURIComponent((await params).file));
  if (!f || !fs.existsSync(f)) return Response.json({ detail: "No such sticker" }, { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(f)), {
    headers: { "Content-Type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "max-age=3600" },
  });
}
