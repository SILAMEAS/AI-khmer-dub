import { fs, path } from "@/lib/rt";
import { parseFx, parseLogo, parseOut, parseSubStyle } from "@/lib/branding";
import { jobDir, jobs, startRender } from "@/lib/jobs";
import { parseMix } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * New subtitle style, logo or format for a finished dub: only the video picture is rebuilt (no new voices).
 * New sound levels (mix, bgMode) also mix the existing Khmer lines again.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  const b: { burn?: boolean; sub?: unknown; logo?: unknown; out?: unknown; fx?: unknown; mix?: unknown; bgMode?: string } =
    await req.json();
  const sound = !!(b.mix || b.bgMode);
  // export (with the sound) needs the Khmer voice track; the picture alone needs a mix made before
  const needs = sound ? "voice_track.m4a" : "dub_audio.m4a";
  if (!job.meta || !fs.existsSync(path.join(jobDir(job.id), needs))) {
    return Response.json({ detail: "Generate the Khmer voice first" }, { status: 409 });
  }
  if (typeof b.burn === "boolean") job.opts.burn = b.burn;
  if (b.sub) job.opts.sub = parseSubStyle(b.sub);
  if (b.logo) job.opts.logo = parseLogo(b.logo);
  if (b.out) job.opts.out = parseOut(b.out);
  if (b.fx) job.opts.fx = parseFx(b.fx);
  if (b.mix) job.opts.mix = parseMix(b.mix);
  if (b.bgMode) job.opts.bgMode = b.bgMode === "none" ? "none" : "duck";
  startRender(job, sound);
  return Response.json(job);
}
