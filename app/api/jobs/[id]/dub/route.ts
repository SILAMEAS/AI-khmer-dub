import { jobDir, jobs, startDub } from "@/lib/jobs";
import { loadSegments, saveSegments, VOICES, type Opts } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { voice?: string; rate?: number; bgMode?: string; burn?: boolean; segments?: { i: number; km: string }[] };

/** Generate (or regenerate) the Khmer voice, optionally with edited lines or another voice. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  if (!job.meta) return Response.json({ detail: "This job has no transcription - start a new one" }, { status: 409 });
  const b: Body = await req.json();
  if (b.voice) {
    if (!(b.voice in VOICES)) return Response.json({ detail: "voice must be male or female" }, { status: 400 });
    job.opts.voice = b.voice as Opts["voice"];
  }
  if (typeof b.rate === "number") job.opts.rate = Math.max(-50, Math.min(50, b.rate));
  if (b.bgMode) job.opts.bgMode = b.bgMode === "none" ? "none" : "duck";
  if (typeof b.burn === "boolean") job.opts.burn = b.burn;
  if (b.segments?.length) {
    const segs = loadSegments(jobDir(job.id));
    for (const e of b.segments) if (segs[e.i]) segs[e.i].km = String(e.km).trim();
    saveSegments(jobDir(job.id), segs);
  }
  startDub(job);
  return Response.json(job);
}
