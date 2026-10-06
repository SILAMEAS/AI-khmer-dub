"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Voice = "male" | "female";
type VoiceChoice = Voice | "auto" | "clone";
type Job = {
  id: string; status: "queued" | "running" | "review" | "done" | "error";
  stage: string; progress: number; message: string; error?: string; title: string; version?: number;
  opts: { url: string; voice: VoiceChoice; match?: boolean; rate: number; bgMode: "duck" | "none"; burn: boolean };
  meta?: { title: string; duration: number; language: string; segments: number; speakers?: number };
};
type Segment = { start: number; end: number; text: string; km: string; f0?: number; voice?: Voice; speaker?: number };

const STEPS: [string, string][] = [
  ["download", "Download"], ["extract", "Audio"], ["transcribe", "Speech→text"], ["separate", "Voices/music"], ["analyze", "Speakers"],
  ["translate", "Translate"], ["review", "Review"], ["tts", "Khmer voice"], ["clone", "Clone voices"], ["mix", "Mix"], ["mux", "Video"], ["done", "Done"],
];
const DOWNLOADS: [string, string, string][] = [
  ["output.mp4", "🎬 Khmer video", "MP4 + subtitle track"],
  ["km.srt", "📝 Khmer subtitles", ".srt"],
  ["original.srt", "📝 Original subtitles", ".srt"],
  ["dub_audio.m4a", "🔊 Khmer audio only", ".m4a"],
];

const clock = (t: number) => {
  t = Math.floor(t);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

/** XHR upload so big movies show upload progress; the file body streams straight to disk. */
function uploadFile(file: File, params: Record<string, string>, onPct: (p: number) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/jobs?" + new URLSearchParams({ ...params, name: file.name }));
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      const j = JSON.parse(x.responseText || "{}");
      x.status < 300 ? resolve(j) : reject(new Error(j.detail || x.statusText));
    };
    x.onerror = () => reject(new Error("Upload failed"));
    x.send(file);
  });
}

const CARDS: Record<VoiceChoice, [string, string, string, string]> = {
  clone: ["clone", "🧬", "Original voices", "Each person keeps their own voice"],
  auto: ["auto", "🎭", "Auto", "Boy or girl, like each speaker"],
  male: ["boy", "👦", "Boy", "Piseth"],
  female: ["girl", "👧", "Girl", "Sreymom"],
};
const KM_LABEL: Record<VoiceChoice, string> = { clone: "សំឡេងដើម", auto: "ស្វ័យប្រវត្តិ", male: "ប្រុស", female: "ស្រី" };

function VoiceCard({ v, on, onPick, rate, off }: {
  v: VoiceChoice; on: boolean; onPick: () => void; rate: number; off?: string;
}) {
  const [cls, icon, name, sub] = CARDS[v];
  const play = (e: React.MouseEvent) => {
    e.stopPropagation();
    new Audio(`/api/voices/preview?voice=${v}&rate=${rate}`).play();
  };
  return (
    <div className={`voice ${cls} ${on ? "on" : ""} ${off ? "off" : ""}`} role="radio" aria-checked={on}
      aria-disabled={!!off} tabIndex={0} title={off}
      onClick={() => !off && onPick()} onKeyDown={(e) => !off && (e.key === "Enter" || e.key === " ") && onPick()}>
      <div className="av">{icon}</div>
      <div>
        <b>{name}</b> <span className="km">{KM_LABEL[v]}</span>
        <small>{off || sub}</small>
      </div>
      {(v === "male" || v === "female") && <button type="button" className="btn ghost sm play" onClick={play}>▶ Listen</button>}
    </div>
  );
}

