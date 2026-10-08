import { fs, path } from "@/lib/rt";
import { logoFile, saveLogo } from "@/lib/branding";
import { forbidden } from "@/lib/guard";
import { MB, readBody, sendFile, uploadFailed } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export function GET(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const f = logoFile();
  if (!f) return Response.json({ detail: "No logo" }, { status: 404 });
  return sendFile(f, { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" }, "No logo");
}

/** Upload: the image is the request body, its file name in ?name= (kept for every video). */
export async function POST(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const name = new URL(req.url).searchParams.get("name") || "";
  let data: Buffer;
  try { data = await readBody(req, 10 * MB, "The logo"); } catch (e) { return uploadFailed(e); } // stops at the limit, not after
  try {
    saveLogo(path.extname(name).toLowerCase(), data);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export function DELETE(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const f = logoFile();
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
