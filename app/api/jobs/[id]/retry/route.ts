import { jobs, retryPrepare } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runs a failed first step (download, speech recognition, translation) again. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (job.status !== "error" || job.meta) return Response.json({ detail: "Only a project whose first step failed can be retried" }, { status: 409 });
  retryPrepare(job);
  return Response.json(job);
}
