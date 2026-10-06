import fs from "node:fs";
import path from "node:path";
import { VOICES, voicePreview, type Voice } from "@/lib/pipeline";
import { JOBS_DIR } from "@/lib/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const voice = (q.get("voice") || "female") as Voice;
  if (!(voice in VOICES)) return Response.json({ detail: "voice must be male or female" }, { status: 400 });
  const rate = Math.max(-50, Math.min(50, Number(q.get("rate")) || 0));
  const dir = path.join(JOBS_DIR, "_preview");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${voice}_${rate}.mp3`);
  if (!fs.existsSync(out)) await voicePreview(voice, rate, out);
  return new Response(fs.readFileSync(out), { headers: { "Content-Type": "audio/mpeg" } });
}
