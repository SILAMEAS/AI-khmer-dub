import fs from "node:fs";
import path from "node:path";
import { parseLogo, parseSubStyle } from "@/lib/branding";
import { jobDir, jobs, startRender } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** New subtitle style or logo for a finished dub: only the video picture is rebuilt (no new voices). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  if (!job.meta || !fs.existsSync(path.join(jobDir(job.id), "dub_audio.m4a"))) {
    return Response.json({ detail: "Generate the Khmer voice first" }, { status: 409 });
  }
  const b: { burn?: boolean; sub?: unknown; logo?: unknown } = await req.json();
  if (typeof b.burn === "boolean") job.opts.burn = b.burn;
  if (b.sub) job.opts.sub = parseSubStyle(b.sub);
  if (b.logo) job.opts.logo = parseLogo(b.logo);
  startRender(job);
  return Response.json(job);
}
