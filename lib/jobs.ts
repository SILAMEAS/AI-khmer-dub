import fs from "node:fs";
import path from "node:path";
import { dub, prepare, type Meta, type Opts } from "./pipeline";
import { JOBS_DIR } from "./tools";

export type Job = {
  id: string;
  status: "queued" | "running" | "review" | "done" | "error";
  stage: string;
  progress: number;
  message: string;
  error?: string;
  opts: Opts;
  meta?: Meta;
  title: string;
  created: number;
  version?: number;
};

// Kept on globalThis so all route bundles (and dev hot reloads) share one queue.
type Store = { jobs: Map<string, Job>; queue: Promise<void> };
const g = globalThis as unknown as { __khmerDub?: Store };

function init(): Store {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const jobs = new Map<string, Job>();
  for (const id of fs.readdirSync(JOBS_DIR)) {
    const f = path.join(JOBS_DIR, id, "job.json");
    if (!fs.existsSync(f)) continue;
    const job: Job = JSON.parse(fs.readFileSync(f, "utf8"));
    if (job.status === "queued" || job.status === "running") {
      Object.assign(job, { status: "error", error: "Server restarted while this job was running" });
    }
    jobs.set(job.id, job);
  }
  return { jobs, queue: Promise.resolve() };
}

const store = (g.__khmerDub ??= init());
export const jobs = store.jobs;
export const jobDir = (id: string) => path.join(JOBS_DIR, id);

export function save(job: Job) {
  fs.writeFileSync(path.join(jobDir(job.id), "job.json"), JSON.stringify(job, null, 1), "utf8");
}

const reporter = (job: Job) => (stage: string, frac: number, message: string) => {
  Object.assign(job, { stage, progress: Math.round(frac * 1000) / 1000, message });
};

function fail(job: Job, e: unknown) {
  console.error(e);
  Object.assign(job, { status: "error", error: e instanceof Error ? e.message : String(e), message: "Failed" });
  save(job);
}

async function runDub(job: Job) {
  try {
    Object.assign(job, { status: "running", error: undefined });
    save(job);
    await dub(jobDir(job.id), job.opts, job.meta!, reporter(job));
    Object.assign(job, { status: "done", stage: "done", progress: 1, message: "Done", version: (job.version ?? 0) + 1 });
    save(job);
  } catch (e) { fail(job, e); }
}

async function runPrepare(job: Job) {
  try {
    job.status = "running";
    save(job);
    job.meta = await prepare(jobDir(job.id), job.opts, reporter(job));
    if (job.opts.review) {
      Object.assign(job, { status: "review", stage: "review", progress: 1,
        message: "Check the Khmer translation, then generate the voice" });
      save(job);
      return;
    }
  } catch (e) { fail(job, e); return; }
  await runDub(job);
}

// One heavy job at a time: whisper and ffmpeg already use every CPU core.
const enqueue = (fn: () => Promise<void>) => { store.queue = store.queue.then(fn, fn); };

export function startJob(job: Job) {
  jobs.set(job.id, job);
  save(job);
  enqueue(() => runPrepare(job));
}

export function startDub(job: Job) {
  Object.assign(job, { status: "queued", stage: "queued", progress: 0, message: "Waiting in queue", error: undefined });
  save(job);
  enqueue(() => runDub(job));
}
