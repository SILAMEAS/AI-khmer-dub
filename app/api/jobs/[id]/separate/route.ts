import { jobs, startSeparate } from "@/lib/jobs";
import { cloneAvailable } from "@/lib/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Separate the original voices from the music in the background, so the editor can remove them live. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (!cloneAvailable()) {
    return Response.json({ detail: "Separating voices from music needs the voice tools - run: npm run setup" }, { status: 400 });
  }
  startSeparate(job);
  return Response.json({ ok: true });
}
