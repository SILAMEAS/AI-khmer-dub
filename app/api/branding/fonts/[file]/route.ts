import { fs, path } from "@/lib/rt";
import { FONTS_DIR } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An uploaded font, so the page can show it in the style preview. */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = path.basename(decodeURIComponent((await params).file));
  const file = path.join(FONTS_DIR, name);
  if (!/\.(ttf|otf)$/i.test(name) || !fs.existsSync(file)) return Response.json({ detail: "Font not found" }, { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { "Content-Type": name.toLowerCase().endsWith(".otf") ? "font/otf" : "font/ttf", "Cache-Control": "max-age=3600" },
  });
}
