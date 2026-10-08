import { separationAvailable } from "@/lib/stems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What this install can do, so the page only offers removing the original voices when it is set up. */
export function GET() {
  return Response.json({ separate: separationAvailable() });
}
