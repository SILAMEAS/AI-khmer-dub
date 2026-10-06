import { fs } from "@/lib/rt";
import { jobDir, jobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const job = jobs.get((await params).id);
  return job ? Response.json(job) : Response.json({ detail: "Job not found" }, { status: 404 });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const job = jobs.get(id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status === "queued" || job.status === "running") {
    return Response.json({ detail: "Job is still running" }, { status: 409 });
  }
  jobs.delete(id);
  fs.rmSync(jobDir(id), { recursive: true, force: true });
  return Response.json({ ok: true });
}
