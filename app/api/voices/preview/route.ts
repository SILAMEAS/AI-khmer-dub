import { fs, fsp, path } from "@/lib/rt";
import { VOICES, voicePreview, type Voice } from "@/lib/pipeline";
import { JOBS_DIR } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Previews being made, by file: two clicks (or two tabs) at once share one instead of writing the same file twice.
const g = globalThis as unknown as { __khmerPreviews?: Map<string, Promise<void>> };
const making = (g.__khmerPreviews ??= new Map());

/**
 * The sample made once and kept. It is written under a temporary name and renamed when whole: a voice that failed
 * half-way (the voice servers dropped the connection) would otherwise be kept and played cut off from then on.
 */
function ensure(voice: Voice, rate: number, out: string): Promise<void> {
  if (fs.existsSync(out)) return Promise.resolve();
  let p = making.get(out);
  if (!p) {
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
    p = (async () => {
      try {
        await voicePreview(voice, rate, tmp);
        if (!(await fsp.stat(tmp)).size) throw new Error("The voice service sent nothing - try again");
        await fsp.rename(tmp, out);
      } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
    })().finally(() => making.delete(out));
    making.set(out, p);
  }
  return p;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const voice = (q.get("voice") || "female") as Voice;
  if (!Object.hasOwn(VOICES, voice)) return Response.json({ detail: "voice must be male or female" }, { status: 400 });
  const rate = Math.max(-50, Math.min(50, Number(q.get("rate")) || 0));
  const dir = path.join(JOBS_DIR, "_preview");
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${voice}_${rate}.mp3`);
  try {
    await ensure(voice, rate, out);
    return new Response(new Uint8Array(await fsp.readFile(out)), { headers: { "Content-Type": "audio/mpeg" } });
  } catch (e) {
    return Response.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
