import { fs, path } from "@/lib/rt";
import { logoFile, saveLogo } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export function GET() {
  const f = logoFile();
  if (!f) return Response.json({ detail: "No logo" }, { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(f)), {
    headers: { "Content-Type": TYPES[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" },
  });
}

/** Upload: the image is the request body, its file name in ?name= (kept for every video). */
export async function POST(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > 10 * 1024 * 1024) return Response.json({ detail: "The logo must be under 10 MB" }, { status: 400 });
  try {
    saveLogo(path.extname(name).toLowerCase(), data);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export function DELETE() {
  const f = logoFile();
  if (f) fs.rmSync(f, { force: true });
  return Response.json({ ok: true });
}
