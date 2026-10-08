import { parseFx, parseLogo, parseOut, parseSubStyle } from "@/lib/branding";
import { parseEdit } from "@/lib/edit";
import { jobDir, jobs, startDub } from "@/lib/jobs";
import { loadSegments, parseMix, saveSegments, voiceError, VOICES, type Opts, type Voice } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  voice?: string; match?: boolean; rate?: number; bgMode?: string; burn?: boolean; sub?: unknown; logo?: unknown;
  out?: unknown; mix?: unknown; fx?: unknown; edit?: unknown;
  segments?: { i: number; km: string; voice?: string; speaker?: number }[];
};

/** Generate (or regenerate) the Khmer voice, optionally with edited lines or another voice. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (!job.meta) return Response.json({ detail: "This job has no transcription - start a new one" }, { status: 409 });
  let b: Body;
  try { b = await req.json(); } catch { return Response.json({ detail: "Bad request" }, { status: 400 }); }
  // checked after the body is read, with no waiting until it is queued: two quick clicks cannot both start it
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  if (b.voice) {
    const err = voiceError(b.voice);
    if (err) return Response.json({ detail: err }, { status: 400 });
    job.opts.voice = b.voice as Opts["voice"];
  }
  if (typeof b.match === "boolean") job.opts.match = b.match;
  if (typeof b.rate === "number") job.opts.rate = Math.max(-50, Math.min(50, b.rate));
  if (b.bgMode) job.opts.bgMode = b.bgMode === "none" ? "none" : "duck";
  if (typeof b.burn === "boolean") job.opts.burn = b.burn;
  if (b.sub) job.opts.sub = parseSubStyle(b.sub);
  if (b.logo) job.opts.logo = parseLogo(b.logo);
  if (b.out) job.opts.out = parseOut(b.out);
  if (b.fx) job.opts.fx = parseFx(b.fx);
  if (b.mix) job.opts.mix = parseMix(b.mix);
  if (b.edit) job.opts.edit = parseEdit(b.edit);
  if (b.segments?.length) {
    const segs = loadSegments(jobDir(job.id));
    for (const e of b.segments) {
      if (!segs[e.i]) continue;
      segs[e.i].km = String(e.km).trim();
      if (e.voice && Object.hasOwn(VOICES, e.voice)) segs[e.i].voice = e.voice as Voice;
      const known = job.meta.speakers ?? 0;
      if (Number.isInteger(e.speaker) && e.speaker! >= 0 && e.speaker! < known) segs[e.i].speaker = e.speaker;
    }
    saveSegments(jobDir(job.id), segs);
  }
  startDub(job);
  return Response.json(job);
}
