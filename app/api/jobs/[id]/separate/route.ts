import { jobs, startSeparate } from "@/lib/jobs";
import { separationAvailable } from "@/lib/stems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Separate the original voices from the music in the background, so the editor can remove them live. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (!separationAvailable()) {
    return Response.json({ detail: "Separating voices from music is not installed - close the app and run start.cmd again (setup installs it)" }, { status: 400 });
  }
  startSeparate(job);
  return Response.json({ ok: true });
}
