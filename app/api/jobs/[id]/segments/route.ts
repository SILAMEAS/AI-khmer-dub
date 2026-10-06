import { fs, path } from "@/lib/rt";
import { jobDir, jobs } from "@/lib/jobs";
import { loadSegments } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!jobs.has(id)) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (!fs.existsSync(path.join(jobDir(id), "segments.json"))) {
    return Response.json({ detail: "Transcription not finished yet" }, { status: 409 });
  }
  return Response.json(loadSegments(jobDir(id)));
}
