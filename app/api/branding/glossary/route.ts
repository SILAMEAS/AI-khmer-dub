import { loadGlossary, parseGlossary, saveGlossary } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Words always translated the same way (names, brands, terms), used for every new translation. */
export function GET() {
  return Response.json(loadGlossary());
}

export async function POST(req: Request) {
  let body: unknown;
  // a body that is not a JSON list is refused: read as "no words" it would wipe the whole glossary
  try { body = await req.json(); } catch { body = undefined; }
  if (!Array.isArray(body)) return Response.json({ detail: "Bad request" }, { status: 400 });
  const g = parseGlossary(body);
  saveGlossary(g);
  return Response.json(g);
}
