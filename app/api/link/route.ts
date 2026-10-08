import { extractUrl, prefetchStatus, startPrefetch } from "@/lib/download";
import { badRequest, jsonBody } from "@/lib/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const view = (p: NonNullable<ReturnType<typeof prefetchStatus>>) => ({
  url: p.url, title: p.title, duration: p.duration, site: p.site, progress: p.progress, message: p.message, ready: p.ready, error: p.error,
});

/**
 * A link was pasted: start downloading it straight away (what the site says, then the sound), so Start finds
 * the work already under way. Answers once the site has said what the link is: title, length, or why not.
 */
export async function POST(req: Request) {
  const body = await jsonBody<{ url?: unknown; size?: unknown }>(req);
  if (!body) return badRequest();
  const { url: text, size } = body;
  const url = extractUrl(String(text ?? ""));
  if (!url) return Response.json({ detail: "No video link found in what was pasted - copy the link of the video page (https://...)" }, { status: 400 });
  const p = await startPrefetch(url, [480, 720, 1080].includes(Number(size)) ? Number(size) : 1080);
  return p.error ? Response.json({ ...view(p), detail: p.error }, { status: 422 }) : Response.json(view(p));
}

/** How far the paste-time download of a link is. */
export function GET(req: Request) {
  const url = extractUrl(new URL(req.url).searchParams.get("url") ?? "");
  const p = url ? prefetchStatus(url) : undefined;
  return p ? Response.json(view(p)) : Response.json({ detail: "Not started" }, { status: 404 });
}
