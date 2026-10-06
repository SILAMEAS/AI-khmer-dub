import { saveFont } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload a .ttf/.otf font (request body, file name in ?name=); only fonts with Khmer letters are kept. */
export async function POST(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > 30 * 1024 * 1024) return Response.json({ detail: "The font must be under 30 MB" }, { status: 400 });
  try {
    const f = saveFont(name, data);
    return Response.json({ family: f.family });
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}
