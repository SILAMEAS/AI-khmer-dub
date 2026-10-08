"use client";

/**
 * The editor, laid out like CapCut: tools on the left, the player in the middle, settings on the right and the
 * timeline below. Every setting shows live in the player; only Export merges the layers into one video.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api, ApiError, clock, DEFAULT_EDIT, DEFAULT_MIX, fullEdit, fullMix, makePlayhead, parseTime, uploadFile, usePlayhead, type EditOpts,
  type Job, type Mix, type Playhead, type Segment, type Voice, type VoiceChoice,
} from "./editor/common";
import {
  addCuts, Batch, CutList, DEFAULT_THUMB, EditPanel, Glossary, StickerLibrary, StickerSettings, ThumbnailMaker, ThumbnailStyle,
  TimeField, type Marks, type Thumb,
} from "./editor/tools";
import {
  AdjustPanel, CoverPanel, DEFAULT_LOOK, ExtrasPanel, FilterGallery, FormatPanel, fullLook, LogoPanel, rememberLook, savedLook,
  SubtitleStylePanel, TitlePanel, useBranding, type Look,
} from "./editor/look";
import { SoundShaping, SoundSources, useLiveAudio } from "./editor/sound";
import { Player } from "./editor/Player";
import { Timeline } from "./editor/Timeline";
import { LinkBox } from "./editor/link";

type Tab = "media" | "edit" | "voice" | "captions" | "text" | "stickers" | "filters" | "effects" | "audio" | "logo" | "thumb" | "export";
const TABS: [Tab, string, string][] = [
  ["media", "📁", "Media"], ["edit", "✂", "Edit"], ["voice", "🗣", "Voice"], ["captions", "💬", "Captions"], ["text", "T", "Text"],
  ["stickers", "😀", "Stickers"], ["filters", "🎨", "Filters"], ["effects", "✨", "Effects"], ["audio", "🎵", "Audio"],
  ["logo", "🏷", "Logo"], ["thumb", "📸", "Thumbnail"], ["export", "⬆", "Export"],
];
/** Tabs about the voice and subtitles: not for a project that is only edited. */
const DUB_TABS: Tab[] = ["voice", "captions"];
const STEPS: [string, string][] = [
  ["download", "Download"], ["extract", "Audio"], ["transcribe", "Speech→text"], ["separate", "Voices/music"], ["analyze", "Speakers"],
  ["translate", "Translate"], ["review", "Review"], ["tts", "Khmer voice"], ["clone", "Clone voices"], ["mix", "Mix"], ["mux", "Video"], ["done", "Done"],
];
const DOWNLOADS: [string, string, string][] = [
  ["output.mp4", "🎬 Video", "MP4 + subtitle track"],
  ["km.srt", "📝 Khmer subtitles", ".srt"],
  ["bilingual.srt", "📝 Khmer + original", ".srt"],
  ["original.srt", "📝 Original subtitles", ".srt"],
  ["dub_audio.m4a", "🔊 Khmer audio", ".m4a"],
];
const CARDS: Record<VoiceChoice, [string, string, string, string]> = {
  clone: ["clone", "🧬", "Original voices", "Each person keeps their own voice"],
  auto: ["auto", "🎭", "Auto", "Boy or girl, like each speaker"],
  male: ["boy", "👦", "Boy", "Piseth"],
  female: ["girl", "👧", "Girl", "Sreymom"],
};
const KM_LABEL: Record<VoiceChoice, string> = { clone: "សំឡេងដើម", auto: "ស្វ័យប្រវត្តិ", male: "ប្រុស", female: "ស្រី" };
const PREFS = "khmerDubPrefs", LAYOUT = "khmerDubLayout";

/** Sizes of the resizable parts (pixels): left panel, right panel, timeline. */
type Sizes = { left: number; right: number; bottom: number };
const SIZES: Sizes = { left: 300, right: 320, bottom: 210 };
const fitSizes = (s: Sizes): Sizes => ({
  left: Math.round(Math.min(640, Math.max(200, s.left))),
  right: Math.round(Math.min(640, Math.max(240, s.right))),
  bottom: Math.round(Math.min(Math.max(140, (typeof window === "undefined" ? 900 : window.innerHeight) - 52 - 180), Math.max(110, s.bottom))),
});

function VoiceCard({ v, on, onPick, rate, off }: { v: VoiceChoice; on: boolean; onPick: () => void; rate: number; off?: string }) {
  const [cls, icon, name, sub] = CARDS[v];
  return (
    <div className={`voice ${cls} ${on ? "on" : ""} ${off ? "off" : ""}`} role="radio" aria-checked={on} aria-disabled={!!off}
      tabIndex={0} title={off} onClick={() => !off && onPick()} onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault(); e.stopPropagation(); // Space picks the voice; it must not also start the video
        if (!off) onPick();
      }}>
      <div className="av">{icon}</div>
      <div><b>{name}</b> <span className="km">{KM_LABEL[v]}</span><small>{off || sub}</small></div>
      {(v === "male" || v === "female") && (
        <button type="button" className="btn ghost sm play" onClick={(e) => { e.stopPropagation(); playSample(`/api/voices/preview?voice=${v}&rate=${rate}`); }}>▶</button>
      )}
    </div>
  );
}

/** Plays a short sample; one that can't be played (not made yet, server gone) is simply not heard. */
const playSample = (url: string) => { new Audio(url).play().catch(() => {}); };

/** Shows a part with the playhead's time: only that part is drawn again while the video plays, not the editor. */
function AtPlayhead({ playhead, children }: { playhead: Playhead; children: (t: number) => React.ReactNode }) {
  return <>{children(usePlayhead(playhead))}</>;
}

// ---------------------------------------------------------------- captions list
// A long video has thousands of lines: only the ones near what is visible are in the page (plus the selected one,
// so the line being typed in keeps its focus). Rows grow with their text, so each is measured once drawn; the
// ones not drawn yet count as the first rows' average height.
const CAP_GAP = 4, CAP_EST = 50, CAP_MORE = 600; // px between rows, a first guess of a row's height, px drawn beyond the view

/** One line in the captions list; drawn again only when it changes itself, not when another line is typed in. */
const CapRow = memo(function CapRow({ s, i, top, on, hit, edited, onPick, onText }: {
  s: Segment; i: number; top: number; on: boolean; hit: boolean; edited: boolean;
  onPick: (i: number, t: number) => void; onText: (i: number, km: string) => void;
}) {
  return (
    <div data-i={i} className={`cap ${on ? "on" : ""} ${hit ? "hit" : ""}`} style={{ top }} onClick={() => onPick(i, s.start)}>
      <span className="cap-t">{clock(s.start)}{edited && <i className="dot" />}</span>
      <textarea className="km" rows={1} value={s.km} onChange={(e) => onText(i, e.target.value)} onFocus={() => onPick(i, s.start)} />
    </div>
  );
});