export default function Home() {
  // new-job form
  const [mode, setMode] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [sourceLang, setSourceLang] = useState("auto");
  const [quality, setQuality] = useState("best");
  const [bgMode, setBgMode] = useState<"duck" | "none">("duck");
  const [voice, setVoice] = useState<VoiceChoice>("auto");
  const [match, setMatch] = useState(true);
  const [rate, setRate] = useState(0);
  const [burn, setBurn] = useState(false);
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [startErr, setStartErr] = useState("");
  const [hover, setHover] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // current job
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [history, setHistory] = useState<Job[]>([]);

  // re-dub controls
  const [reVoice, setReVoice] = useState<VoiceChoice>("auto");
  const [reMatch, setReMatch] = useState(true);
  const [reBg, setReBg] = useState<"duck" | "none">("duck");
  const [reBurn, setReBurn] = useState(false);

  const loadHistory = useCallback(() => { api<Job[]>("/api/jobs").then(setHistory).catch(() => {}); }, []);

  const openJob = useCallback((id: string | null) => {
    setJobId(id); setJob(null); setSegs(null); setShowEditor(false); setPollKey((k) => k + 1);
    try { id ? localStorage.setItem("khmerDubJob", id) : localStorage.removeItem("khmerDubJob"); } catch {}
  }, []);

  // voice cloning is the default when it is installed (npm run setup -- --clone)
  const [canClone, setCanClone] = useState(false);
  useEffect(() => {
    api<{ clone: boolean }>("/api/capabilities").then((c) => {
      setCanClone(c.clone);
      if (c.clone) setVoice("clone");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadHistory();
    try { const saved = localStorage.getItem("khmerDubJob"); if (saved) openJob(saved); } catch {}
  }, [loadHistory, openJob]);

  // poll the job while it works
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/api/jobs/${jobId}`);
        if (stop) return;
        setJob(j);
        if (j.status === "queued" || j.status === "running") timer = setTimeout(tick, 1500);
        else loadHistory();
      } catch {
        if (!stop) { openJob(null); }
      }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId, pollKey, loadHistory, openJob]);

  // load the translation editor when the job pauses for review
  useEffect(() => {
    if (job?.status === "review" || (showEditor && job?.status === "done")) {
      if (!segs) api<Segment[]>(`/api/jobs/${job.id}/segments`).then(setSegs).catch(() => {});
    }
    if (job?.status === "done") {
      setReVoice(job.opts.voice); setReMatch(job.opts.match !== false); setReBg(job.opts.bgMode); setReBurn(job.opts.burn);
    }
  }, [job?.status, job?.id, showEditor, segs, job?.opts.voice, job?.opts.match, job?.opts.bgMode, job?.opts.burn]);

  async function start() {
    setStartErr("");
    const params = { sourceLang, quality, voice, match: String(match), rate: String(rate), bgMode, burn: String(burn), review: String(review) };
    setBusy(true);
    try {
      let j: Job;
      if (mode === "file") {
        if (!file) throw new Error("Choose a video first");
        setUploadPct(0);
        j = await uploadFile(file, params, setUploadPct);
      } else {
        if (!url.trim()) throw new Error("Paste a video link");
        j = await api<Job>("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...params, url: url.trim() }) });
      }
      openJob(j.id);
      loadHistory();
    } catch (e) {
      setStartErr((e as Error).message);
    } finally {
      setBusy(false); setUploadPct(null);
    }
  }

  async function redub(body: Record<string, unknown>) {
    if (!jobId) return;
    if (segs && (job?.status === "review" || showEditor)) body.segments = segs.map((s, i) => ({ i, km: s.km, voice: s.voice, speaker: s.speaker }));
    try {
      await api(`/api/jobs/${jobId}/dub`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      setShowEditor(false); setPollKey((k) => k + 1);
    } catch (e) { alert((e as Error).message); }
  }

  const stageIdx = job ? STEPS.findIndex((s) => s[0] === job.stage) : -1;
  const steps = STEPS.filter(([k]) => k !== "download" || job?.opts.url);
  const editorOpen = job && segs && (job.status === "review" || (showEditor && job.status === "done"));
  const fileBase = job ? `/api/jobs/${job.id}/files/` : "";
  const v = job?.version ?? 1;
  // per-line boy/girl only matters when the voice is picked per speaker
  const lineVoice = job?.status === "done" ? reVoice : job?.opts.voice;
  const perLine = lineVoice === "auto";
  // with cloning, each line says who speaks it; the voices found can be played back
  const speakers = lineVoice === "clone" ? job?.meta?.speakers ?? 0 : 0;

  return (
    <div className="wrap">
      <header>
        <div className="logo km">ក</div>
        <div>
          <h1>Khmer AI Dubber <span className="km" style={{ fontWeight: 500 }}>· បញ្ចូលសំឡេងខ្មែរ</span></h1>
          <p>Chinese / English video → Khmer voice + Khmer subtitles (.srt)</p>
        </div>
      </header>

      {!jobId && (
        <section className="card">
          <h2>1. Your video</h2>
          <div className="tabs">
            <button className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>Upload file</button>
            <button className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>Video link</button>
          </div>
          {mode === "file" ? (
            <>
              <div className={`drop ${hover ? "hover" : ""}`} onClick={() => fileInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setHover(true); }} onDragLeave={() => setHover(false)}
                onDrop={(e) => { e.preventDefault(); setHover(false); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); }}>
                {file ? (<><b>{file.name}</b><br /><small>{(file.size / 1048576).toFixed(1)} MB · click to change</small></>)
                  : (<><b>Drop a video here</b> or click to choose<br /><small>MP4, MKV, MOV, AVI, WEBM…</small></>)}
              </div>
              <input ref={fileInput} type="file" accept="video/*,.mkv,.ts" hidden
                onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
            </>
          ) : (
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…  (YouTube, Facebook, TikTok, Bilibili, …)" />
          )}

          <div className="grid">
            <div>
              <label className="f">Original language</label>
              <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                <option value="auto">Auto detect</option><option value="zh">Chinese 中文</option><option value="en">English</option>
              </select>
            </div>
            <div>
              <label className="f">Recognition quality</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="best">Best (large-v3-turbo)</option><option value="balanced">Balanced (medium)</option>
                <option value="fast">Fast (small)</option>
              </select>
            </div>
            <div>
              <label className="f">Original soundtrack</label>
              <select value={bgMode} onChange={(e) => setBgMode(e.target.value as "duck" | "none")}>
                <option value="duck">Keep music, lower original voices</option><option value="none">Khmer voice only</option>
              </select>
            </div>
          </div>

          <h2 style={{ marginTop: 22 }}>2. Khmer voice</h2>
          <div className="voices">
            {(["clone", "auto", "male", "female"] as const).map((c) => (
              <VoiceCard key={c} v={c} on={voice === c} onPick={() => setVoice(c)} rate={rate}
                off={c === "clone" && !canClone ? "Not installed: npm run setup -- --clone" : undefined} />
            ))}
          </div>
          {voice === "clone" && (
            <p className="note">Copies each person&apos;s voice from the video: a child stays a child, grandma stays
              grandma. Slow without a graphics card: about 10 s per line (a 20-minute video takes roughly an hour).</p>
          )}
          <div className="grid">
            <div>
              <label className="f">Speaking speed: <b>{rate > 0 ? "+" : ""}{rate}%</b></label>
              <input type="range" min={-30} max={40} step={5} value={rate} onChange={(e) => setRate(+e.target.value)} style={{ width: "100%" }} />
            </div>
            <label className="check">
              <input type="checkbox" checked={match} onChange={(e) => setMatch(e.target.checked)} />
              <span>Sound like the original speaker<small>Follow each person&apos;s pitch and loudness</small></span>
            </label>
            <label className="check">
              <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
              <span>Burn subtitles into video<small>Always also included as a selectable track + .srt</small></span>
            </label>
            <label className="check">
              <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
              <span>Let me check the translation first<small>Edit Khmer lines before the voice is made</small></span>
            </label>
          </div>
          <div className="row" style={{ marginTop: 20 }}>
            <button className="btn" disabled={busy} onClick={start}>
              {uploadPct !== null ? `Uploading ${uploadPct}%` : "Start dubbing"}
            </button>
            <span className="err">{startErr}</span>
          </div>
        </section>
      )}

      {jobId && job && (
        <section className="card">
          <div className="row between">
            <h2 style={{ margin: 0 }}>{job.meta?.title || job.title || "Job"}</h2>
            <button className="btn ghost sm" onClick={() => openJob(null)}>+ New video</button>
          </div>
          <div className="bar"><i style={{ width: `${job.progress * 100}%` }} /></div>
          <div className="note">{job.message}</div>
          <div className="steps">
            {steps.map(([k, label]) => {
              const i = STEPS.findIndex((s) => s[0] === k);
              const cls = job.status === "done" || i < stageIdx ? "done" : i === stageIdx ? "cur" : "";
              return <span key={k} className={cls}>{label}</span>;
            })}
          </div>
          {job.status === "error" && <div className="err" style={{ marginTop: 10 }}>{job.error}</div>}
        </section>
      )}

      {editorOpen && (
        <section className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Check Khmer translation</h2>
            <div className="row">
              <a className="btn ghost sm" href={`${fileBase}km.srt?download=1`}>⬇ Khmer .srt</a>
              <button className="btn" onClick={() => redub(job.status === "done" ? { voice: reVoice, match: reMatch, bgMode: reBg, burn: reBurn } : {})}>
                Generate Khmer voice →
              </button>
            </div>
          </div>
          {speakers > 0 && (
            <div className="people">
              <span className="note">Voices found:</span>
              {Array.from({ length: speakers }, (_, k) => (
                <button key={k} type="button" className={`btn ghost sm spk s${k % 6}`}
                  onClick={() => new Audio(`${fileBase}speaker_${k + 1}.wav`).play()}>
                  ▶ Person {k + 1} <small>({segs.filter((x) => x.speaker === k).length} lines)</small>
                </button>
              ))}
            </div>
          )}
          <div className="segs">
            {segs.map((s, i) => (
              <div className="seg" key={i}>
                <div className="t">
                  {clock(s.start)}<br />{clock(s.end)}
                  {speakers > 0 && (
                    <select className={`who spk s${(s.speaker ?? 0) % 6}`} value={s.speaker ?? 0} title="Who says this line"
                      onChange={(e) => setSegs(segs.map((x, k) => (k === i ? { ...x, speaker: +e.target.value } : x)))}>
                      {Array.from({ length: speakers }, (_, k) => <option key={k} value={k}>Person {k + 1}</option>)}
                    </select>
                  )}
                  {perLine && s.voice && (
                    <button type="button" className={`who ${s.voice === "male" ? "boy" : "girl"}`}
                      title={`${s.f0 ? `Original voice ≈ ${s.f0} Hz. ` : ""}Click to switch boy / girl`}
                      onClick={() => setSegs(segs.map((x, k) => (k === i ? { ...x, voice: x.voice === "male" ? "female" : "male" } : x)))}>
                      {s.voice === "male" ? "👦 Boy" : "👧 Girl"}
                    </button>
                  )}
                </div>
                <div className="o">{s.text}</div>
                <textarea className="km" rows={2} value={s.km}
                  onChange={(e) => setSegs(segs.map((x, k) => (k === i ? { ...x, km: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        </section>
      )}

      {job?.status === "done" && (
        <section className="card">
          <h2>Result</h2>
          <video key={v} src={`${fileBase}output.mp4?v=${v}`} controls playsInline />
          <div className="dl">
            {DOWNLOADS.map(([f, t, s]) => (
              <a key={f} href={`${fileBase}${f}?download=1&v=${v}`}><b>{t}</b><small>{s}</small></a>
            ))}
          </div>
          <h2 style={{ marginTop: 22 }}>Change voice / re-dub</h2>
          <div className="row">
            <select style={{ width: "auto" }} value={reVoice} onChange={(e) => setReVoice(e.target.value as VoiceChoice)}>
              {canClone && <option value="clone">🧬 Original voices</option>}
              <option value="auto">🎭 Auto (like each speaker)</option>
              <option value="female">👧 Girl (Sreymom)</option><option value="male">👦 Boy (Piseth)</option>
            </select>
            <label className="check"><input type="checkbox" checked={reMatch} onChange={(e) => setReMatch(e.target.checked)} /><span>Sound like the speaker</span></label>
            <select style={{ width: "auto" }} value={reBg} onChange={(e) => setReBg(e.target.value as "duck" | "none")}>
              <option value="duck">Keep music</option><option value="none">Khmer voice only</option>
            </select>
            <label className="check"><input type="checkbox" checked={reBurn} onChange={(e) => setReBurn(e.target.checked)} /><span>Burn subtitles</span></label>
            <button className="btn" onClick={() => redub({ voice: reVoice, match: reMatch, bgMode: reBg, burn: reBurn })}>Re-dub</button>
            <button className="btn ghost" onClick={() => setShowEditor(true)}>Edit subtitles</button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Recent jobs</h2>
        <div className="jobs">
          {history.length === 0 && <span className="note">None yet</span>}
          {history.map((h) => (
            <button key={h.id} onClick={() => openJob(h.id)}>
              <span>{h.meta?.title || h.title || h.id}</span><span>{h.status}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
