import { saveFont } from "@/lib/branding";
import { forbidden } from "@/lib/guard";
import { MB, readBody, uploadFailed } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upload a .ttf/.otf font (request body, file name in ?name=); only fonts with Khmer letters are kept. */
export async function POST(req: Request) {
  const denied = forbidden(req); // checked here, not in proxy.ts (lib/guard.ts)
  if (denied) return denied;
  const name = new URL(req.url).searchParams.get("name") || "";
  let data: Buffer;
  try { data = await readBody(req, 30 * MB, "The font"); } catch (e) { return uploadFailed(e); } // stops at the limit, not after
  try {
    const f = saveFont(name, data);
    return Response.json({ family: f.family });
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}
