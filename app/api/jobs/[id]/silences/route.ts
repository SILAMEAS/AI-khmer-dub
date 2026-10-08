import { jobDir, jobs } from "@/lib/jobs";
import { latestOnly, previewFailed } from "@/lib/limits";
import { findSilences } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Silent parts of the video (nobody speaks, the sound is quiet) to cut out: { min: seconds, db: threshold }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  const meta = job.meta;
  const b: { min?: number; db?: number } = await req.json().catch(() => ({})) ?? {};
  const min = Math.max(0.3, Math.min(10, Number(b.min) || 0.8)), db = Math.max(-70, Math.min(-15, Number(b.db) || -35));
  try {
    // one search at a time per project (it reads the whole sound track): the newest settings win
    return Response.json(await latestOnly(`silences:${job.id}`, req.signal, (signal) => findSilences(jobDir(job.id), meta, min, db, signal)));
  } catch (e) {
    return previewFailed(e);
  }
}
