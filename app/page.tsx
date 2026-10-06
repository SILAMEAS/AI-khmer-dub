"use client";

/**
 * The editor, laid out like CapCut: tools on the left, the player in the middle, settings on the right and the
 * timeline below. Every setting shows live in the player; only Export merges the layers into one video.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, clock, DEFAULT_MIX, fullMix, parseTime, uploadFile, type Job, type Mix, type Segment, type Voice, type VoiceChoice,
} from "./editor/common";
import {
  AdjustPanel, CoverPanel, DEFAULT_LOOK, ExtrasPanel, FilterGallery, FormatPanel, fullLook, LogoPanel, rememberLook, savedLook,
  SubtitleStylePanel, TitlePanel, useBranding, type Look,
} from "./editor/look";
import { SoundShaping, SoundSources, useLiveAudio } from "./editor/sound";
import { Player } from "./editor/Player";
import { Timeline } from "./editor/Timeline";

type Tab = "media" | "voice" | "captions" | "text" | "filters" | "effects" | "audio" | "logo" | "export";
const TABS: [Tab, string, string][] = [
  ["media", "📁", "Media"], ["voice", "🗣", "Voice"], ["captions", "💬", "Captions"], ["text", "T", "Text"],
  ["filters", "🎨", "Filters"], ["effects", "✨", "Effects"], ["audio", "🎵", "Audio"], ["logo", "🏷", "Logo"], ["export", "⬆", "Export"],
];
const STEPS: [string, string][] = [
  ["download", "Download"], ["extract", "Audio"], ["transcribe", "Speech→text"], ["separate", "Voices/music"], ["analyze", "Speakers"],
  ["translate", "Translate"], ["review", "Review"], ["tts", "Khmer voice"], ["clone", "Clone voices"], ["mix", "Mix"], ["mux", "Video"], ["done", "Done"],
];
const DOWNLOADS: [string, string, string][] = [
  ["output.mp4", "🎬 Khmer video", "MP4 + subtitle track"],
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
const PREFS = "khmerDubPrefs";

function VoiceCard({ v, on, onPick, rate, off }: { v: VoiceChoice; on: boolean; onPick: () => void; rate: number; off?: string }) {
  const [cls, icon, name, sub] = CARDS[v];
  return (
    <div className={`voice ${cls} ${on ? "on" : ""} ${off ? "off" : ""}`} role="radio" aria-checked={on} aria-disabled={!!off}
      tabIndex={0} title={off} onClick={() => !off && onPick()} onKeyDown={(e) => !off && (e.key === "Enter" || e.key === " ") && onPick()}>
      <div className="av">{icon}</div>
      <div><b>{name}</b> <span className="km">{KM_LABEL[v]}</span><small>{off || sub}</small></div>
      {(v === "male" || v === "female") && (
        <button type="button" className="btn ghost sm play" onClick={(e) => { e.stopPropagation(); new Audio(`/api/voices/preview?voice=${v}&rate=${rate}`).play(); }}>▶</button>
      )}
    </div>
  );
}

/** A time field (1:23.4) that is taken when you leave it. */
function TimeField({ value, onChange, placeholder }: { value: number; onChange: (t: number) => void; placeholder?: string }) {
  const [s, setS] = useState(value ? clock(value, true) : "");
  useEffect(() => setS(value ? clock(value, true) : ""), [value]);
  return <input type="text" className="time-field" value={s} placeholder={placeholder} onChange={(e) => setS(e.target.value)}
    onBlur={() => { const t = parseTime(s); if (Number.isNaN(t)) setS(value ? clock(value, true) : ""); else onChange(t); }} />;
}

