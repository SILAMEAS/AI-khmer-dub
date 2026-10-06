"use client";

/**
 * Sound: the panels that set the mix, and the live preview engine that plays it in the browser while you change it
 * (Web Audio: the same levels, dips, parts, bass / treble and echo as the final mix; only pitch waits for Apply).
 */
import { useEffect, useRef, useState } from "react";
import { clock, parseTime, type Mix, type Part, type Segment, type Tone } from "./common";
import type { Branding } from "./look";

// ---------------------------------------------------------------- live engine

type Urls = { voice?: string; vocals?: string; background?: string; bgm?: string };
type EngineIn = {
  video: HTMLVideoElement | null; urls: Urls; mix: Mix; bgMode: "duck" | "none"; stems: boolean;
  segs: Segment[] | null; enabled: boolean;
};

const RAMP = 0.25; // seconds the music takes to dip, as in the final mix

/** Merged speech stretches, for the dip of the music while someone speaks. */
function speech(segs: Segment[] | null): [number, number][] {
  const out: [number, number][] = [];
  for (const s of [...(segs ?? [])].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last[1] + 2 * RAMP + 0.1) last[1] = Math.max(last[1], s.end);
    else out.push([s.start, s.end]);
  }
  return out;
}
/** 1 between lines, `dip` while someone speaks, ramping in between. */
function dipAt(iv: [number, number][], t: number, dip: number) {
  let g = 1;
  for (const [a, b] of iv) {
    if (t < a - RAMP) break;
    if (t > b + RAMP) continue;
    const r = t < a ? (a - t) / RAMP : t > b ? (t - b) / RAMP : 0;
    g = Math.min(g, dip + (1 - dip) * r);
  }
  return g;
}
function partsAt(parts: Part[], t: number) {
  let o = 1, k = 1;
  for (const p of parts) {
    const r = Math.min(1, (t - p.from) / 0.15, (p.to - t) / 0.15);
    if (r <= 0) continue;
    o *= 1 + (p.orig / 100 - 1) * r;
    k *= 1 + (p.khmer / 100 - 1) * r;
  }
  return { o, k };
}

type Chain = { el: HTMLAudioElement; gain: GainNode; bass?: BiquadFilterNode; treble?: BiquadFilterNode; echo?: GainNode[] };

/**
 * Plays the current mix live, following the video's clock. Call `start()` from a click (browsers only allow
 * sound to start after one); until then the video plays its own sound.
 */