function CapList({ segs, selected, find, edited, onPick, onText }: {
  segs: Segment[]; selected: number | null; find: string; edited: Set<number>;
  onPick: (i: number, t: number) => void; onText: (i: number, km: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const heights = useRef<number[]>([]); // each row's measured height with the gap below it (0 = not drawn yet)
  const guess = useRef(0); // height of a row not drawn yet; set once, so rows far away don't move later
  if (heights.current.length !== segs.length) { heights.current = new Array(segs.length).fill(0); guess.current = 0; }
  const [, setMeasured] = useState(0);
  const [view, setView] = useState({ top: 0, h: 600 });
  const want = useRef<number | null>(null); // a line to scroll into view, once the rows around it are measured

  // where each row starts (the last entry is the whole height)
  const hs = heights.current;
  const est = guess.current || CAP_EST;
  const tops = new Array<number>(segs.length + 1);
  tops[0] = 0;
  for (let i = 0; i < segs.length; i++) tops[i + 1] = tops[i] + (hs[i] || est);
  const topsRef = useRef(tops);
  topsRef.current = tops;

  // the rows to draw: the visible ones and some more above and below (found by halving, the list can be long)
  const firstEnding = (y: number) => {
    let lo = 0, hi = segs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tops[m + 1] <= y) lo = m + 1; else hi = m; }
    return lo;
  };
  const from = firstEnding(view.top - CAP_MORE), to = Math.min(segs.length, firstEnding(view.top + view.h + CAP_MORE) + 1);
  const rows: number[] = [];
  for (let i = from; i < to; i++) rows.push(i);
  if (selected !== null && selected < segs.length && (selected < from || selected >= to)) rows.push(selected);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the selected line is to scroll into view (also when the list opens with one selected)
  useLayoutEffect(() => { want.current = selected; }, [selected]);

  // measure the rows just drawn; a row above the view that turns out taller or shorter moves the scroll by as much,
  // so what you are looking at stays put
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hs = heights.current, tops = topsRef.current;
    let changed = false, shift = 0;
    el.querySelectorAll<HTMLElement>("[data-i]").forEach((row) => {
      const i = +row.dataset.i!, h = row.offsetHeight + CAP_GAP, old = hs[i] || est;
      if (hs[i] && Math.abs(h - old) < 0.5) return;
      if (tops[i] < el.scrollTop) shift += h - old;
      hs[i] = h;
      changed = true;
    });
    if (!guess.current && changed) { // the first rows drawn give the guess for all the others
      let sum = 0, n = 0, above = 0;
      hs.forEach((h, i) => { if (h) { sum += h; n++; } else if (tops[i + 1] <= el.scrollTop) above++; });
      guess.current = sum / n;
      shift += above * (guess.current - est);
    }
    if (shift) el.scrollTop += shift;
    if (changed) { setMeasured((k) => k + 1); return; }
    // all measured: now the selected line can be scrolled to (as little as needed)
    const sel = want.current;
    want.current = null;
    if (sel === null || sel >= segs.length) return;
    const a = tops[sel], b = tops[sel + 1] - CAP_GAP;
    if (a < el.scrollTop) el.scrollTop = a;
    else if (b > el.scrollTop + el.clientHeight) el.scrollTop = b - el.clientHeight;
  });

  return (
    <div className="cap-list" ref={ref} onScroll={(e) => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
      <div className="cap-win" style={{ height: tops[segs.length] }}>
        {rows.map((i) => (
          <CapRow key={i} s={segs[i]} i={i} top={tops[i]} on={selected === i} hit={!!find && segs[i].km.includes(find)}
            edited={edited.has(i)} onPick={onPick} onText={onText} />
        ))}
      </div>
    </div>
  );
}

