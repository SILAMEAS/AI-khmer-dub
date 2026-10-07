import { fs } from "@/lib/rt";
import { listStickers, saveSticker, stickerPath } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The sticker library (images kept for every video). */
export function GET() {
  return Response.json(listStickers().map((file) => ({ file, url: `/api/branding/stickers/${encodeURIComponent(file)}` })));
}

/** Upload: the image is the request body, its file name in ?name=. */
export async function POST(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > 20 * 1024 * 1024) return Response.json({ detail: "A sticker must be under 20 MB" }, { status: 400 });
  try {
    const file = saveSticker(name, data);
    return Response.json({ file, url: `/api/branding/stickers/${encodeURIComponent(file)}` });
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}

export function DELETE(req: Request) {
  const f = stickerPath(new URL(req.url).searchParams.get("file") || "");
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
