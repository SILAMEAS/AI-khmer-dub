import { jobDir, jobs } from "@/lib/jobs";
import { parseThumb, thumbnail } from "@/lib/pipeline";
import { parseSubStyle } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A thumbnail (JPG) from the frame at t with a big title; also kept as thumbnail.jpg for download. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  const b: Record<string, unknown> = await req.json().catch(() => ({}));
  try {
    const jpg = await thumbnail(jobDir(job.id), { ...job.opts, sub: b.sub ? parseSubStyle(b.sub) : job.opts.sub }, job.meta, parseThumb(b));
    return new Response(new Uint8Array(jpg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
