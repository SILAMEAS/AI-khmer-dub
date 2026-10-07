import { fs, path } from "./rt";
import { dub, editOnly, prepare, remix, render, separateVoices, type Meta, type Opts } from "./pipeline";
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
  exported?: number; // the version output.mp4 was made at; older than `version` when the voices changed since
  // a background task that leaves the job as it is (the editor stays usable), e.g. separating voices from music
  task?: { name: "separate"; progress: number; message: string };
  taskError?: string;
  timings?: Record<string, number>; // seconds spent per stage
};

// Kept on globalThis so all route bundles (and dev hot reloads) share one queue.
// bg: separating voices from music in the background has its own lane - in the main queue a 2-hour film's
// separation (~20 min) kept "Generate Khmer voice" waiting with nothing to show, though the voice comes from
// Microsoft's servers and hardly needs this PC.
type Store = { jobs: Map<string, Job>; queue: Promise<void>; bg?: Promise<void> };
const g = globalThis as unknown as { __khmerDub?: Store };

function init(): Store {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const jobs = new Map<string, Job>();
  for (const id of fs.readdirSync(JOBS_DIR)) {
    const f = path.join(JOBS_DIR, id, "job.json");
    if (!fs.existsSync(f)) continue;
    const job: Job = JSON.parse(fs.readFileSync(f, "utf8"));
    job.task = undefined; // a background task does not survive a restart; it is started again when needed
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

/** Progress updates; also adds up how many seconds each stage took (job.timings). */
const reporter = (job: Job) => {
  let current = "", since = Date.now();
  job.timings ??= {};
  return (stage: string, frac: number, message: string) => {
    const now = Date.now();
    if (current) job.timings![current] = Math.round(((job.timings![current] ?? 0) + (now - since) / 1000) * 10) / 10;
    current = stage;
    since = now;
    Object.assign(job, { stage, progress: Math.round(frac * 1000) / 1000, message });
  };
};

function fail(job: Job, e: unknown) {
  console.error(e);
  Object.assign(job, { status: "error", error: e instanceof Error ? e.message : String(e), message: "Failed" });
  save(job);
}

/** Batch: the project goes on to the exported video by itself, once (afterwards it is edited like any other). */
async function autoExport(job: Job, report: ReturnType<typeof reporter>) {
  if (!job.opts.autoExport) return;
  job.opts.autoExport = false;
  await remix(jobDir(job.id), job.opts, job.meta!, report);
  report("done", 1, "Done");
  job.exported = job.version;
  Object.assign(job, { message: "Exported" });
  save(job);
}

async function runDub(job: Job) {
  try {
    Object.assign(job, { status: "running", error: undefined });
    save(job);
    const report = reporter(job);
    const warning = await dub(jobDir(job.id), job.opts, job.meta!, report);
    report("done", 1, "Done"); // closes the last stage's timing
    job.version = (job.version ?? 0) + 1;
    await autoExport(job, report);
    Object.assign(job, { status: "done", stage: "done", progress: 1, message: warning ?? (job.exported === job.version ? "Exported" : "Ready to edit and export") });
    save(job);
  } catch (e) { fail(job, e); }
}

async function runPrepare(job: Job) {
  try {
    job.status = "running";
    save(job);
    const report = reporter(job);
    job.meta = await prepare(jobDir(job.id), job.opts, report);
    report("review", 1, "");
    if (editOnly(job.opts)) { // nothing to voice: straight to the editor
      job.version = (job.version ?? 0) + 1;
      await autoExport(job, report);
      Object.assign(job, { status: "done", stage: "done", progress: 1, message: job.exported === job.version ? "Exported" : "Ready to edit" });
      save(job);
      return;
    }
    if (job.opts.review && !job.opts.autoExport) {
      Object.assign(job, { status: "review", stage: "review", progress: 1,
        message: "Check the Khmer translation, then generate the voice" });
      save(job);
      return;
    }
  } catch (e) { fail(job, e); return; }
  await runDub(job);
}

/** What a queued job waits for, in words (a long wait with only "Waiting in queue" looks like a freeze). */
function waiting(job: Job) {
  const ahead = [...jobs.values()].filter((j) => j !== job && (j.status === "running" || j.status === "queued"));
  const now = ahead.find((j) => j.status === "running");
  if (!now) return "Waiting in queue";
  const name = (now.meta?.title || now.title || "another video").slice(0, 40);
  return `Waiting for "${name}" (${now.message.slice(0, 40)})${ahead.length > 1 ? ` and ${ahead.length - 1} more` : ""}`;
}

// One heavy job at a time: whisper and ffmpeg already use every CPU core.
const enqueue = (fn: () => Promise<void>) => { store.queue = store.queue.then(fn, fn); };

export function startJob(job: Job) {
  jobs.set(job.id, job);
  save(job);
  enqueue(() => runPrepare(job));
}

/** The first step failed (e.g. the PC ran out of memory): run it again; a downloaded video is used again. */
export function retryPrepare(job: Job) {
  Object.assign(job, { status: "queued", stage: "queued", progress: 0, message: waiting(job), error: undefined });
  startJob(job);
}

/**
 * Rebuild only the video picture (new subtitle style, logo or format); voices and audio stay as they are.
 * With `sound`, the Khmer lines already made are also mixed again (new sound levels).
 */
export function startRender(job: Job, sound = false) {
  Object.assign(job, { status: "queued", stage: "queued", progress: 0, message: waiting(job), error: undefined });
  save(job);
  enqueue(async () => {
    try {
      Object.assign(job, { status: "running" });
      save(job);
      const report = reporter(job);
      await (sound ? remix : render)(jobDir(job.id), job.opts, job.meta!, report);
      report("done", 1, "Done");
      const version = (job.version ?? 0) + 1;
      Object.assign(job, { status: "done", stage: "done", progress: 1, message: "Exported", version, exported: version });
      save(job);
    } catch (e) { fail(job, e); }
  });
}

/** Separate the original voices from the music, without touching the job's state (the editor keeps working). */
export function startSeparate(job: Job) {
  if (job.task) return;
  Object.assign(job, { task: { name: "separate", progress: 0, message: "Waiting to separate voices from music" }, taskError: undefined });
  save(job);
  const lane = (fn: () => Promise<void>) => { store.bg = (store.bg ?? Promise.resolve()).then(fn, fn); };
  lane(async () => {
    try {
      await separateVoices(jobDir(job.id), job.meta!, (_stage, progress, message) => (job.task = { name: "separate", progress, message }));
    } catch (e) {
      console.error(e);
      job.taskError = e instanceof Error ? e.message : String(e);
    } finally {
      job.task = undefined;
      save(job);
    }
  });
}

export function startDub(job: Job) {
  Object.assign(job, { status: "queued", stage: "queued", progress: 0, message: waiting(job), error: undefined });
  save(job);
  enqueue(() => runDub(job));
}
