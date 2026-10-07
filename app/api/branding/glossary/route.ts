import { loadGlossary, parseGlossary, saveGlossary } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Words always translated the same way (names, brands, terms), used for every new translation. */
export function GET() {
  return Response.json(loadGlossary());
}

export async function POST(req: Request) {
  const g = parseGlossary(await req.json().catch(() => []));
  saveGlossary(g);
  return Response.json(g);
}
