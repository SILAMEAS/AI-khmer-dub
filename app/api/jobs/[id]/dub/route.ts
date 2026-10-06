import { jobDir, jobs, startDub } from "@/lib/jobs";
import { loadSegments, saveSegments, voiceError, VOICES, type Opts, type Voice } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  voice?: string; match?: boolean; rate?: number; bgMode?: string; burn?: boolean;
  segments?: { i: number; km: string; voice?: string; speaker?: number }[];
};

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
    const err = voiceError(b.voice);
    if (err) return Response.json({ detail: err }, { status: 400 });
    job.opts.voice = b.voice as Opts["voice"];
  }
  if (typeof b.match === "boolean") job.opts.match = b.match;
  if (typeof b.rate === "number") job.opts.rate = Math.max(-50, Math.min(50, b.rate));
  if (b.bgMode) job.opts.bgMode = b.bgMode === "none" ? "none" : "duck";
  if (typeof b.burn === "boolean") job.opts.burn = b.burn;
  if (b.segments?.length) {
    const segs = loadSegments(jobDir(job.id));
    for (const e of b.segments) {
      if (!segs[e.i]) continue;
      segs[e.i].km = String(e.km).trim();
      if (e.voice && e.voice in VOICES) segs[e.i].voice = e.voice as Voice;
      const known = job.meta.speakers ?? 0;
      if (Number.isInteger(e.speaker) && e.speaker! >= 0 && e.speaker! < known) segs[e.i].speaker = e.speaker;
    }
    saveSegments(jobDir(job.id), segs);
  }
  startDub(job);
  return Response.json(job);
}
