/**
 * Guards for the request paths: uploads that stop at a size limit instead of filling memory or the drive, files
 * served as streams instead of read whole, request bodies that are not JSON, and previews that do not pile up.
 */
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { fs, fsp, path } from "./rt";

export const MB = 1024 * 1024, GB = 1024 * MB;

/** An upload that can't be taken, with the HTTP status and the words to show. */
export class UploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** The answer for an UploadError (anything else is an interrupted upload). */
export function uploadFailed(e: unknown): Response {
  const u = e instanceof UploadError ? e : new UploadError("Upload was interrupted");
  return Response.json({ detail: u.message }, { status: u.status });
}

const tooBig = (max: number, what: string) => new UploadError(`${what} must be under ${max >= GB ? `${max / GB} GB` : `${Math.round(max / MB)} MB`}`, 413);

/** The size the browser says it sends; checked before any of it is read (undefined when it does not say). */
function declared(req: Request, max: number, what: string): number | undefined {
  const n = Number(req.headers.get("content-length"));
  if (!req.headers.has("content-length") || !Number.isFinite(n)) return undefined;
  if (n > max) throw tooBig(max, what);
  return n;
}

/** Counts the bytes going through and stops past `max`: Content-Length can be missing (or lie). */
const counter = (max: number, what: string) => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, next) {
      seen += chunk.length;
      next(seen > max ? tooBig(max, what) : null, chunk);
    },
  });
};

/** A small upload (an image, a font, music) in memory, stopped as soon as it is bigger than `max`. */
export async function readBody(req: Request, max: number, what: string): Promise<Buffer> {
  declared(req, max, what);
  if (!req.body) throw new UploadError("Empty upload");
  const parts: Buffer[] = [];
  let seen = 0;
  const reader = req.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.length;
      if (seen > max) throw tooBig(max, what);
      parts.push(Buffer.from(value));
    }
  } catch (e) {
    reader.cancel().catch(() => {}); // stop taking the rest of it
    throw e instanceof UploadError ? e : new UploadError("Upload was interrupted");
  }
  if (!seen) throw new UploadError("Empty upload");
  return Buffer.concat(parts);
}

/** Free bytes on the drive holding `dir` (Infinity when the system can't say). */
export async function freeSpace(dir: string): Promise<number> {
  try { const s = await fsp.statfs(dir); return s.bavail * s.bsize; } catch { return Infinity; }
}

/**
 * A big upload (a film, an intro clip) streamed to `file`, stopped past `max`; a stopped or broken upload leaves
 * no half file behind. When the browser says the size, a drive too full for it is said before anything is written.
 */
export async function saveBody(req: Request, file: string, max: number, what: string): Promise<void> {
  const size = declared(req, max, what);
  if (!req.body) throw new UploadError("Empty upload");
  const free = await freeSpace(path.dirname(file));
  if (size !== undefined && size + 500 * MB > free) { // some room left over: the work files come next
    const gb = (n: number) => (n / 1e9).toFixed(1);
    throw new UploadError(`Not enough disk space: the file is ${gb(size)} GB and ${gb(free)} GB is free. Free some space and try again.`, 507);
  }
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as WebStream), counter(max, what), fs.createWriteStream(file));
  } catch (e) {
    await fsp.rm(file, { force: true }).catch(() => {});
    if (e instanceof UploadError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw new UploadError("The drive is full - free some space and try again.", 507);
    throw new UploadError("Upload was interrupted");
  }
}

/**
 * A JSON request body, or null when it is not JSON or not an object (the route then answers 400, not 500).
 */
export async function jsonBody<T extends object = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null;
  } catch { return null; }
}

export const badRequest = () => Response.json({ detail: "Bad request" }, { status: 400 });

/**
 * File bytes (all, or start..end) as a web stream that stops quietly when the browser cancels. Video players cancel
 * range requests all the time; Readable.toWeb then throws "Controller is already closed" and takes the server down.
 */
export function fileStream(file: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const src = fs.createReadStream(file, start === undefined ? {} : { start, end });
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      src.on("data", (chunk) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk as Buffer));
        if ((controller.desiredSize ?? 1) <= 0) src.pause(); // let the browser catch up
      });
      src.on("end", () => { if (!done) { done = true; controller.close(); } });
      src.on("error", (e) => { if (!done) { done = true; controller.error(e); } });
    },
    pull() { src.resume(); },
    cancel() { done = true; src.destroy(); },
  });
}

/** A whole file as a response, streamed; a 404 when it is gone (deleted between the check and the read). */
export async function sendFile(file: string, headers: Record<string, string>, missing = "Not found"): Promise<Response> {
  let size: number;
  try { size = (await fsp.stat(file)).size; } catch { return Response.json({ detail: missing }, { status: 404 }); }
  return new Response(size ? fileStream(file) : null, { headers: { ...headers, "Content-Length": String(size) } });
}

// ---------------------------------------------------------------- previews: the newest one only

export class Superseded extends Error {
  constructor() { super("A newer preview was asked for"); }
}

type Lane = { running?: Promise<unknown>; stop?: AbortController; next?: AbortController };
const g = globalThis as unknown as { __khmerLanes?: Map<string, Lane> };
const lanes = (g.__khmerLanes ??= new Map());

/**
 * Runs `fn` with one at a time per `key` (a job and a kind of preview): dragging a style slider must not start an
 * ffmpeg per step while a job already uses every core. A newer request takes the place of one still waiting
 * (Superseded) and stops the one running through its signal; so does the browser going away (`client`).
 */
export async function latestOnly<T>(key: string, client: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = {}));
  const me = new AbortController();
  lane.next?.abort(); // a waiting older request is no longer wanted
  lane.next = me;
  lane.stop?.abort("a newer preview was asked for");
  const leave = () => me.abort("the page stopped waiting");
  client.addEventListener("abort", leave, { once: true });
  try {
    while (lane.running) await lane.running.catch(() => {});
    if (me.signal.aborted) throw new Superseded();
    lane.next = undefined;
    lane.stop = me;
    const work = fn(me.signal);
    lane.running = work;
    try { return await work; } finally {
      if (lane.running === work) { lane.running = undefined; lane.stop = undefined; }
      if (!lane.running && !lane.next) lanes.delete(key);
    }
  } finally {
    client.removeEventListener("abort", leave);
    if (lane.next === me) { lane.next = undefined; if (!lane.running) lanes.delete(key); }
  }
}

/** The answer when a preview failed: 409 when a newer one took its place, else the error. */
export function previewFailed(e: unknown): Response {
  if (e instanceof Superseded) return Response.json({ detail: e.message }, { status: 409 });
  return Response.json({ detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
