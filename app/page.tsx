"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Voice = "male" | "female";
type Job = {
  id: string; status: "queued" | "running" | "review" | "done" | "error";
  stage: string; progress: number; message: string; error?: string; title: string; version?: number;
  opts: { url: string; voice: Voice; rate: number; bgMode: "duck" | "none"; burn: boolean };
  meta?: { title: string; duration: number; language: string; segments: number };
};
type Segment = { start: number; end: number; text: string; km: string };

const STEPS: [string, string][] = [
  ["download", "Download"], ["extract", "Audio"], ["transcribe", "Speech→text"], ["translate", "Translate"],
  ["review", "Review"], ["tts", "Khmer voice"], ["mix", "Mix"], ["mux", "Video"], ["done", "Done"],
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

function VoiceCard({ v, on, onPick, rate }: { v: Voice; on: boolean; onPick: () => void; rate: number }) {
  const boy = v === "male";
  const play = (e: React.MouseEvent) => {
    e.stopPropagation();
    new Audio(`/api/voices/preview?voice=${v}&rate=${rate}`).play();
  };
  return (
    <div className={`voice ${boy ? "boy" : "girl"} ${on ? "on" : ""}`} role="radio" aria-checked={on} tabIndex={0}
      onClick={onPick} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick()}>
      <div className="av">{boy ? "👦" : "👧"}</div>
      <div>
        <b>{boy ? "Boy" : "Girl"}</b> <span className="km">{boy ? "ប្រុស" : "ស្រី"}</span>
        <small>{boy ? "Piseth" : "Sreymom"}</small>
      </div>
      <button type="button" className="btn ghost sm play" onClick={play}>▶ Listen</button>
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
  const [voice, setVoice] = useState<Voice>("female");
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
  const [reVoice, setReVoice] = useState<Voice>("female");
  const [reBg, setReBg] = useState<"duck" | "none">("duck");
  const [reBurn, setReBurn] = useState(false);

  const loadHistory = useCallback(() => { api<Job[]>("/api/jobs").then(setHistory).catch(() => {}); }, []);

  const openJob = useCallback((id: string | null) => {
    setJobId(id); setJob(null); setSegs(null); setShowEditor(false); setPollKey((k) => k + 1);
    try { id ? localStorage.setItem("khmerDubJob", id) : localStorage.removeItem("khmerDubJob"); } catch {}
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
    if (job?.status === "done") { setReVoice(job.opts.voice); setReBg(job.opts.bgMode); setReBurn(job.opts.burn); }
  }, [job?.status, job?.id, showEditor, segs, job?.opts.voice, job?.opts.bgMode, job?.opts.burn]);

  async function start() {
    setStartErr("");
    const params = { sourceLang, quality, voice, rate: String(rate), bgMode, burn: String(burn), review: String(review) };
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
    if (segs && (job?.status === "review" || showEditor)) body.segments = segs.map((s, i) => ({ i, km: s.km }));
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
            <VoiceCard v="male" on={voice === "male"} onPick={() => setVoice("male")} rate={rate} />
            <VoiceCard v="female" on={voice === "female"} onPick={() => setVoice("female")} rate={rate} />
          </div>
          <div className="grid">
            <div>
              <label className="f">Speaking speed: <b>{rate > 0 ? "+" : ""}{rate}%</b></label>
              <input type="range" min={-30} max={40} step={5} value={rate} onChange={(e) => setRate(+e.target.value)} style={{ width: "100%" }} />
            </div>
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
              <button className="btn" onClick={() => redub(job.status === "done" ? { voice: reVoice, bgMode: reBg, burn: reBurn } : {})}>
                Generate Khmer voice →
              </button>
            </div>
          </div>
          <div className="segs">
            {segs.map((s, i) => (
              <div className="seg" key={i}>
                <div className="t">{clock(s.start)}<br />{clock(s.end)}</div>
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
            <select style={{ width: "auto" }} value={reVoice} onChange={(e) => setReVoice(e.target.value as Voice)}>
              <option value="female">👧 Girl (Sreymom)</option><option value="male">👦 Boy (Piseth)</option>
            </select>
            <select style={{ width: "auto" }} value={reBg} onChange={(e) => setReBg(e.target.value as "duck" | "none")}>
              <option value="duck">Keep music</option><option value="none">Khmer voice only</option>
            </select>
            <label className="check"><input type="checkbox" checked={reBurn} onChange={(e) => setReBurn(e.target.checked)} /><span>Burn subtitles</span></label>
            <button className="btn" onClick={() => redub({ voice: reVoice, bgMode: reBg, burn: reBurn })}>Re-dub</button>
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
