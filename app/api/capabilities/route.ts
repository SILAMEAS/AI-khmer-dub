import { cloneAvailable } from "@/lib/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What this install can do, so the page only offers voice cloning when it is set up. */
export function GET() {
  return Response.json({ clone: cloneAvailable() });
}
