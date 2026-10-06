import { fs, path } from "@/lib/rt";
import { parseLogo, parseSubStyle } from "@/lib/branding";
import { jobDir, jobs } from "@/lib/jobs";
import { previewFrame } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A still from the video with these subtitle and logo settings, rendered exactly like the final video. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = jobs.get((await params).id);
  if (!job?.meta) return Response.json({ detail: "Job not found" }, { status: 404 });
  if (!fs.existsSync(path.join(jobDir(job.id), "km.srt"))) {
    return Response.json({ detail: "No Khmer subtitles yet" }, { status: 409 });
  }
  const b: { sub?: unknown; logo?: unknown; t?: number } = await req.json();
  const t = Math.max(0, Math.min(job.meta.duration - 0.1, Number(b.t) || 0));
  try {
    const png = await previewFrame(jobDir(job.id), { ...job.opts, sub: parseSubStyle(b.sub), logo: parseLogo(b.logo) },
      job.meta, t);
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
