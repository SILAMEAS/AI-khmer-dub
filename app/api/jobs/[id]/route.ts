import { fs, path } from "@/lib/rt";
import { jobDir, jobs } from "@/lib/jobs";
import { stemsReady } from "@/lib/clone";
import { shapeFile, SHAPES } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The job, plus which tracks the editor's live preview can play. */
export async function GET(_req: Request, { params }: Ctx) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  const has = (f: string) => fs.existsSync(path.join(jobDir(job.id), f));
  return Response.json({ ...job, tracks: {
    voice: has("voice_track.m4a"), vocals: !!job.meta && stemsReady(jobDir(job.id), job.meta.duration), output: has("output.mp4"),
    shapes: SHAPES.filter((a) => has(shapeFile(a))), thumbnail: has("thumbnail.jpg"),
  } });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  try { // files first: if one is in use (open in a player or Explorer) the job stays listed
    fs.rmSync(jobDir(id), { recursive: true, force: true, maxRetries: 3 });
  } catch {
    return Response.json({ detail: "Some files of this job are in use - close them (video player, Explorer) and try again" },
      { status: 409 });
  }
  jobs.delete(id);
  return Response.json({ ok: true });
}
