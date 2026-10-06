import { fs } from "@/lib/rt";
import { DEFAULT_LOGO, DEFAULT_SUB, listFonts, logoFile } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fonts that can show Khmer, the current logo and the default look. */
export function GET() {
  const logo = logoFile();
  return Response.json({
    fonts: listFonts().map(({ family, file, uploaded }) => ({ family, uploaded, url: uploaded ? `/api/branding/fonts/${encodeURIComponent(file)}` : null })),
    logo: logo ? { url: `/api/branding/logo?v=${Math.round(fs.statSync(logo).mtimeMs)}` } : null,
    defaults: { sub: DEFAULT_SUB, logo: DEFAULT_LOGO },
  });
}
