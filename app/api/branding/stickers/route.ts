import { fs } from "@/lib/rt";
import { listStickers, saveSticker, stickerPath } from "@/lib/branding";
import { forbidden } from "@/lib/guard";
import { MB, readBody, uploadFailed } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The sticker library (images kept for every video). */
export function GET(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  return Response.json(listStickers().map((file) => ({ file, url: `/api/branding/stickers/${encodeURIComponent(file)}` })));
}

/** Upload: the image is the request body, its file name in ?name=. */
export async function POST(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const name = new URL(req.url).searchParams.get("name") || "";
  let data: Buffer;
  try { data = await readBody(req, 20 * MB, "A sticker"); } catch (e) { return uploadFailed(e); } // stops at the limit, not after
  try {
    const file = saveSticker(name, data);
    return Response.json({ file, url: `/api/branding/stickers/${encodeURIComponent(file)}` });
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}

export function DELETE(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const f = stickerPath(new URL(req.url).searchParams.get("file") || "");
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
