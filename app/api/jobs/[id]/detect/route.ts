import { fs, path } from "@/lib/rt";
import { detectBurnedIn } from "@/lib/detect";
import { jobDir, jobs } from "@/lib/jobs";
import { latestOnly, previewFailed } from "@/lib/limits";
import { loadSegments } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the source video has its own subtitles and logos burned in (lib/detect.ts), to take them away. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  const jd = jobDir(job.id), meta = job.meta;
  // subtitles show while people speak: the middle of each line (none in a project only edited)
  const speech = fs.existsSync(path.join(jd, "segments.json")) ? loadSegments(jd).map((s) => (s.start + s.end) / 2) : [];
  try {
    return Response.json(await latestOnly(`detect:${job.id}`, req.signal,
      (signal) => detectBurnedIn(path.join(jd, meta.input), meta.duration, speech, signal)));
  } catch (e) {
    return previewFailed(e);
  }
}
