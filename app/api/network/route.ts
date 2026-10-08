import { networkSettings, parseNetwork, saveNetworkSettings } from "@/lib/download";
import { badRequest, jsonBody } from "@/lib/limits";
import { applyProxy } from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxy and browser login used for video links (branding/network.json); an http(s) proxy also for translation and voices. */
export function GET() {
  return Response.json(networkSettings());
}

export async function POST(req: Request) {
  const body = await jsonBody(req);
  if (!body) return badRequest();
  try {
    const s = parseNetwork(body);
    saveNetworkSettings(s);
    applyProxy(); // translation and the Khmer voices follow a new proxy straight away (lib/net.ts)
    return Response.json(s);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}