export function useLiveAudio(p: EngineIn) {
  const ctx = useRef<AudioContext | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const videoGain = useRef<GainNode | null>(null);
  const connected = useRef(new WeakSet<HTMLMediaElement>());
  const chains = useRef<Partial<Record<keyof Urls, Chain>>>({});
  const [live, setLive] = useState(false);

  const shelf = (c: AudioContext, type: BiquadFilterType, f: number) => {
    const n = c.createBiquadFilter();
    n.type = type; n.frequency.value = f;
    return n;
  };
  const connect = (key: keyof Urls, url: string) => {
    const c = ctx.current!;
    const el = new Audio(url);
    el.preload = "auto";
    if (key === "bgm") el.loop = true;
    const src = c.createMediaElementSource(el);
    const gain = c.createGain();
    gain.gain.value = 0;
    const chain: Chain = { el, gain };
    if (key === "voice" || key === "vocals") { // bass / treble, and echo for the Khmer voice
      chain.bass = shelf(c, "lowshelf", 100);
      chain.treble = shelf(c, "highshelf", 3000);
      src.connect(chain.bass).connect(chain.treble).connect(gain);
      if (key === "voice") {
        chain.echo = [0.035, 0.055, 0.09, 0.17, 0.26].map((d) => {
          const delay = c.createDelay(1), g = c.createGain();
          delay.delayTime.value = d; g.gain.value = 0;
          gain.connect(delay).connect(g).connect(c.destination);
          return g;
        });
      }
    } else {
      src.connect(gain);
    }
    gain.connect(c.destination);
    chains.current[key] = chain;
  };
  const drop = (key: keyof Urls) => {
    const ch = chains.current[key];
    if (!ch) return;
    ch.el.pause(); ch.gain.disconnect(); ch.el.removeAttribute("src"); ch.el.load();
    delete chains.current[key];
  };

  // follow the tracks that exist (a new Khmer voice track after Apply, music uploaded, …)
  const urlKey = JSON.stringify(p.urls);
  useEffect(() => {
    if (!ctx.current) return;
    const urls = latest.current.urls;
    for (const k of ["voice", "vocals", "background", "bgm"] as const) {
      const have = chains.current[k];
      if (have && have.el.src.endsWith(urls[k] ?? "\u0000")) continue;
      drop(k);
      if (urls[k]) connect(k, urls[k]!);
    }
  }, [urlKey, live]);

  function start() {
    const v = latest.current.video;
    if (!v) return;
    if (!ctx.current) ctx.current = new AudioContext();
    const c = ctx.current;
    if (!connected.current.has(v)) { // the video's own sound now goes through the mix too
      const g = c.createGain();
      c.createMediaElementSource(v).connect(g).connect(c.destination);
      connected.current.add(v);
      videoGain.current = g;
    }
    c.resume();
    setLive(true);
  }

  // every frame: levels from the current settings at the video's time, other tracks kept in step
  useEffect(() => {
    if (!live) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { video: v, mix: m, bgMode, stems, segs, enabled } = latest.current;
      const c = ctx.current;
      if (!v || !c) return;
      const t = v.currentTime, now = c.currentTime;
      const keep = bgMode === "duck" && enabled;
      const high = m.music / 100;
      const low = m.duck >= 0 ? m.duck / 100 : ((stems ? 0.5 : 0.12) * high) / 0.8;
      const dip = dipAt(iv.current, t, high > 0 ? Math.min(1, low / high) : 0.15);
      const { o, k } = partsAt(m.parts, t);
      const set = (g: GainNode | undefined | null, val: number) => g?.gain.setTargetAtTime(val, now, 0.04);
      const ch = chains.current;
      const useStems = stems && !!ch.background && !!ch.vocals;
      set(videoGain.current, !enabled ? 1 : keep && !useStems ? high * dip * o : 0);
      set(ch.background?.gain, keep && useStems ? high * dip * o : 0);
      set(ch.vocals?.gain, keep && useStems ? (m.voices / 100) * o : 0);
      if (ch.vocals?.bass) { ch.vocals.bass.gain.value = m.origTone.bass; ch.vocals.treble!.gain.value = m.origTone.treble; }
      set(ch.voice?.gain, enabled ? 10 ** (m.voice / 20) * k : 0);
      if (ch.voice?.bass) {
        ch.voice.bass.gain.value = m.khmerTone.bass; ch.voice.treble!.gain.value = m.khmerTone.treble;
        const e = m.khmerTone.echo; // same delays and strengths as the final mix's aecho
        const levels = e === "room" ? [0.22, 0.15, 0, 0, 0] : e === "hall" ? [0, 0, 0.3, 0.2, 0.12] : [0, 0, 0, 0, 0];
        ch.voice.echo!.forEach((g, i) => set(g, levels[i]));
      }
      set(ch.bgm?.gain, enabled && m.bgm ? (m.bgm / 100) * dip * o : 0);
      for (const key of ["voice", "vocals", "background", "bgm"] as const) {
        const el = ch[key]?.el;
        if (!el) continue;
        const want = key === "bgm" && el.duration ? t % el.duration : t;
        if (v.paused || !enabled) { if (!el.paused) el.pause(); continue; }
        if (Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
        if (el.paused) el.play().catch(() => {});
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [live]);

  const iv = useRef<[number, number][]>([]);
  useEffect(() => { iv.current = speech(p.segs); }, [p.segs]);
  useEffect(() => () => { for (const k of Object.keys(chains.current) as (keyof Urls)[]) drop(k); ctx.current?.close(); }, []);
  return { start, live };
}

// ---------------------------------------------------------------- panels

type MixProps = { value: Mix; onChange: (m: Mix) => void };

function ToneControls({ value: t, onChange, echo = true, live }: { value: Tone; onChange: (t: Tone) => void; echo?: boolean; live: boolean }) {
  const set = (p: Partial<Tone>) => onChange({ ...t, ...p });
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return (
    <>
      <label className="slider-row"><span>Pitch</span>
        <input type="range" min={-6} max={6} step={1} value={t.pitch} onChange={(e) => set({ pitch: +e.target.value })} onDoubleClick={() => set({ pitch: 0 })}
          title="Lower = deeper voice, higher = brighter. Heard after Apply." />
        <b>{t.pitch ? sign(t.pitch) : "0"}</b></label>
      {t.pitch !== 0 && live && <small className="note">Pitch is heard after Apply; the rest changes live.</small>}
      <label className="slider-row"><span>Bass</span>
        <input type="range" min={-12} max={12} step={1} value={t.bass} onChange={(e) => set({ bass: +e.target.value })} onDoubleClick={() => set({ bass: 0 })} />
        <b>{sign(t.bass)} dB</b></label>
      <label className="slider-row"><span>Treble</span>
        <input type="range" min={-12} max={12} step={1} value={t.treble} onChange={(e) => set({ treble: +e.target.value })} onDoubleClick={() => set({ treble: 0 })} />
        <b>{sign(t.treble)} dB</b></label>
      {echo && (
        <div className="seg-btns">
          {([["none", "No echo"], ["room", "Room"], ["hall", "Hall"]] as const).map(([v, n]) => (
            <button type="button" key={v} className={t.echo === v ? "on" : ""} onClick={() => set({ echo: v })}>{n}</button>
          ))}
        </div>
      )}
    </>
  );
}

/** Where the separation of voices and music stands, for the status under "Original voices". */
export type StemState = { ready: boolean; task?: { progress: number; message: string }; error?: string; project: boolean };

/** Original sound and your music (left panel of Audio). */
export function SoundSources({ value: m, onChange, bgMode, onBgMode, canSplit, clone, brand, reload, stems, onRetry }: MixProps & {
  bgMode: "duck" | "none"; onBgMode: (b: "duck" | "none") => void; canSplit: boolean; clone: boolean;
  brand: Branding | null; reload: () => void; stems: StemState; onRetry: () => void;
}) {
  const set = (p: Partial<Mix>) => onChange({ ...m, ...p });
  const keep = bgMode === "duck", split = clone || m.split;
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  const track = brand?.music?.url ?? null;
  async function upload(f?: File) {
    if (!f) return;
    setErr("");
    try {
      const r = await fetch(`/api/branding/music?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      reload();
      if (!m.bgm) set({ bgm: 25 });
    } catch (e) { setErr((e as Error).message); }
  }
  async function remove() {
    await fetch("/api/branding/music", { method: "DELETE" });
    set({ bgm: 0 });
    reload();
  }
  return (
    <div className="pane">
      <h4>Original sound</h4>
      <div className="seg-btns">
        <button type="button" className={keep ? "on" : ""} onClick={() => onBgMode("duck")}>Keep original sound</button>
        <button type="button" className={!keep ? "on" : ""} onClick={() => onBgMode("none")} title="No music, no effects, no original voices">Khmer voice only</button>
      </div>
      <fieldset className="pane-group" disabled={!keep}>
        <label className="f">Original voices (the Chinese / English speech)</label>
        <div className="seg-btns">
          {!clone && <button type="button" className={!split ? "on" : ""} onClick={() => set({ split: false })}
            title="Kept in the original sound, lowered while the Khmer speaks">Lower</button>}
          <button type="button" className={split && !m.voices ? "on" : ""} disabled={!canSplit && !clone}
            onClick={() => set({ split: true, voices: 0 })}>Remove</button>
          <button type="button" className={split && m.voices > 0 ? "on" : ""} disabled={!canSplit && !clone}
            onClick={() => set({ split: true, voices: m.voices || 15 })} title="Quietly under the Khmer, like a documentary">Custom</button>
        </div>
        {split && m.voices > 0 && (
          <label className="slider-row"><span>Voice level</span>
            <input type="range" min={5} max={100} step={5} value={m.voices} onChange={(e) => set({ voices: +e.target.value })} /><b>{m.voices}%</b></label>
        )}
        {!canSplit && !clone ? <small className="note">Removing them needs the voice tools (npm run setup); until then they can only be lowered.</small>
          : split && <StemStatus stems={stems} onRetry={onRetry} />}
        <label className="slider-row"><span>{split ? "Music & effects" : "Original sound"}</span>
          <input type="range" min={0} max={100} step={5} value={m.music} onChange={(e) => set({ music: +e.target.value })} /><b>{m.music}%</b></label>
        <label className="slider-row"><span>…while someone speaks</span>
          <input type="range" min={0} max={100} step={5} value={m.duck < 0 ? 15 : m.duck} disabled={m.duck < 0} onChange={(e) => set({ duck: +e.target.value })} />
          <label className="check inline"><input type="checkbox" checked={m.duck < 0} onChange={(e) => set({ duck: e.target.checked ? -1 : 15 })} /><span>Auto</span></label></label>
      </fieldset>

      <h4>Your background music</h4>
      {track && <audio src={track} controls preload="none" className="bgm-player" />}
      <div className="row">
        <button type="button" className="btn ghost sm" onClick={() => input.current?.click()}>{track ? "Replace music" : "Upload music"}</button>
        {track && <button type="button" className="btn ghost sm" onClick={remove}>Remove</button>}
        <input ref={input} type="file" accept=".mp3,.m4a,.aac,.wav,.ogg,.flac,audio/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </div>
      <label className="slider-row"><span>Music level</span>
        <input type="range" min={0} max={60} step={5} value={m.bgm} disabled={!track} onChange={(e) => set({ bgm: +e.target.value })} /><b>{m.bgm ? `${m.bgm}%` : "off"}</b></label>
      <small className="note">Repeats to the end; quieter while someone speaks. Use music you have the rights to.</small>
      {err && <div className="err">{err}</div>}
      <label className="check"><input type="checkbox" checked={m.loudnorm} onChange={(e) => set({ loudnorm: e.target.checked })} />
        <span>Normalise loudness<small>−14 LUFS, as YouTube, Facebook and TikTok play (applied on export)</small></span></label>
    </div>
  );
}

/** Whether the voices are separated yet: the preview can only leave them out once they are. */
function StemStatus({ stems, onRetry }: { stems: StemState; onRetry: () => void }) {
  if (!stems.project) return <small className="note">They are separated from the music while the video is processed.</small>;
  if (stems.ready) return <small className="ok-note">✓ Separated – the preview plays the music without them.</small>;
  if (stems.task) return (
    <div className="stem-wait">
      <small className="note">Separating voices from music… {Math.round(stems.task.progress * 100)}% – until then the preview still has them.</small>
      <div className="mini-bar wide"><i style={{ width: `${stems.task.progress * 100}%` }} /></div>
    </div>
  );
  if (stems.error) return <div className="err">{stems.error} <button type="button" className="btn ghost sm" onClick={onRetry}>Try again</button></div>;
  return <small className="note">Starting to separate them from the music…</small>;
}

/** Khmer voice, original voice sound and per-part levels (right panel of Audio). */
export function SoundShaping({ value: m, onChange, split, now, selectedPart, onSelectPart }: MixProps & {
  split: boolean; now: number; selectedPart: number | null; onSelectPart: (i: number | null) => void;
}) {
  const set = (p: Partial<Mix>) => onChange({ ...m, ...p });
  const setPart = (i: number, p: Part) => set({ parts: m.parts.map((x, k) => (k === i ? p : x)) });
  return (
    <div className="pane">
      <h4>Khmer voice</h4>
      <label className="slider-row"><span>Volume</span>
        <input type="range" min={-10} max={10} step={1} value={m.voice} onChange={(e) => set({ voice: +e.target.value })} onDoubleClick={() => set({ voice: 0 })} />
        <b>{m.voice > 0 ? "+" : ""}{m.voice} dB</b></label>
      <ToneControls value={m.khmerTone} onChange={(t) => set({ khmerTone: t })} live />

      <h4>Original voices</h4>
      <fieldset className="pane-group" disabled={!split || !m.voices}>
        <ToneControls value={m.origTone} onChange={(t) => set({ origTone: t })} echo={false} live />
      </fieldset>
      {(!split || !m.voices) && <small className="note">Separate voices from music and keep them (level above 0) to change their sound.</small>}

      <h4>Volume for parts</h4>
      {m.parts.map((p, i) => (
        <PartRow key={i} value={p} on={selectedPart === i} onFocus={() => onSelectPart(i)} onChange={(x) => setPart(i, x)}
          onRemove={() => { set({ parts: m.parts.filter((_, k) => k !== i) }); onSelectPart(null); }} />
      ))}
      <button type="button" className="btn ghost sm" disabled={m.parts.length >= 30} onClick={() => {
        set({ parts: [...m.parts, { from: Math.floor(now * 10) / 10, to: Math.floor(now * 10) / 10 + 5, orig: 0, khmer: 100 }] });
        onSelectPart(m.parts.length);
      }}>+ Add a part at {clock(now)}</button>
      <small className="note">E.g. mute the original sound for one scene. Parts show in the timeline; 100% = unchanged.</small>
    </div>
  );
}

/** One stretch with its own levels; times are typed as 1:23 and taken when the field is left. */
function PartRow({ value: p, on, onFocus, onChange, onRemove }: {
  value: Part; on: boolean; onFocus: () => void; onChange: (p: Part) => void; onRemove: () => void;
}) {
  const [from, setFrom] = useState(clock(p.from, true)), [to, setTo] = useState(clock(p.to, true));
  useEffect(() => { setFrom(clock(p.from, true)); setTo(clock(p.to, true)); }, [p.from, p.to]);
  const take = (which: "from" | "to", v: string) => {
    const t = parseTime(v);
    if (Number.isNaN(t)) { setFrom(clock(p.from, true)); setTo(clock(p.to, true)); return; }
    onChange({ ...p, [which]: t });
  };
  return (
    <div className={`part-card ${on ? "on" : ""}`} onFocus={onFocus} onClick={onFocus}>
      <div className="row nowrap">
        <input type="text" value={from} onChange={(e) => setFrom(e.target.value)} onBlur={(e) => take("from", e.target.value)} title="From" />
        <span>–</span>
        <input type="text" value={to} onChange={(e) => setTo(e.target.value)} onBlur={(e) => take("to", e.target.value)} title="To" />
        <button type="button" className="btn ghost sm" onClick={onRemove} title="Remove this part">✕</button>
      </div>
      <label className="slider-row"><span>Original</span>
        <input type="range" min={0} max={150} step={5} value={p.orig} onChange={(e) => onChange({ ...p, orig: +e.target.value })} /><b>{p.orig}%</b></label>
      <label className="slider-row"><span>Khmer</span>
        <input type="range" min={0} max={150} step={5} value={p.khmer} onChange={(e) => onChange({ ...p, khmer: +e.target.value })} /><b>{p.khmer}%</b></label>
      {p.to <= p.from && <span className="err">The end is before the start</span>}
    </div>
  );
}
