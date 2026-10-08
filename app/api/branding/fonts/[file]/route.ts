import { path } from "@/lib/rt";
import { FONTS_DIR } from "@/lib/branding";
import { sendFile } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An uploaded font, so the page can show it in the style preview. */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  let name: string;
  try { name = path.basename(decodeURIComponent((await params).file)); } catch { name = ""; } // a broken %-escape is no font
  if (!/\.(ttf|otf)$/i.test(name)) return Response.json({ detail: "Font not found" }, { status: 404 });
  return sendFile(path.join(FONTS_DIR, name), { "Content-Type": name.toLowerCase().endsWith(".otf") ? "font/otf" : "font/ttf",
    "Cache-Control": "max-age=3600" }, "Font not found");
}
