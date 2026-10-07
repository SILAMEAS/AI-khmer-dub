import { jobDir, jobs } from "@/lib/jobs";
import { findSilences } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Silent parts of the video (nobody speaks, the sound is quiet) to cut out: { min: seconds, db: threshold }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  const b: { min?: number; db?: number } = await req.json().catch(() => ({}));
  const min = Math.max(0.3, Math.min(10, Number(b.min) || 0.8)), db = Math.max(-70, Math.min(-15, Number(b.db) || -35));
  try {
    return Response.json(await findSilences(jobDir(job.id), job.meta, min, db));
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