export default function Studio() {
  // ---------------------------------------------------------------- project and job
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [history, setHistory] = useState<Job[]>([]);
  const [canClone, setCanClone] = useState(false);

  // new project: the video to dub (or only to edit), from a file, a link or many at once
  const [mode, setMode] = useState<"file" | "url" | "batch">("file");
  const [projectMode, setProjectMode] = useState<"dub" | "edit">("dub");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [quality, setQuality] = useState("best");
  const [review, setReview] = useState(true);
  const [trim, setTrim] = useState({ from: 0, to: 0 });
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // the settings being edited (live in the player); voice changes are sent by themselves, the rest on Export
  const [voice, setVoice] = useState<VoiceChoice>("auto");
  const [match, setMatch] = useState(true);
  const [rate, setRate] = useState(0);
  const [bgMode, setBgMode] = useState<"duck" | "none">("duck");
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [mix, setMix] = useState<Mix>(DEFAULT_MIX);
  // this video's edits: parts cut out, speed, stickers (per project, never carried to the next one)
  const [edit, setEdit] = useState<EditOpts>(DEFAULT_EDIT);
  const [marks, setMarks] = useState<Marks>({ in: null, out: null });
  const [selectedCut, setSelectedCut] = useState<number | null>(null);
  const [selectedSticker, setSelectedSticker] = useState<string | null>(null);
  const [thumb, setThumb] = useState<Thumb>(DEFAULT_THUMB);

  // lines
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [baseSegs, setBaseSegs] = useState<Segment[] | null>(null); // as last saved, to see what was edited
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);
  const [find, setFind] = useState(""), [replaceWith, setReplaceWith] = useState("");

  // editor
  const [tab, setTab] = useState<Tab>("media");
  const [view, setView] = useState<"edit" | "final">("edit");
  // the playhead's time is not state here: it changes 15 times a second while playing, and drawing the whole
  // editor again each time is far too slow for a long video. The parts that show it listen to it themselves.
  const [playhead] = useState(makePlayhead);
  const [duration, setDuration] = useState(0);
  const [pendingExport, setPendingExport] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopAt = useRef<number | null>(null);
  const { brand, reload } = useBranding();

  // the panels and the timeline can be resized by dragging their edges; the sizes are remembered
  const [sizes, setSizes] = useState<Sizes>(SIZES);
  const [dragging, setDragging] = useState<keyof Sizes | null>(null);
  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem(LAYOUT) || "null"); if (s) setSizes(fitSizes({ ...SIZES, ...s })); } catch {}
  }, []);
  const saveSizes = (s: Sizes) => { try { localStorage.setItem(LAYOUT, JSON.stringify(s)); } catch {} };
  function resize(e: React.PointerEvent, which: keyof Sizes) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, start = sizes;
    let now = start;
    setDragging(which);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      now = fitSizes({ ...start, [which]: which === "left" ? start.left + dx : which === "right" ? start.right - dx : start.bottom - dy });
      setSizes(now);
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setDragging(null); saveSizes(now);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const resetSize = (which: keyof Sizes) => { const s = { ...sizes, [which]: SIZES[which] }; setSizes(s); saveSizes(s); };
  const handle = (which: keyof Sizes) => (
    <div className={`rz rz-${which} ${dragging === which ? "on" : ""}`} onPointerDown={(e) => resize(e, which)}
      onDoubleClick={() => resetSize(which)} title="Drag to resize · double-click to reset" />
  );

  // ---------------------------------------------------------------- loading
  const loadHistory = useCallback(() => { api<Job[]>("/api/jobs").then(setHistory).catch(() => {}); }, []);
  const openJob = useCallback((id: string | null) => {
    setJobId(id); setJob(null); setSegs(null); setBaseSegs(null); setSelected(null); setSelectedPart(null);
    setEdit(DEFAULT_EDIT); setMarks({ in: null, out: null }); setSelectedCut(null); setSelectedSticker(null);
    setView("edit"); playhead.set(0); setPollKey((k) => k + 1); setErr("");
    try { id ? localStorage.setItem("khmerDubJob", id) : localStorage.removeItem("khmerDubJob"); } catch {}
  }, [playhead]);

  useEffect(() => {
    setLook(savedLook());
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) || "null");
      if (p) { setMix(fullMix(p.mix)); setBgMode(p.bgMode === "none" ? "none" : "duck"); setRate(p.rate ?? 0); setMatch(p.match !== false); }
    } catch {}
    api<{ clone: boolean }>("/api/capabilities").then((c) => { setCanClone(c.clone); }).catch(() => {});
    loadHistory();
    // a project opened by its link, optionally at a tool and a moment: ?job=<id>&tab=filters&t=30
    const q = new URLSearchParams(location.search), linked = q.get("job");
    if (TABS.some(([k]) => k === q.get("tab"))) setTab(q.get("tab") as Tab);
    if (q.get("t")) startAt.current = parseTime(q.get("t")!) || 0;
    if (linked) openJob(linked);
    else try { const saved = localStorage.getItem("khmerDubJob"); if (saved) openJob(saved); } catch {}
  }, [loadHistory, openJob]);

  // remember the look and sound for the next new project
  useEffect(() => { if (!jobId) rememberLook(look); }, [look, jobId]);
  useEffect(() => {
    if (jobId) return;
    try { localStorage.setItem(PREFS, JSON.stringify({ mix, bgMode, rate, match })); } catch {}
  }, [mix, bgMode, rate, match, jobId]);

  useEffect(() => {
    if (!file) { setFileUrl(null); return; }
    const u = URL.createObjectURL(file);
    setFileUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // poll the job while it works
  useEffect(() => {
    if (!jobId) return;
    let stop = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/api/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running" || j.task) timer = setTimeout(tick, 1200);
        else loadHistory();
      } catch (e) {
        if (stop) return;
        // only a project that is gone is closed; a network blip or a restarting server is tried again
        if (e instanceof ApiError && e.status === 404) openJob(null);
        else timer = setTimeout(tick, 3000);
      }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId, pollKey, loadHistory, openJob]);

  // a job that is ready: its settings and lines come into the editor
  const ready = job && (job.status === "review" || job.status === "done");
  const jobVersion = `${job?.id}:${job?.version ?? 0}:${job?.status}`;
  // The project's saved settings come into the editor once, when it is opened. After that the editor is what
  // counts: a job finishing in the background (new voices, an export) never undoes what you changed meanwhile.
  const [synced, setSynced] = useState(""); // id of the project whose settings are in the editor
  useEffect(() => setSynced(""), [jobId]);
  const sentSegs = useRef<Segment[] | null>(null); // the lines as last sent to be voiced
  const baseRef = useRef<Segment[] | null>(null);
  const openId = useRef(jobId); // the project open now (a late answer for another one is ignored)
  openId.current = jobId;
  useEffect(() => { sentSegs.current = null; baseRef.current = null; }, [jobId]);
  useEffect(() => {
    if (!job || !ready) return;
    const first = synced !== job.id;
    if (first) {
      setVoice(job.opts.voice); setMatch(job.opts.match !== false); setRate(job.opts.rate ?? 0); setBgMode(job.opts.bgMode);
      setLook(fullLook(job.opts)); setMix(fullMix(job.opts.mix)); setEdit(fullEdit(job.opts.edit));
      setSynced(job.id);
    }
    api<Segment[]>(`/api/jobs/${job.id}/segments`).then((saved) => {
      if (openId.current !== job.id) return; // another project was opened meanwhile
      const before = sentSegs.current ?? baseRef.current;
      baseRef.current = saved;
      setBaseSegs(saved);
      setSegs((local) => {
        if (first || !local || !before || local.length !== saved.length) return saved;
        // a line changed since it was sent keeps your change; the others take what was saved
        const differs = (a: Segment, b: Segment) => a.km !== b.km || a.voice !== b.voice || a.speaker !== b.speaker;
        return saved.map((x, i) => (differs(local[i], before[i]) ? { ...x, km: local[i].km, voice: local[i].voice, speaker: local[i].speaker } : x));
      });
    }).catch(() => {});
  }, [jobVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- what changed
  const edited = useMemo(() => {
    const out = new Set<number>();
    segs?.forEach((s, i) => {
      const b = baseSegs?.[i];
      if (b && (b.km !== s.km || b.voice !== s.voice || b.speaker !== s.speaker)) out.add(i);
    });
    return out;
  }, [segs, baseSegs]);
  const clone = voice === "clone";
  const stemsWanted = (clone || mix.split) && bgMode === "duck";
  const voicesChanged = !!job && job.status === "done" && (edited.size > 0 || voice !== job.opts.voice
    || match !== (job.opts.match !== false) || rate !== (job.opts.rate ?? 0));
  // (only worked out again when the settings or the job change, not each time a line is typed in)
  const settingsNow = useMemo(() => JSON.stringify([look, mix, bgMode, edit]), [look, mix, bgMode, edit]);
  const settingsJob = useMemo(() => (job ? JSON.stringify([fullLook(job.opts), fullMix(job.opts.mix), job.opts.bgMode, fullEdit(job.opts.edit)]) : ""), [job]);
  const editOnly = job?.opts.mode === "edit";
  const exportCurrent = !!job?.tracks?.output && job.exported === job.version && !voicesChanged && settingsNow === settingsJob;
  const working = job?.status === "queued" || job?.status === "running";

  // removing the original voices needs them separated from the music: started by itself, in the background
  const separating = useRef(new Set<string>());
  const separateNow = useCallback(async (id: string) => {
    separating.current.add(id);
    try { await api(`/api/jobs/${id}/separate`, { method: "POST" }); } catch { /* shown through job.taskError */ }
    setPollKey((k) => k + 1);
  }, []);
  useEffect(() => {
    // only once the project's own settings are in the editor (not the defaults shown while it loads)
    if (!job?.meta || !ready || synced !== job.id || !canClone || !stemsWanted || job.tracks?.vocals || job.task
      || separating.current.has(job.id)) return;
    separateNow(job.id);
  }, [job?.id, job?.status, job?.task, job?.tracks?.vocals, stemsWanted, canClone, ready, synced, separateNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- actions
  const settingsBody = () => ({ voice, match, rate, bgMode, mix, edit, ...look });

  /** Settings of a new project, as sent with it (also for each project of a batch). */
  const newParams = (withTrim = true): Record<string, string> => ({
    sourceLang, quality, voice, match: String(match), rate: String(rate), bgMode, review: String(review), mode: projectMode,
    burn: String(look.burn), sub: JSON.stringify(look.sub), logo: JSON.stringify(look.logo), out: JSON.stringify(look.out),
    fx: JSON.stringify(look.fx),
    // only edited: the video's own sound at full level (nothing to remove for a Khmer voice)
    mix: JSON.stringify(projectMode === "edit" ? { ...mix, music: 100, split: false } : mix),
    ...(withTrim && { trim: JSON.stringify(trim) }),
  });

  async function start() {
    setErr("");
    if (trim.to && trim.to <= trim.from + 0.5) { setErr("The end of the cut must be after its start"); return; }
    const params = newParams();
    setBusy(true);
    try {
      let j: Job;
      if (mode === "file") {
        if (!file) throw new Error("Import a video first");
        setUploadPct(0);
        j = await uploadFile(file, params, setUploadPct);
      } else {
        if (!url.trim()) throw new Error("Paste a video link");
        j = await api<Job>("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, url: url.trim() }) });
      }
      setFile(null); setUrl(""); setTrim({ from: 0, to: 0 });
      openJob(j.id);
      loadHistory();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setUploadPct(null); }
  }

  /** Make the Khmer voices (only lines that changed are made again) and the layers for the preview. */
  const acting = useRef(false); // a request to start work is on its way: a second click does nothing
  async function makeVoices(auto = false) {
    if (!jobId || acting.current) return;
    acting.current = true;
    if (!auto) videoRef.current?.pause(); // made by itself: the video keeps playing
    const body: Record<string, unknown> = settingsBody();
    if (segs) body.segments = segs.map((s, i) => ({ i, km: s.km, voice: s.voice, speaker: s.speaker }));
    sentSegs.current = segs;
    try {
      await api(`/api/jobs/${jobId}/dub`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setPollKey((k) => k + 1);
    } catch (e) {
      setPendingExport(false); // no new voices: no export waiting for them
      if (auto) setErr((e as Error).message); else alert((e as Error).message);
    } finally { acting.current = false; }
  }

  // A changed voice, speed or "sound like the speaker" is applied by itself; edited lines too, once you stop
  // typing. Only what changed is made again, and the preview then plays the new voices.
  const voiceSettingsChanged = !!job && (voice !== job.opts.voice || match !== (job.opts.match !== false) || rate !== (job.opts.rate ?? 0));
  useEffect(() => {
    if (!job || job.status !== "done" || synced !== job.id || !voicesChanged || pendingExport) return;
    const t = setTimeout(() => makeVoices(true), voiceSettingsChanged ? 600 : 2000);
    return () => clearTimeout(t);
  }, [voice, match, rate, segs, job?.status, job?.version, synced]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Merge every layer into one video. Voices that changed are made first. */
  async function exportVideo() {
    if (!jobId) return;
    setTab("export");
    if (voicesChanged) { setPendingExport(true); await makeVoices(); return; }
    if (acting.current) return;
    acting.current = true;
    videoRef.current?.pause();
    try {
      await api(`/api/jobs/${jobId}/render`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...look, mix, bgMode, edit }) });
      setPollKey((k) => k + 1);
    } catch (e) { alert((e as Error).message); } finally { acting.current = false; }
  }
  useEffect(() => { // export asked for while the voices were being made
    // (also when the new lines arrive after the job: until then the old ones make the voices look changed)
    if (pendingExport && job?.status === "done" && !voicesChanged) { setPendingExport(false); exportVideo(); }
    if (pendingExport && job?.status === "error") setPendingExport(false);
  }, [job?.status, job?.version, voicesChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changes that are only in the editor (not yet sent with new voices or an export) are lost when the page
  // closes or another project opens: ask first.
  const unsaved = !!job && ready && synced === job.id && (edited.size > 0 || settingsNow !== settingsJob);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  const switchTo = (id: string | null) => {
    if (id === jobId) return;
    if (unsaved && !confirm("This project has changes that are not saved yet (they are saved when you make the voices or export). Leave it anyway?")) return;
    openJob(id);
  };

  /** The first step failed: run it again (a downloaded video is not downloaded twice). */
  async function retryFirstStep() {
    if (!jobId) return;
    try { await api(`/api/jobs/${jobId}/retry`, { method: "POST" }); setPollKey((k) => k + 1); } catch (e) { alert((e as Error).message); }
  }

  async function removeJob(id: string) {
    if (!confirm("Delete this project and all its files?")) return;
    try { await api(`/api/jobs/${id}`, { method: "DELETE" }); if (id === jobId) openJob(null); loadHistory(); } catch (e) { alert((e as Error).message); }
  }

  // ---------------------------------------------------------------- player
  const base = job ? `/api/jobs/${job.id}/files/` : "";
  const v = job?.version ?? 0;
  const src = job?.meta ? `${base}source` : mode === "file" ? fileUrl : null;
  const finalSrc = job?.tracks?.output ? `${base}output.mp4?v=${v}` : null;
  const audio = useLiveAudio({
    video: videoRef, segs, mix, bgMode, stems: stemsWanted, enabled: view === "edit",
    urls: {
      voice: job?.tracks?.voice ? `${base}voice_track.m4a?v=${v}` : undefined,
      vocals: job?.tracks?.vocals && stemsWanted ? `${base}vocals.wav` : undefined,
      background: job?.tracks?.vocals && stemsWanted ? `${base}background.wav` : undefined,
      bgm: mix.bgm && brand?.music ? brand.music.url : undefined,
    },
  });
  const seek = useCallback((t: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = Math.max(0, Math.min(t, el.duration || t));
    playhead.set(t);
  }, [playhead]);
  const playRange = (a: number, b: number) => {
    const el = videoRef.current;
    if (!el) return;
    audio.start(); el.currentTime = a; stopAt.current = b; el.play().catch(() => {});
  };
  const onTime = useCallback((t: number) => {
    playhead.set(t);
    if (stopAt.current !== null && t >= stopAt.current) { stopAt.current = null; videoRef.current?.pause(); }
  }, [playhead]);
  const startAt = useRef<number | null>(null);
  const onDuration = useCallback((d: number) => {
    setDuration(d);
    if (startAt.current !== null && videoRef.current) { videoRef.current.currentTime = startAt.current; startAt.current = null; }
  }, []);
  // ---------------------------------------------------------------- undo / redo
  // Every change to the lines, look, sound or edits is a step; quick changes in a row (typing, dragging a slider)
  // count as one. A project's history starts when it is opened.
  type Snap = { segs: Segment[] | null; look: Look; mix: Mix; edit: EditOpts };
  const hist = useRef<{ past: Snap[]; future: Snap[]; last: Snap | null; at: number; restoring: boolean; key: string }>(
    { past: [], future: [], last: null, at: 0, restoring: false, key: "" });
  const [, setHistTick] = useState(0);
  useEffect(() => {
    const h = hist.current, now: Snap = { segs, look, mix, edit };
    const key = `${jobId}:${synced}`;
    // a project opened, or its lines just arrived from the server: that is where its history starts
    if (h.key !== key || !h.last || (!h.last.segs && segs)) {
      Object.assign(h, { past: [], future: [], last: now, key, restoring: false }); setHistTick((n) => n + 1); return;
    }
    if (h.restoring) { h.restoring = false; h.last = now; return; }
    if (Date.now() - h.at > 700) { h.past.push(h.last); if (h.past.length > 100) h.past.shift(); }
    h.at = Date.now(); h.last = now; h.future = [];
    setHistTick((n) => n + 1);
  }, [segs, look, mix, edit, jobId, synced]);
  const restore = (s: Snap) => { hist.current.restoring = true; setSegs(s.segs); setLook(s.look); setMix(s.mix); setEdit(s.edit); setHistTick((n) => n + 1); };
  const undo = () => {
    const h = hist.current;
    if (!h.past.length || !h.last) return;
    h.future.push(h.last); h.at = 0;
    restore(h.past.pop()!);
  };
  const redo = () => {
    const h = hist.current;
    if (!h.future.length || !h.last) return;
    h.past.push(h.last); h.at = 0;
    restore(h.future.pop()!);
  };

  /** Cut out the part between the In and Out marks (ripple delete). */
  const cutMarked = () => {
    if (marks.in === null || marks.out === null || marks.out <= marks.in + 0.05) return false;
    setEdit((e) => addCuts(e, [{ from: marks.in!, to: marks.out! }]));
    setMarks({ in: null, out: null });
    return true;
  };

  // keys: space play / pause, I / O mark, Delete cut out (or put the selected cut back / remove the selected sticker),
  // Ctrl+Z / Ctrl+Y undo / redo - not while typing in a field (it has its own undo)
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const el = videoRef.current;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "y")) {
      e.preventDefault();
      if (k === "y" || e.shiftKey) redo(); else undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || tag === "BUTTON" && e.code === "Space") return;
    if (e.code === "Space" && el) {
      e.preventDefault();
      if (el.paused) { audio.start(); el.play().catch(() => {}); } else el.pause();
    } else if (k === "i" && el) setMarks((m) => ({ ...m, in: el.currentTime }));
    else if (k === "o" && el) setMarks((m) => ({ ...m, out: el.currentTime }));
    else if (e.key === "Delete" || e.key === "Backspace") {
      if (cutMarked()) { e.preventDefault(); return; }
      if (selectedSticker) { setEdit((x) => ({ ...x, stickers: x.stickers.filter((s) => s.id !== selectedSticker) })); setSelectedSticker(null); }
      else if (selectedCut !== null) { setEdit((x) => ({ ...x, cuts: x.cuts.filter((_, i) => i !== selectedCut) })); setSelectedCut(null); }
      else return;
      e.preventDefault();
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // a cut is selected by its place in the list: once the list changes (merged, sorted, undone) that may be another cut
  useEffect(() => setSelectedCut(null), [edit.cuts]);

  // ---------------------------------------------------------------- lines
  const speakers = clone ? job?.meta?.speakers ?? 0 : 0;
  // (the same functions every time, so the lines in the list and the timeline that didn't change aren't drawn again)
  const setLine = useCallback((i: number, p: Partial<Segment>) => setSegs((ss) => ss && ss.map((x, k) => (k === i ? { ...x, ...p } : x))), []);
  const setLineText = useCallback((i: number, km: string) => setLine(i, { km }), [setLine]);
  const pickLine = useCallback((i: number, t: number) => { setSelected(i); seek(t); }, [seek]);
  const hits = useMemo(() => (find && segs ? segs.filter((x) => x.km.includes(find)).length : 0), [find, segs]);
  // clicked in the timeline or on the picture: selected, and its tool opened
  const pickLineInTimeline = useCallback((i: number | null) => {
    setSelected(i);
    if (i !== null) setTab((t) => (t === "voice" ? t : "captions"));
  }, []);
  const pickPart = useCallback((i: number | null) => { setSelectedPart(i); setTab("audio"); }, []);
  const pickCut = useCallback((i: number | null) => { setSelectedCut(i); setTab("edit"); }, []);
  const pickSticker = useCallback((id: string | null) => { setSelectedSticker(id); setTab("stickers"); }, []);
  const pickStickerOnPicture = useCallback((id: string | null) => { setSelectedSticker(id); if (id) setTab("stickers"); }, []);

  // ---------------------------------------------------------------- panels
  const lookProps = { value: look, onChange: setLook };
  const lineEditor = segs && selected !== null && segs[selected] && (() => {
    const s = segs[selected], i = selected;
    return (
      <div className="pane">
        <div className="row between">
          <h4>Line {i + 1} <span className="note">{clock(s.start, true)} – {clock(s.end, true)}</span></h4>
          <button type="button" className="btn ghost sm" onClick={() => setSelected(null)}>✕</button>
        </div>
        <div className="row">
          <button type="button" className="btn ghost sm" onClick={() => playRange(Math.max(0, s.start - 0.1), s.end + 0.2)}>▶ Play line</button>
          <button type="button" className="btn ghost sm" disabled={i === 0} onClick={() => { setSelected(i - 1); seek(segs[i - 1].start); }}>↑ Previous</button>
          <button type="button" className="btn ghost sm" disabled={i === segs.length - 1} onClick={() => { setSelected(i + 1); seek(segs[i + 1].start); }}>↓ Next</button>
        </div>
        <label className="f">Original</label>
        <div className="orig-text">{s.text}</div>
        <label className="f">Khmer</label>
        <textarea className="km" rows={4} value={s.km} onChange={(e) => setLine(i, { km: e.target.value })} />
        {speakers > 0 && (
          <label className="f">Who says it
            <select value={s.speaker ?? 0} onChange={(e) => setLine(i, { speaker: +e.target.value })}>
              {Array.from({ length: speakers }, (_, k) => <option key={k} value={k}>Person {k + 1}</option>)}
            </select>
          </label>
        )}
        {voice === "auto" && s.voice && (
          <div className="seg-btns">
            {(["male", "female"] as Voice[]).map((g) => (
              <button type="button" key={g} className={s.voice === g ? "on" : ""} onClick={() => setLine(i, { voice: g })}>{g === "male" ? "👦 Boy" : "👧 Girl"}</button>
            ))}
          </div>
        )}
        <small className="note">The subtitle changes live. {job?.status === "done" ? "The voice for an edited line is made by itself 2 s after you stop typing (only that line)." : ""} An empty line is not dubbed.</small>
      </div>
    );
  })();

  const left = (() => {
    switch (tab) {
      case "media": return (
        <div className="pane">
          {job ? (
            <div className="project-card">
              <b>{job.meta?.title || job.title}</b>
              <small>{!job.meta ? job.message : editOnly ? `${clock(job.meta.duration)} · ✂ edit only`
                : `${clock(job.meta.duration)} · ${job.meta.language} · ${job.meta.segments} lines${job.meta.captions ? " · from subtitles" : ""}`}</small>
              <button type="button" className="btn ghost sm" onClick={() => switchTo(null)}>+ New project</button>
            </div>
          ) : (
            <>
              <div className="seg-btns big">
                <button type="button" className={projectMode === "dub" ? "on" : ""} onClick={() => setProjectMode("dub")}>🎙 Dub to Khmer</button>
                <button type="button" className={projectMode === "edit" ? "on" : ""} onClick={() => setProjectMode("edit")}>✂ Edit only</button>
              </div>
              <small className="note">{projectMode === "dub" ? "Speech recognised, translated and voiced in Khmer – then edit."
                : "Like CapCut: cut, speed, effects, text, stickers, sound and export – the video keeps its own sound."}</small>
              <div className="seg-btns">
                <button type="button" className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>Upload file</button>
                <button type="button" className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>Video link</button>
                <button type="button" className={mode === "batch" ? "on" : ""} onClick={() => setMode("batch")} title="Many videos one after the other">Batch</button>
              </div>
              {mode === "batch" ? (
                <Batch params={newParams(false)} onDone={() => loadHistory()} />
              ) : mode === "file" ? (
                <button type="button" className="import" onClick={() => fileInput.current?.click()}>
                  {file ? <><b>{file.name}</b><small>{(file.size / 1048576).toFixed(1)} MB · click to change</small></> : <><b>＋ Import video</b><small>MP4, MKV, MOV, AVI, WEBM…</small></>}
                </button>
              ) : (
                <LinkBox value={url} onChange={setUrl} size={look.out.size || 1080} />
              )}
              <input ref={fileInput} type="file" accept="video/*,.mkv,.ts" hidden onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
              {projectMode === "dub" && (
                <>
                  <label className="f">Original language</label>
                  <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                    <option value="auto">Auto detect</option><option value="zh">Chinese 中文</option><option value="en">English</option>
                  </select>
                  <label className="f">Recognition quality</label>
                  <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                    <option value="best">Best (large-v3-turbo)</option><option value="balanced">Balanced (medium)</option><option value="fast">Fast (small)</option>
                  </select>
                  {mode !== "batch" && <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                    <span>Check the translation first<small>Stop before the voices are made</small></span></label>}
                </>
              )}
            </>
          )}
          <h4>Projects</h4>
          <div className="projects">
            {history.length === 0 && <span className="note">None yet</span>}
            {history.map((h) => (
              <div key={h.id} className={`proj ${h.id === jobId ? "on" : ""}`}>
                <button type="button" onClick={() => switchTo(h.id)}>
                  <span>{h.meta?.title || h.title || h.id}</span>
                  <small>{h.meta ? `${clock(h.meta.duration)} · ` : ""}{h.status === "done" ? "ready" : h.status}</small>
                </button>
                {h.status !== "queued" && h.status !== "running" && <button type="button" className="del" title="Delete" onClick={() => removeJob(h.id)}>✕</button>}
              </div>
            ))}
          </div>
        </div>
      );
      case "edit": return (
        <AtPlayhead playhead={playhead}>{(time) => (
          <EditPanel value={edit} onChange={setEdit} time={time} duration={duration || job?.meta?.duration || 0} marks={marks} onMarks={setMarks}
            segs={segs} jobId={job?.meta ? job.id : undefined} />
        )}</AtPlayhead>
      );
      case "stickers": return (
        <AtPlayhead playhead={playhead}>{(time) => (
          <StickerLibrary value={edit} onChange={setEdit} time={time} duration={duration || job?.meta?.duration || 0}
            onSelect={(id) => { setSelectedSticker(id); }} />
        )}</AtPlayhead>
      );
      case "thumb": return <ThumbnailStyle value={thumb} onChange={setThumb} hasLogo={!!brand?.logo} />;
      case "voice": return editOnly ? (
        <div className="pane"><small className="note">This project is only edited – it has no Khmer voice. To dub a video, start a new project with 🎙 Dub to Khmer.</small></div>
      ) : (
        <div className="pane">
          <div className="voices col">
            {(["clone", "auto", "male", "female"] as const).map((c) => (
              <VoiceCard key={c} v={c} on={voice === c} onPick={() => setVoice(c)} rate={rate}
                off={c === "clone" && !canClone ? "Not installed: npm run setup" : undefined} />
            ))}
          </div>
          <label className="slider-row"><span>Speaking speed</span>
            <input type="range" min={-30} max={40} step={5} value={rate} onChange={(e) => setRate(+e.target.value)} /><b>{rate > 0 ? "+" : ""}{rate}%</b></label>
          <label className="check"><input type="checkbox" checked={match} onChange={(e) => setMatch(e.target.checked)} />
            <span>Sound like the original speaker<small>Follow each person&apos;s pitch and loudness</small></span></label>
          {speakers > 0 && segs && (
            <>
              <h4>Voices found</h4>
              <div className="people">
                {Array.from({ length: speakers }, (_, k) => (
                  <button key={k} type="button" className={`btn ghost sm spk s${k % 6}`} onClick={() => playSample(`${base}speaker_${k + 1}.wav`)}>
                    ▶ Person {k + 1} <small>({segs.filter((x) => x.speaker === k).length})</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      );
      case "captions": return (
        <div className="pane fill">
          {editOnly ? <small className="note">This project is only edited, so it has no subtitles. Use T Text for words on the picture.</small>
          : !segs ? <><small className="note">The lines appear here once the speech is recognised. Style them on the right – the player shows a sample.</small>
            <Glossary segs={null} onSegs={() => {}} /></> : (
            <>
              <div className="findbar">
                <input type="text" className="km" value={find} placeholder="Find in Khmer…" onChange={(e) => setFind(e.target.value)} />
                <div className="row nowrap">
                  <input type="text" className="km" value={replaceWith} placeholder="Replace with…" onChange={(e) => setReplaceWith(e.target.value)} />
                  <button type="button" className="btn ghost sm" disabled={!hits}
                    onClick={() => setSegs(segs.map((x) => ({ ...x, km: x.km.split(find).join(replaceWith) })))}>All ({hits})</button>
                </div>
                <Glossary segs={segs} onSegs={setSegs} />
              </div>
              <CapList segs={segs} selected={selected} find={find} edited={edited} onPick={pickLine} onText={setLineText} />
            </>
          )}
        </div>
      );
      case "text": return <TitlePanel {...lookProps} />;
      case "filters": return <FilterGallery {...lookProps} />;
      case "effects": return <CoverPanel {...lookProps} />;
      case "audio": return <SoundSources value={mix} onChange={setMix} bgMode={bgMode} onBgMode={setBgMode} canSplit={canClone} clone={clone}
        brand={brand} reload={reload} onRetry={() => job && separateNow(job.id)}
        stems={{ project: !!job?.meta, ready: !!job?.tracks?.vocals, task: job?.task, error: job?.taskError }} />;
      case "logo": return <LogoPanel {...lookProps} brand={brand} reload={reload} part="left" />;
      case "export": return <FormatPanel {...lookProps} />;
    }
  })();

  const right = (() => {
    if (lineEditor && (tab === "captions" || tab === "voice" || tab === "media")) return lineEditor;
    switch (tab) {
      case "media": return job ? (
        <div className="pane">
          <h4>Progress</h4>
          <div className="steps">
            {STEPS.filter(([k]) => (k !== "download" || job.opts.url) && (!editOnly || ["download", "extract", "mux", "done"].includes(k))).map(([k, label]) => {
              const i = STEPS.findIndex((x) => x[0] === k), cur = STEPS.findIndex((x) => x[0] === job.stage);
              return <span key={k} className={job.status === "done" || i < cur ? "done" : i === cur ? "cur" : ""}>{label}</span>;
            })}
          </div>
          {job.opts.trim && <small className="note">Cut: {clock(job.opts.trim.from)} – {job.opts.trim.to ? clock(job.opts.trim.to) : "end"}</small>}
          {job.status === "error" && <div className="err">{job.error}</div>}
        </div>
      ) : (
        <div className="pane">
          <h4>✂ Cut</h4>
          <small className="note">Dub only a part. Drag the white handles in the timeline, or type the times, or play and press the buttons.</small>
          <div className="row nowrap"><span className="lbl">From</span><TimeField value={trim.from} onChange={(t) => setTrim({ ...trim, from: t })} placeholder="0:00" />
            <button type="button" className="btn ghost sm" disabled={!src} onClick={() => setTrim({ ...trim, from: Math.floor(playhead.get() * 10) / 10 })}>⇤ Here</button></div>
          <div className="row nowrap"><span className="lbl">To</span><TimeField value={trim.to} onChange={(t) => setTrim({ ...trim, to: t })} placeholder="end" />
            <button type="button" className="btn ghost sm" disabled={!src} onClick={() => setTrim({ ...trim, to: Math.floor(playhead.get() * 10) / 10 })}>Here ⇥</button></div>
          {(trim.from > 0 || trim.to > 0) && <button type="button" className="btn ghost sm" onClick={() => setTrim({ from: 0, to: 0 })}>Whole video</button>}
        </div>
      );
      case "edit": return (
        <CutList value={edit} onChange={setEdit} selected={selectedCut} onSelect={setSelectedCut} onSeek={seek}
          onPlayFrom={(t) => { const el = videoRef.current; if (el) { audio.start(); el.currentTime = t; el.play().catch(() => {}); } }} />
      );
      case "stickers": return (
        <AtPlayhead playhead={playhead}>{(time) => (
          <StickerSettings value={edit} onChange={setEdit} id={selectedSticker} time={time} onDone={() => setSelectedSticker(null)} />
        )}</AtPlayhead>
      );
      case "thumb": return (
        <AtPlayhead playhead={playhead}>{(time) => (
          <ThumbnailMaker value={thumb} jobId={job?.meta ? job.id : undefined} time={time} sub={look.sub} version={v} />
        )}</AtPlayhead>
      );
      case "voice": return (
        <div className="pane">
          <h4>About the voice</h4>
          <small className="note">Change the voice, speed or “sound like the speaker” and the new voice is made by itself in a moment – only
            what changed – then the player uses it. No need to export. Sound levels and tone are on the 🎵 Audio tab and change live.</small>
        </div>
      );
      case "captions": case "text": return <SubtitleStylePanel {...lookProps} brand={brand} reload={reload} />;
      case "filters": return <AdjustPanel {...lookProps} />;
      case "effects": return <ExtrasPanel {...lookProps} />;
      case "audio": return (
        <AtPlayhead playhead={playhead}>{(time) => (
          <SoundShaping value={mix} onChange={setMix} split={clone || mix.split} now={time} selectedPart={selectedPart} onSelectPart={setSelectedPart} />
        )}</AtPlayhead>
      );
      case "logo": return <LogoPanel {...lookProps} brand={brand} reload={reload} part="right" />;
      case "export": return (
        <div className="pane">
          <h4>Export</h4>
          <small className="note">Merges the video{editOnly ? "" : ", Khmer voice"}, sound mix, {editOnly ? "" : "subtitles, "}text, stickers, logo, effects and cuts into one MP4 with the settings you see now.</small>
          <button type="button" className="btn wide" disabled={!job || job.status !== "done" || working} onClick={exportVideo}>
            {working && job?.stage === "mux" ? "Exporting…" : "⬆ Export video"}</button>
          {job?.tracks?.output && (
            <>
              <small className={exportCurrent ? "ok-note" : "note"}>{exportCurrent ? "✓ Up to date with your edits" : "Changed since the last export – export again to include the changes."}</small>
              <div className="downloads">
                {DOWNLOADS.filter(([f]) => !editOnly || f === "output.mp4").map(([f, t, s]) => <a key={f} href={`${base}${f}?download=1&v=${v}`}><b>{t}</b><small>{s}</small></a>)}
                {job.tracks.shapes?.map((a) => (
                  <a key={a} href={`${base}output_${a.replace(":", "x")}.mp4?download=1&v=${v}`}><b>🎬 Video {a}</b><small>same edit, other shape</small></a>
                ))}
                {job.tracks.thumbnail && <a href={`${base}thumbnail.jpg?download=1&v=${v}`}><b>📸 Thumbnail</b><small>.jpg</small></a>}
              </div>
            </>
          )}
        </div>
      );
    }
  })();

  // ---------------------------------------------------------------- top bar action
  let primary: React.ReactNode;
  if (!job) primary = mode === "batch" ? <span className="note">Start the batch on the left</span>
    : <button type="button" className="btn" disabled={busy} onClick={start}>{uploadPct !== null ? `Uploading ${uploadPct}%` : projectMode === "edit" ? "▶ Open in the editor" : "▶ Start dubbing"}</button>;
  else if (working) primary = <button type="button" className="btn" disabled>{Math.round(job.progress * 100)}% · {job.message.slice(0, 38)}</button>;
  else if (job.status === "review") primary = <button type="button" className="btn" onClick={() => makeVoices()}>🗣 Generate Khmer voice</button>;
  else if (job.status === "error") primary = <button type="button" className="btn" onClick={job.meta ? () => makeVoices() : retryFirstStep}>Try again</button>;
  else primary = (
    <>
      {voicesChanged && (
        <button type="button" className="btn ghost" onClick={() => makeVoices()} title="Voice changes are applied by themselves in a moment; this does it right now">
          🗣 Applying voice…{edited.size ? ` (${edited.size})` : ""}</button>
      )}
      <button type="button" className="btn" onClick={exportVideo}>{exportCurrent ? "✓ Exported" : "⬆ Export"}</button>
    </>
  );

  const placeholder = job ? (
    <div className="stage-msg">
      {job.status === "error" ? <><b>Something went wrong</b><div className="err">{job.error}</div></> : <>
        <b>{job.message || "Working…"}</b>
        <div className="bar"><i style={{ width: `${job.progress * 100}%` }} /></div>
        <small className="note">The video appears here as soon as it is ready.</small></>}
    </div>
  ) : mode === "file" ? (
    <button type="button" className="stage-drop" onClick={() => fileInput.current?.click()}
      onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); }}>
      <b>＋ Import a video</b><small>Drop a Chinese or English video here, or click to choose</small>
    </button>
  ) : (
    <div className="stage-msg"><b>Video from a link</b><small className="note">The preview appears after it is downloaded. Click Start dubbing.</small></div>
  );

  return (
    <div className={`studio ${dragging ? `resizing ${dragging === "bottom" ? "rows" : "cols"}` : ""}`}
      style={{ "--left-w": `${sizes.left}px`, "--right-w": `${sizes.right}px`, "--bottom-h": `${sizes.bottom}px` } as React.CSSProperties}>
      <header className="topbar">
        <div className="brand"><span className="logo km">ក</span> Khmer AI Dubber</div>
        <div className="project-name">{job ? job.meta?.title || job.title : file?.name || "New project"}
          {working && <span className="mini-bar"><i style={{ width: `${(job?.progress ?? 0) * 100}%` }} /></span>}
          {pendingExport && <small className="note"> · export follows</small>}
        </div>
        <div className="actions">
          {job && (
            <span className="undo">
              <button type="button" className="btn ghost sm" disabled={!hist.current.past.length} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
              <button type="button" className="btn ghost sm" disabled={!hist.current.future.length} onClick={redo} title="Redo (Ctrl+Y)">↷</button>
            </span>
          )}
          <span className="err">{err || (job?.status === "done" && job.message.startsWith("No Khmer voice") ? job.message : "")}</span>{primary}
        </div>
      </header>

      <nav className="rail">
        {TABS.filter(([k]) => !editOnly || !DUB_TABS.includes(k)).map(([k, icon, name]) => (
          <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}><span>{icon}</span>{name}</button>
        ))}
      </nav>
      <aside className="panel left"><div className="panel-title">{TABS.find((t) => t[0] === tab)![2]}</div>{left}</aside>

      <main className="center">
        <Player src={src} finalSrc={finalSrc} view={view} onView={setView} look={look} onLook={setLook} segs={segs}
          logoUrl={brand?.logo?.url ?? null} videoRef={videoRef} onPlay={audio.start} onTime={onTime} onDuration={onDuration}
          jobId={job?.meta ? job.id : undefined} placeholder={placeholder}
          edit={edit} onEdit={setEdit} selectedSticker={selectedSticker} onSelectSticker={pickStickerOnPicture} />
      </main>

      <aside className="panel right">
        <div className="panel-title">{lineEditor && (tab === "captions" || tab === "voice" || tab === "media") ? "Line" : "Settings"}</div>
        {right}
      </aside>

      {handle("left")}{handle("right")}{handle("bottom")}

      <footer className="bottom">
        <Timeline duration={duration || job?.meta?.duration || 0} playhead={playhead} onSeek={seek} segs={segs} edited={edited}
          selected={selected} onSelect={pickLineInTimeline}
          parts={mix.parts} selectedPart={selectedPart} onSelectPart={pickPart}
          trim={!job && src ? trim : null} onTrim={setTrim} speakers={speakers}
          cuts={edit.cuts} selectedCut={selectedCut} onSelectCut={pickCut} marks={marks}
          stickers={edit.stickers} selectedSticker={selectedSticker} onSelectSticker={pickSticker} />
      </footer>
    </div>
  );
}
