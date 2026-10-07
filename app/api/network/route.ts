import { networkSettings, parseNetwork, saveNetworkSettings } from "@/lib/download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Proxy and browser login used for video links (branding/network.json). */
export function GET() {
  return Response.json(networkSettings());
}

export async function POST(req: Request) {
  try {
    const s = parseNetwork(await req.json());
    saveNetworkSettings(s);
    return Response.json(s);
  } catch (e) {
    return Response.json({ detail: (e as Error).message }, { status: 400 });
  }
}
