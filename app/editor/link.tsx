"use client";
/**
 * The video link box. A pasted link (or a whole share text) starts downloading straight away - what the site says
 * about it, then its sound - so the work is already under way when Start is pressed. Also the network settings
 * (proxy, browser login) for networks that block video sites or for YouTube's "confirm you're not a bot".
 */
import { useEffect, useRef, useState } from "react";
import { api, clock } from "./common";

type Status = {
  url: string; title?: string; duration?: number; site?: string;
  progress: number; message: string; ready: boolean; error?: string;
};
type Network = { proxy: string; browser: "auto" | "firefox" | "edge" | "chrome" | "none" };

export function LinkBox({ value, onChange, size }: { value: string; onChange: (v: string) => void; size: number }) {
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);
  const current = useRef("");

  // a pasted link starts by itself (a moment after the last change, so typing doesn't start anything)
  useEffect(() => {
    setStatus(null); setError("");
    const text = value.trim();
    current.current = text;
    if (!/https?:\/\//i.test(text)) return;
    const t = setTimeout(async () => {
      setAsking(true);
      try {
        const s = await api<Status>("/api/link", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: text, size }) });
        if (current.current === text) setStatus(s);
      } catch (e) { if (current.current === text) setError((e as Error).message); } finally { setAsking(false); }
    }, 700);
    return () => clearTimeout(t);
  }, [value, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  // then how far the sound is
  useEffect(() => {
    if (!status || status.ready || status.error) return;
    const t = setInterval(async () => {
      try {
        const s = await api<Status>(`/api/link?url=${encodeURIComponent(status.url)}`);
        if (current.current !== value.trim()) return;
        setStatus(s);
        if (s.error) setError(s.error);
      } catch { /* taken over by a job, or gone */ }
    }, 1500);
    return () => clearInterval(t);
  }, [status?.url, status?.ready, status?.error]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Paste a link: YouTube, Facebook, TikTok, Bilibili, Douyin…" />
      {asking && <small className="note">⏳ Reading the link (slow networks can take a minute)…</small>}
      {status && !error && (
        <small className="note">
          ✅ {status.site && `${status.site}: `}<b>{status.title}</b>{status.duration ? ` · ${clock(status.duration)}` : ""}
          <br />{status.ready ? "🔊 Sound downloaded – Start goes straight to work"
            : `⬇ ${status.message} – already downloading, so Start is faster`}
        </small>
      )}
      {error && (
        <div className="row nowrap">
          <small className="err" style={{ flex: 1 }}>{error}</small>
          <button type="button" className="btn ghost sm" onClick={() => setTries((n) => n + 1)}>Try again</button>
        </div>
      )}
      <NetworkSettings />
    </>
  );
}

function NetworkSettings() {
  const [net, setNet] = useState<Network | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => { api<Network>("/api/network").then(setNet).catch(() => {}); }, []);
  if (!net) return null;

  async function save(n: Network) {
    setNet(n); setSaved("");
    try {
      await api("/api/network", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(n) });
      setSaved("Saved");
    } catch (e) { setSaved((e as Error).message); }
  }

  return (
    <details className="net">
      <summary>Network{net.proxy ? " · proxy on" : ""}</summary>
      <label className="f">Proxy / VPN (when this network blocks video sites)</label>
      <input type="text" value={net.proxy} placeholder="none – e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080"
        onChange={(e) => setNet({ ...net, proxy: e.target.value })} onBlur={() => save(net)} />
      <label className="f">When YouTube asks “are you a bot”, use the login of</label>
      <select value={net.browser} onChange={(e) => save({ ...net, browser: e.target.value as Network["browser"] })}>
        <option value="auto">Any browser on this PC (Firefox, Edge, Chrome)</option>
        <option value="firefox">Firefox (works best)</option><option value="edge">Edge</option>
        <option value="chrome">Chrome</option><option value="none">No browser</option>
      </select>
      <small className="note">Sign in to YouTube in that browser and close it before downloading. {saved}</small>
    </details>
  );
}