export default function Studio() {
  // ---------------------------------------------------------------- project and job
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [history, setHistory] = useState<Job[]>([]);
  const [canClone, setCanClone] = useState(false);

  // new project: the video to dub
  const [mode, setMode] = useState<"file" | "url">("file");
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

  // the settings being edited (live in the player); sent to the server on Update voices / Export
  const [voice, setVoice] = useState<VoiceChoice>("auto");
  const [match, setMatch] = useState(true);
  const [rate, setRate] = useState(0);
  const [bgMode, setBgMode] = useState<"duck" | "none">("duck");
  const [look, setLook] = useState<Look>(DEFAULT_LOOK);
  const [mix, setMix] = useState<Mix>(DEFAULT_MIX);

  // lines
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [baseSegs, setBaseSegs] = useState<Segment[] | null>(null); // as last saved, to see what was edited
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);
  const [find, setFind] = useState(""), [replaceWith, setReplaceWith] = useState("");

  // editor
  const [tab, setTab] = useState<Tab>("media");
  const [view, setView] = useState<"edit" | "final">("edit");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pendingExport, setPendingExport] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopAt = useRef<number | null>(null);
  const { brand, reload } = useBranding();

  // ---------------------------------------------------------------- loading
  const loadHistory = useCallback(() => { api<Job[]>("/api/jobs").then(setHistory).catch(() => {}); }, []);
  const openJob = useCallback((id: string | null) => {
    setJobId(id); setJob(null); setSegs(null); setBaseSegs(null); setSelected(null); setSelectedPart(null);
    setView("edit"); setTime(0); setPollKey((k) => k + 1); setErr("");
    try { id ? localStorage.setItem("khmerDubJob", id) : localStorage.removeItem("khmerDubJob"); } catch {}
  }, []);

  useEffect(() => {
    setLook(savedLook());
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) || "null");
      if (p) { setMix(fullMix(p.mix)); setBgMode(p.bgMode === "none" ? "none" : "duck"); setRate(p.rate ?? 0); setMatch(p.match !== false); }
    } catch {}
    api<{ clone: boolean }>("/api/capabilities").then((c) => { setCanClone(c.clone); if (c.clone) setVoice("clone"); }).catch(() => {});
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
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, 1200);
        else loadHistory();
      } catch { if (!stop) openJob(null); }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId, pollKey, loadHistory, openJob]);

  // a job that is ready: its settings and lines come into the editor
  const ready = job && (job.status === "review" || job.status === "done");
  const jobVersion = `${job?.id}:${job?.version ?? 0}:${job?.status}`;
  useEffect(() => {
    if (!job || !ready) return;
    setVoice(job.opts.voice); setMatch(job.opts.match !== false); setRate(job.opts.rate ?? 0); setBgMode(job.opts.bgMode);
    setLook(fullLook(job.opts)); setMix(fullMix(job.opts.mix));
    api<Segment[]>(`/api/jobs/${job.id}/segments`).then((s) => { setSegs(s); setBaseSegs(s); }).catch(() => {});
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
  const needsPrep = !!job && job.status === "done" && stemsWanted && !job.tracks?.vocals;
  const settingsNow = JSON.stringify([look, mix, bgMode]);
  const settingsJob = job ? JSON.stringify([fullLook(job.opts), fullMix(job.opts.mix), job.opts.bgMode]) : "";
  const exportCurrent = !!job?.tracks?.output && job.exported === job.version && !voicesChanged && settingsNow === settingsJob;
  const working = job?.status === "queued" || job?.status === "running";

  // ---------------------------------------------------------------- actions
  const settingsBody = () => ({ voice, match, rate, bgMode, mix, ...look });

  async function start() {
    setErr("");
    if (trim.to && trim.to <= trim.from + 0.5) { setErr("The end of the cut must be after its start"); return; }
    const params = { sourceLang, quality, voice, match: String(match), rate: String(rate), bgMode, review: String(review),
      burn: String(look.burn), sub: JSON.stringify(look.sub), logo: JSON.stringify(look.logo), out: JSON.stringify(look.out),
      fx: JSON.stringify(look.fx), mix: JSON.stringify(mix), trim: JSON.stringify(trim) };
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
  async function makeVoices() {
    if (!jobId) return;
    videoRef.current?.pause();
    const body: Record<string, unknown> = settingsBody();
    if (segs) body.segments = segs.map((s, i) => ({ i, km: s.km, voice: s.voice, speaker: s.speaker }));
    try {
      await api(`/api/jobs/${jobId}/dub`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setPollKey((k) => k + 1);
    } catch (e) { alert((e as Error).message); }
  }

  /** Merge every layer into one video. Voices that changed are made first. */
  async function exportVideo() {
    if (!jobId) return;
    setTab("export");
    if (voicesChanged || needsPrep) { setPendingExport(true); await makeVoices(); return; }
    videoRef.current?.pause();
    try {
      await api(`/api/jobs/${jobId}/render`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...look, mix, bgMode }) });
      setPollKey((k) => k + 1);
    } catch (e) { alert((e as Error).message); }
  }
  useEffect(() => { // export asked for while the voices were being made
    if (pendingExport && job?.status === "done" && !voicesChanged) { setPendingExport(false); exportVideo(); }
    if (pendingExport && job?.status === "error") setPendingExport(false);
  }, [job?.status, job?.version]); // eslint-disable-line react-hooks/exhaustive-deps

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
    video: videoRef.current, segs, mix, bgMode, stems: stemsWanted, enabled: view === "edit",
    urls: {
      voice: job?.tracks?.voice ? `${base}voice_track.m4a?v=${v}` : undefined,
      vocals: job?.tracks?.vocals && stemsWanted ? `${base}vocals.wav` : undefined,
      background: job?.tracks?.vocals && stemsWanted ? `${base}background.wav` : undefined,
      bgm: mix.bgm && brand?.music ? brand.music.url : undefined,
    },
  });
  const seek = (t: number) => { const el = videoRef.current; if (el) el.currentTime = Math.max(0, Math.min(t, el.duration || t)); setTime(t); };
  const playRange = (a: number, b: number) => {
    const el = videoRef.current;
    if (!el) return;
    audio.start(); el.currentTime = a; stopAt.current = b; el.play().catch(() => {});
  };
  const onTime = useCallback((t: number) => {
    setTime(t);
    if (stopAt.current !== null && t >= stopAt.current) { stopAt.current = null; videoRef.current?.pause(); }
  }, []);
  const startAt = useRef<number | null>(null);
  const onDuration = useCallback((d: number) => {
    setDuration(d);
    if (startAt.current !== null && videoRef.current) { videoRef.current.currentTime = startAt.current; startAt.current = null; }
  }, []);
  useEffect(() => { // space: play / pause
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code !== "Space" || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
      e.preventDefault();
      const el = videoRef.current;
      if (!el) return;
      if (el.paused) { audio.start(); el.play().catch(() => {}); } else el.pause();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [audio]);

  // ---------------------------------------------------------------- lines
  const speakers = clone ? job?.meta?.speakers ?? 0 : 0;
  const setLine = (i: number, p: Partial<Segment>) => setSegs((ss) => ss && ss.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const hits = find && segs ? segs.filter((x) => x.km.includes(find)).length : 0;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { // the selected line scrolls into view in the captions list
    if (selected === null) return;
    listRef.current?.querySelector(`[data-i="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

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
        <small className="note">The subtitle changes live. {job?.status === "done" ? "The voice for edited lines is made on “Update voices” (only those lines)." : ""} An empty line is not dubbed.</small>
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
              <small>{job.meta ? `${clock(job.meta.duration)} · ${job.meta.language} · ${job.meta.segments} lines` : job.message}</small>
              <button type="button" className="btn ghost sm" onClick={() => openJob(null)}>+ New project</button>
            </div>
          ) : (
            <>
              <div className="seg-btns">
                <button type="button" className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>Upload file</button>
                <button type="button" className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>Video link</button>
              </div>
              {mode === "file" ? (
                <button type="button" className="import" onClick={() => fileInput.current?.click()}>
                  {file ? <><b>{file.name}</b><small>{(file.size / 1048576).toFixed(1)} MB · click to change</small></> : <><b>＋ Import video</b><small>MP4, MKV, MOV, AVI, WEBM…</small></>}
                </button>
              ) : (
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… YouTube, Facebook, TikTok, Bilibili" />
              )}
              <input ref={fileInput} type="file" accept="video/*,.mkv,.ts" hidden onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
              <label className="f">Original language</label>
              <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                <option value="auto">Auto detect</option><option value="zh">Chinese 中文</option><option value="en">English</option>
              </select>
              <label className="f">Recognition quality</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="best">Best (large-v3-turbo)</option><option value="balanced">Balanced (medium)</option><option value="fast">Fast (small)</option>
              </select>
              <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
                <span>Check the translation first<small>Stop before the voices are made</small></span></label>
            </>
          )}
          <h4>Projects</h4>
          <div className="projects">
            {history.length === 0 && <span className="note">None yet</span>}
            {history.map((h) => (
              <div key={h.id} className={`proj ${h.id === jobId ? "on" : ""}`}>
                <button type="button" onClick={() => openJob(h.id)}>
                  <span>{h.meta?.title || h.title || h.id}</span>
                  <small>{h.meta ? `${clock(h.meta.duration)} · ` : ""}{h.status === "done" ? "ready" : h.status}</small>
                </button>
                {h.status !== "queued" && h.status !== "running" && <button type="button" className="del" title="Delete" onClick={() => removeJob(h.id)}>✕</button>}
              </div>
            ))}
          </div>
        </div>
      );
      case "voice": return (
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
                  <button key={k} type="button" className={`btn ghost sm spk s${k % 6}`} onClick={() => new Audio(`${base}speaker_${k + 1}.wav`).play()}>
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
          {!segs ? <small className="note">The lines appear here once the speech is recognised. Style them on the right – the player shows a sample.</small> : (
            <>
              <div className="findbar">
                <input type="text" className="km" value={find} placeholder="Find in Khmer…" onChange={(e) => setFind(e.target.value)} />
                <div className="row nowrap">
                  <input type="text" className="km" value={replaceWith} placeholder="Replace with…" onChange={(e) => setReplaceWith(e.target.value)} />
                  <button type="button" className="btn ghost sm" disabled={!hits}
                    onClick={() => setSegs(segs.map((x) => ({ ...x, km: x.km.split(find).join(replaceWith) })))}>All ({hits})</button>
                </div>
              </div>
              <div className="cap-list" ref={listRef}>
                {segs.map((s, i) => (
                  <div key={i} data-i={i} className={`cap ${selected === i ? "on" : ""} ${find && s.km.includes(find) ? "hit" : ""}`}
                    onClick={() => { setSelected(i); seek(s.start); }}>
                    <span className="cap-t">{clock(s.start)}{edited.has(i) && <i className="dot" />}</span>
                    <textarea className="km" rows={1} value={s.km} onChange={(e) => setLine(i, { km: e.target.value })} onFocus={() => { setSelected(i); seek(s.start); }} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      );
      case "text": return <TitlePanel {...lookProps} />;
      case "filters": return <FilterGallery {...lookProps} />;
      case "effects": return <CoverPanel {...lookProps} />;
      case "audio": return <SoundSources value={mix} onChange={setMix} bgMode={bgMode} onBgMode={setBgMode} canSplit={canClone} clone={clone} brand={brand} reload={reload} />;
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
            {STEPS.filter(([k]) => k !== "download" || job.opts.url).map(([k, label]) => {
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
            <button type="button" className="btn ghost sm" disabled={!src} onClick={() => setTrim({ ...trim, from: Math.floor(time * 10) / 10 })}>⇤ Here</button></div>
          <div className="row nowrap"><span className="lbl">To</span><TimeField value={trim.to} onChange={(t) => setTrim({ ...trim, to: t })} placeholder="end" />
            <button type="button" className="btn ghost sm" disabled={!src} onClick={() => setTrim({ ...trim, to: Math.floor(time * 10) / 10 })}>Here ⇥</button></div>
          {(trim.from > 0 || trim.to > 0) && <button type="button" className="btn ghost sm" onClick={() => setTrim({ from: 0, to: 0 })}>Whole video</button>}
        </div>
      );
      case "voice": return (
        <div className="pane">
          <h4>About the voice</h4>
          <small className="note">The voice, speed and “sound like the speaker” are used when the voices are made. Edited lines and a changed voice are
            made again with <b>Update voices</b> (only what changed). Sound levels and tone are on the 🎵 Audio tab and change live.</small>
        </div>
      );
      case "captions": case "text": return <SubtitleStylePanel {...lookProps} brand={brand} reload={reload} />;
      case "filters": return <AdjustPanel {...lookProps} />;
      case "effects": return <ExtrasPanel {...lookProps} />;
      case "audio": return <SoundShaping value={mix} onChange={setMix} split={clone || mix.split} now={time} selectedPart={selectedPart} onSelectPart={setSelectedPart} />;
      case "logo": return <LogoPanel {...lookProps} brand={brand} reload={reload} part="right" />;
      case "export": return (
        <div className="pane">
          <h4>Export</h4>
          <small className="note">Merges the video, Khmer voice, sound mix, subtitles, text, logo and effects into one MP4 with the settings you see now.</small>
          <button type="button" className="btn wide" disabled={!job || job.status !== "done" || working} onClick={exportVideo}>
            {working && job?.stage === "mux" ? "Exporting…" : "⬆ Export video"}</button>
          {job?.tracks?.output && (
            <>
              <small className={exportCurrent ? "ok-note" : "note"}>{exportCurrent ? "✓ Up to date with your edits" : "Changed since the last export – export again to include the changes."}</small>
              <div className="downloads">
                {DOWNLOADS.map(([f, t, s]) => <a key={f} href={`${base}${f}?download=1&v=${v}`}><b>{t}</b><small>{s}</small></a>)}
              </div>
            </>
          )}
        </div>
      );
    }
  })();

  // ---------------------------------------------------------------- top bar action
  let primary: React.ReactNode;
  if (!job) primary = <button type="button" className="btn" disabled={busy} onClick={start}>{uploadPct !== null ? `Uploading ${uploadPct}%` : "▶ Start dubbing"}</button>;
  else if (working) primary = <button type="button" className="btn" disabled>{Math.round(job.progress * 100)}% · {job.message.slice(0, 38)}</button>;
  else if (job.status === "review") primary = <button type="button" className="btn" onClick={makeVoices}>🗣 Generate Khmer voice</button>;
  else if (job.status === "error") primary = <button type="button" className="btn" onClick={job.meta ? makeVoices : () => openJob(null)}>{job.meta ? "Try again" : "New project"}</button>;
  else primary = (
    <>
      {(voicesChanged || needsPrep) && (
        <button type="button" className="btn ghost" onClick={makeVoices} title="Makes the voice again for edited lines only, then the preview plays them">
          🗣 Update voices{edited.size ? ` (${edited.size})` : ""}</button>
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
    <div className="studio">
      <header className="topbar">
        <div className="brand"><span className="logo km">ក</span> Khmer AI Dubber</div>
        <div className="project-name">{job ? job.meta?.title || job.title : file?.name || "New project"}
          {working && <span className="mini-bar"><i style={{ width: `${(job?.progress ?? 0) * 100}%` }} /></span>}
          {pendingExport && <small className="note"> · export follows</small>}
        </div>
        <div className="actions">
          <span className="err">{err || (job?.status === "done" && job.message.startsWith("No Khmer voice") ? job.message : "")}</span>{primary}
        </div>
      </header>

      <nav className="rail">
        {TABS.map(([k, icon, name]) => (
          <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}><span>{icon}</span>{name}</button>
        ))}
      </nav>
      <aside className="panel left"><div className="panel-title">{TABS.find((t) => t[0] === tab)![2]}</div>{left}</aside>

      <main className="center">
        <Player src={src} finalSrc={finalSrc} view={view} onView={setView} look={look} onLook={setLook} segs={segs}
          logoUrl={brand?.logo?.url ?? null} videoRef={videoRef} onPlay={audio.start} onTime={onTime} onDuration={onDuration}
          jobId={job?.meta ? job.id : undefined} placeholder={placeholder} />
      </main>

      <aside className="panel right">
        <div className="panel-title">{lineEditor && (tab === "captions" || tab === "voice" || tab === "media") ? "Line" : "Settings"}</div>
        {right}
      </aside>

      <footer className="bottom">
        <Timeline duration={duration || job?.meta?.duration || 0} time={time} onSeek={seek} segs={segs} edited={edited}
          selected={selected} onSelect={(i) => { setSelected(i); if (i !== null && tab !== "voice") setTab("captions"); }}
          parts={mix.parts} selectedPart={selectedPart} onSelectPart={(i) => { setSelectedPart(i); setTab("audio"); }}
          trim={!job && src ? trim : null} onTrim={setTrim} speakers={speakers} />
      </footer>
    </div>
  );
}
