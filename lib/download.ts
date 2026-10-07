/**
 * Video links: everything between a pasted link and input.mp4 in the job folder, after which a link job goes
 * on exactly like an uploaded file.
 *
 *  1. the link is taken out of whatever was pasted (share texts: "看看这个 https://v.douyin.com/... 复制打开")
 *  2. yt-dlp is kept up to date (sites change often; an old yt-dlp is the most common reason links stop working)
 *  3. yt-dlp runs with Node.js for YouTube's JavaScript (without it YouTube gives 480p at most, or nothing),
 *     the proxy from the network settings, long timeouts and many retries for slow or flaky connections
 *  4. when YouTube asks to "confirm you're not a bot", the same download is tried again with the YouTube login of
 *     a browser on this PC (Firefox, Edge, Chrome)
 *  5. errors come back in plain words with what to do, instead of yt-dlp's last lines
 *
 * The site's own subtitles (English / Chinese) come down with the video, into captions/ (see lib/captions.ts).
 */
import { fs, fsp, path } from "./rt";
import { BIN, JOBS_DIR, probeDuration, run, tool } from "./tools";
import { BRANDING_DIR } from "./branding";

export type Report = (stage: string, frac: number, msg: string) => void;

// ---------------------------------------------------------------- network settings (branding/network.json)

/** proxy: "" or http(s):// / socks5:// address; browser: whose YouTube login to use when YouTube asks for one. */
export type NetworkSettings = { proxy: string; browser: "auto" | "firefox" | "edge" | "chrome" | "none" };
const BROWSERS = ["firefox", "edge", "chrome"] as const;
const SETTINGS_FILE = path.join(BRANDING_DIR, "network.json");

export function networkSettings(): NetworkSettings {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return parseNetwork(s);
  } catch { return { proxy: "", browser: "auto" }; }
}

export function parseNetwork(v: unknown): NetworkSettings {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const proxy = String(s.proxy ?? "").trim();
  if (proxy && !/^(https?|socks5h?|socks4a?):\/\/[^\s/]+(:\d+)?\/?$/i.test(proxy)) {
    throw new Error("Proxy must look like http://127.0.0.1:8080 or socks5://127.0.0.1:1080");
  }
  const browser = ["auto", ...BROWSERS, "none"].includes(String(s.browser)) ? s.browser as NetworkSettings["browser"] : "auto";
  return { proxy, browser };
}

export function saveNetworkSettings(s: NetworkSettings) {
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 1), "utf8");
}

// ---------------------------------------------------------------- 1. the link

/** The first web link in pasted text, without trailing punctuation; null when there is none. */
export function extractUrl(text: string): string | null {
  const m = String(text).match(/https?:\/\/[^\s"'<>，。！？、【】《》“”]+/i);
  if (!m) return null;
  const url = m[0].replace(/[).,;!?]+$/, "");
  try { return new URL(url).href; } catch { return null; }
}

// ---------------------------------------------------------------- 2. yt-dlp up to date

const CHECKED = path.join(BIN, ".yt-dlp-checked");
let updating: Promise<void> | undefined;

/** Lets yt-dlp update itself, at most once a day (a few seconds; it carries on as it is when offline). */
export function updateYtDlp(report?: Report): Promise<void> {
  try {
    if (Date.now() - fs.statSync(CHECKED).mtimeMs < 24 * 3600_000) return Promise.resolve();
  } catch { /* never checked */ }
  updating ??= (async () => {
    report?.("download", 0, "Updating the video downloader");
    try {
      await run(tool("yt-dlp"), ["-U"]);
      await fsp.writeFile(CHECKED, new Date().toISOString());
    } catch (e) { console.error("yt-dlp update failed", e); }
  })().finally(() => { updating = undefined; });
  return updating;
}

// ---------------------------------------------------------------- 3. how yt-dlp runs

/**
 * What runs YouTube's JavaScript: Deno from bin/ (npm run setup puts it there), else the Node.js running this
 * app when it is new enough for yt-dlp (22 or later).
 */
function jsRuntime(): string[] {
  const deno = path.join(BIN, process.platform === "win32" ? "deno.exe" : "deno");
  if (fs.existsSync(deno)) return ["--js-runtimes", `deno:${deno}`];
  if (Number(process.versions.node.split(".")[0]) >= 22) return ["--js-runtimes", `node:${process.execPath}`];
  return [];
}

/** Options every yt-dlp call gets: YouTube's JavaScript through Node.js, proxy, patience on slow connections. */
function baseArgs(net: NetworkSettings, browser?: string): string[] {
  const args = [
    "--no-playlist", "--encoding", "utf-8", "--newline",
    ...jsRuntime(),
    "--socket-timeout", "30", "--retries", "15", "--fragment-retries", "30", "--extractor-retries", "5",
    // waits between retries: 1, 2, 3 … 8 s (page reads 2 … 10 s)
    "--retry-sleep", "http:linear=1:8", "--retry-sleep", "fragment:linear=1:8", "--retry-sleep", "extractor:linear=2:10:2",
  ];
  if (net.proxy) args.push("--proxy", net.proxy);
  if (browser) args.push("--cookies-from-browser", browser);
  return args;
}

/** Browsers to borrow a YouTube login from, in the order tried. */
function loginBrowsers(net: NetworkSettings): string[] {
  if (net.browser === "none") return [];
  return net.browser === "auto" ? [...BROWSERS] : [net.browser];
}

// ---------------------------------------------------------------- 5. errors in plain words

/** A short, clear reason with what to do, from yt-dlp's output. */
export function explain(raw: string, url: string, net: NetworkSettings): string {
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the site"; } })();
  const last = raw.split(/\r?\n/).filter((l) => /^ERROR:/.test(l)).pop()?.replace(/^ERROR:\s*/, "") ?? raw.trim().split(/\r?\n/).pop() ?? "";
  const detail = `\n\nDetails: ${last.slice(0, 400)}`;
  const slow = /timed out|Timeout|Connection (reset|refused|aborted)|RemoteDisconnected|getaddrinfo|Name or service|Unable to download (webpage|API)|TransportError|ConnectionError|WinError 100(5|6)\d|Failed to resolve|SSL/i.test(raw);
  const network = `This network blocks or slows down video sites (on some office networks google.com works but `
    + `YouTube, TikTok and Facebook don't). Try another internet connection (phone hotspot, home Wi-Fi), `
    + `${net.proxy ? "check your proxy" : "set a proxy / VPN under Network"}, or download the video another way and use Upload file.`;
  if (/not a bot|Sign in to confirm|cookies.*authentication/i.test(raw)) {
    // YouTube asks this mostly after many failed requests from the same place, e.g. on a blocked network
    return (slow ? `The connection to ${host} kept timing out, then ${host} asked to confirm you're not a bot. ${network} `
      + "On a good connection, signing in to YouTube in Firefox (works best), Edge or Chrome on this PC also helps - the app uses that login."
      : `${host} wants a signed-in user before it gives this video. Sign in to YouTube in Firefox (works best), `
      + "Edge or Chrome on this PC, close that browser, then try again - the app uses that login. Or download the video "
      + "another way and use Upload file.") + detail;
  }
  if (slow) return `Can't get the video from ${host}: the connection keeps timing out. ${network}` + detail;
  if (/Private video|private|members-only|Join this channel/i.test(raw)) return "This video is private or for members only - it can't be downloaded." + detail;
  if (/Video unavailable|has been removed|This video is no longer|does not exist|404/i.test(raw)) return "This video is unavailable (removed or the link is wrong)." + detail;
  if (/not available in your country|geo.?restrict|blocked it in your country/i.test(raw)) {
    return "This video is blocked in your country. A proxy / VPN in another country (under Network) can get it." + detail;
  }
  if (/age|inappropriate|confirm your age/i.test(raw)) return "This video is age-restricted: sign in to YouTube in Firefox, Edge or Chrome on this PC, then try again." + detail;
  if (/Unsupported URL/i.test(raw)) return "This link is not a video page the downloader knows. Open the video itself and copy its link." + detail;
  if (/live event|is live|premiere/i.test(raw)) return "This is a live stream or premiere that hasn't finished - try again once it's over." + detail;
  if (/Requested format is not available|nsig|signature|player/i.test(raw)) {
    return "The site changed and the downloader can't read it yet. It updates itself once a day - try again later, or use Upload file." + detail;
  }
  return `The video could not be downloaded from ${host}.` + detail;
}

const needsLogin = (raw: string) => /not a bot|Sign in to confirm|confirm your age|age-restricted|inappropriate/i.test(raw);
// a browser whose login could not be read: the next one is tried
const loginUnusable = (raw: string) => /cookie|could not (copy|find|decrypt)|DPAPI|Permission denied|browser/i.test(raw)
  && !needsLogin(raw);

// ---------------------------------------------------------------- 4. info: what the link holds

type Info = { title?: string; duration?: number; extractor_key?: string; extractor?: string; thumbnail?: string; _type?: string;
  formats?: { vcodec?: string; acodec?: string }[] };

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the site"; } };

/**
 * Asks the site once what the link holds (title, formats, subtitles). The downloads then use this answer
 * (--load-info-json) instead of asking again: on a slow network, asking is often the slowest part.
 * When YouTube wants a login, a browser's login is tried; the one that worked is returned for the downloads.
 */
async function readInfo(url: string, net: NetworkSettings, report: Report | undefined, quick: boolean) {
  const host = hostOf(url);
  const look = async (browser?: string): Promise<{ json?: string; err?: string; browser?: string }> => {
    let out = "";
    try {
      const args = [url, ...baseArgs(net, browser), "--skip-download", "-J"];
      if (quick) args.push("--retries", "3", "--extractor-retries", "2"); // later options win
      const json = await run(tool("yt-dlp"), args, {
        idleTimeout: (quick ? 2 : 5) * 60_000, // nothing at all for minutes: the network is not letting it through
        onLine: (l) => {
          if (l.startsWith("{")) return; // the answer itself
          out = (out + l + "\n").slice(-8000);
          const r = l.match(/Retrying \((?:attempt )?(\d+)\/(\d+)\)/i);
          if (r) report?.("download", 0, `Slow connection to ${host} - trying again (${r[1]}/${r[2]})`);
          else if (/Downloading (webpage|player|tv client config|.*API JSON)/i.test(l)) report?.("download", 0, `Reading the video page on ${host}`);
        },
      });
      return { json: json.toString("utf8"), browser };
    } catch (e) { return { err: out + "\n" + (e as Error).message }; }
  };
  report?.("download", 0, `Connecting to ${host}`);
  let r = await look();
  if (r.err && needsLogin(r.err)) {
    for (const b of loginBrowsers(net)) {
      report?.("download", 0, `${host} asks for a login - trying your ${b} login`);
      const again = await look(b);
      if (again.json || !loginUnusable(again.err!)) { r = again; break; } // read but did not help: stop here
    }
  }
  if (!r.json) throw new Error(explain(r.err!, url, net));
  const info = JSON.parse(r.json) as Info;
  if (info._type === "playlist") throw new Error("This is a playlist or channel link - open one video and copy its link.");
  return { info, json: r.json, browser: r.browser };
}

// ---------------------------------------------------------------- the download

const SUB_LANGS = "en,en-.*,en_.*,zh,zh-.*,zh_.*,chi,zho";
export const CAPTIONS_DIR = "captions";

/**
 * Many connections per file (aria2c, from bin/), and many pieces at once for streamed formats: networks and sites
 * that slow down each connection (YouTube does, and so did the office network we tested) give far more this way.
 */
function fastArgs(safe = false): string[] {
  const aria = path.join(BIN, process.platform === "win32" ? "aria2c.exe" : "aria2c");
  // a missing piece is an error (then retried with fresh addresses), never silently left out of the video
  const args = ["--concurrent-fragments", "8", "--abort-on-unavailable-fragments"];
  // safe: yt-dlp's own downloader in 10 MB requests - slower where connections are slowed down, but it is what
  // YouTube expects; used when aria2c's file came back short
  if (safe) args.push("--http-chunk-size", "10M");
  else if (fs.existsSync(aria)) {
    args.push("--downloader", aria, "--downloader", "dash,m3u8:native", "--downloader-args",
      "aria2c:-c -x 8 -s 8 -k 1M --file-allocation=none --max-tries=20 --retry-wait=2 --timeout=30 --connect-timeout=30 "
      + "--summary-interval=1 --console-log-level=warn --download-result=hide");
  }
  return args;
}

export type Downloaded = {
  title: string;
  /** the sound alone (or the whole video when the site has no separate sound): ready first, work starts on it */
  sound: string;
  /** whether `sound` is only the sound (the picture is still coming) */
  soundOnly: boolean;
  /** the finished video (input.mp4), merged once its picture has come down */
  video: Promise<string>;
  /** show the picture's download progress again (it goes on quietly while the sound is worked on) */
  watch: () => void;
};

/**
 * Downloads a link into the job folder. The picture and the sound come down at the same time; the sound (a few MB)
 * is back first, so recognition and translation can start while the picture is still coming; `video` gives the
 * merged input.mp4 at the end. The picture is taken no bigger than `maxRes` (the short side: 1080 for 1920×1080
 * and for 1080×1920), the size the video is exported at - more would be wasted time.
 * The site's own English / Chinese subtitles come down with the sound into captions/.
 * A download stopped half-way goes on where it stopped.
 */
export async function download(url: string, jd: string, report: Report, maxRes = 1080): Promise<Downloaded> {
  const pre = takePrefetch(url);
  if (pre) await adopt(pre, jd, report); // the sound may already be here: it started when the link was pasted
  return fetchLink(url, jd, report, maxRes, false) as Promise<Downloaded>;
}

/** What a site answers to an expired download address (yt-dlp, aria2c). */
const EXPIRED = /HTTP Error 40[13]|HTTP Error 410|403 Forbidden|status=40[13]|errorCode=(22|24)|addresses expired|URL.*expired/i;

// Files from an earlier start (a paste, or a first try) are used again: what the site said, and finished downloads
const INFO_TTL = 4 * 3600_000; // the site's download addresses stop working after some hours
const SOUND_FILE = /^sound\.(m4a|webm|mp4|opus|ogg|aac|mp3)$/i, WHOLE_FILE = /^input\.(mp4|mkv|webm|mov)$/i;

async function fetchLink(url: string, jd: string, report: Report, maxRes: number, soundOnly: boolean,
                         onInfo?: (info: Info) => void): Promise<Downloaded | void> {
  const net = networkSettings();
  await updateYtDlp(report);
  const captions = path.join(jd, CAPTIONS_DIR);
  await fsp.mkdir(captions, { recursive: true });
  const host = hostOf(url);

  const infoFile = path.join(jd, "info.json"), loginFile = path.join(jd, "info.login");
  let info: Info, browser: string | undefined;
  const infoAge = () => (fs.existsSync(infoFile) ? Date.now() - fs.statSync(infoFile).mtimeMs : Infinity);
  // asks the site again: its download addresses expire (YouTube's after ~6 h - a 4-hour film on a slow line, or
  // a link pasted long before Start, can outlive them). One refresh at a time for both parts.
  let refreshing: Promise<void> | undefined;
  const refresh = () => (refreshing ??= (async () => {
    let json: string;
    ({ info, json, browser } = await readInfo(url, net, report, false));
    await fsp.writeFile(infoFile, json, "utf8");
    await fsp.writeFile(loginFile, browser ?? "", "utf8");
  })().finally(() => { refreshing = undefined; }));
  if (infoAge() < INFO_TTL) {
    info = JSON.parse(await fsp.readFile(infoFile, "utf8"));
    browser = fs.existsSync(loginFile) ? (await fsp.readFile(loginFile, "utf8")) || undefined : undefined;
  } else await refresh();
  info = info!;
  onInfo?.(info);
  checkDisk(jd, Number(info.duration) || 0, soundOnly ? 0 : maxRes);
  if (!soundOnly && infoAge() > 3600_000) await refresh(); // a long download ahead: start with fresh addresses
  const title = String(info.title ?? "video");
  const formats = info.formats ?? [];
  // sound alone: no picture (some sites leave the sound codec out); picture alone: the sound codec is "none"
  const split = formats.some((f) => f.vcodec === "none" && f.acodec !== "none")
    && formats.some((f) => f.acodec === "none" && !!f.vcodec && f.vcodec !== "none");

  // progress of both parts together: the picture is most of the bytes
  const pct = { sound: 0, picture: split ? 0 : 1 }, speed = { sound: "", picture: "" };
  let watching = true, handedOff = false;
  const show = () => {
    if (!watching) return;
    const f = split ? 0.15 * pct.sound + 0.85 * pct.picture : pct.sound;
    const sp = [speed.sound, speed.picture].filter(Boolean).join(" + ");
    report("download", f, split && pct.sound >= 1
      ? `${handedOff ? "Finishing the video download" : "Sound ready, picture"} ${Math.round(pct.picture * 100)}%${sp ? ` · ${sp}` : ""}`
      : `Downloading video ${Math.round(f * 100)}%${sp ? ` · ${sp}` : ""}`);
  };

  /**
   * Whether a downloaded file is whole: a download can end early while the site says all went well (we saw an
   * 82-minute film come back as 25 s of picture and 60 s of sound). Short files are deleted.
   */
  const whole = async (file: string) => {
    const want = Number(info.duration) || 0, got = await probeDuration(file).catch(() => 0);
    if (!want || got >= want * 0.97 - 2) return true;
    console.error(`${path.basename(file)}: ${got.toFixed(0)} s of ${want.toFixed(0)} s - downloading it again`);
    await fsp.rm(file, { force: true });
    return false;
  };
  /** Unfinished pieces of a part (aria2c's have gaps: no other downloader may go on from them). */
  const dropPartials = async (name: string) => {
    for (const n of fs.readdirSync(jd).filter((n) => n.startsWith(name + ".") && /\.(part|aria2|ytdl)$|\.part-Frag/.test(n))) {
      await fsp.rm(path.join(jd, n), { force: true });
    }
  };

  /** One yt-dlp download from the saved info; resolves with the file it wrote. */
  const fetchOnce = async (part: "sound" | "picture", args: string[], name: string, wanted: RegExp, safe: boolean) => {
    const done = fs.readdirSync(jd).find((n) => wanted.test(n)); // finished before (a paste, or a first try)
    if (done && await whole(path.join(jd, done))) { pct[part] = 1; show(); return path.join(jd, done); }
    let out = "", file = "", refused = 0;
    // "403 Forbidden" over and over: the addresses expired, and retrying them is no use - stop, renew, go on
    const expired = new AbortController();
    try {
      await run(tool("yt-dlp"), [
        "--load-info-json", infoFile, ...baseArgs(net, browser), ...fastArgs(safe), "--progress",
        "--ffmpeg-location", path.dirname(tool("ffmpeg")), ...args,
        // --print would make yt-dlp quiet: its retry and "403 Forbidden" messages are needed here
        "-o", path.join(jd, `${name}.%(ext)s`), "--print", "after_move:FILE:%(filepath)s", "--no-quiet",
      ], {
        idleTimeout: 5 * 60_000,
        signal: expired.signal,
        onLine: (l) => {
          out = (out + l + "\n").slice(-8000);
          if (EXPIRED.test(l) && ++refused >= 4 && !expired.signal.aborted) expired.abort("download addresses expired");
          // yt-dlp: "[download]  12.3% of 50MiB at 1.2MiB/s"; aria2c: "[#2089b0 1.2MiB/33MiB(3%) CN:8 DL:2.1MiB ETA:15s]"
          const y = l.match(/\[download\]\s+([\d.]+)%(?:.*?\bat\s+(\S+\/s))?/), a = l.match(/\((\d+)%\).*?DL:(\S+)/);
          if ((y || a) && !/\.(srt|vtt)\b/.test(l)) {
            // streamed formats guess their size at first ("100% of ~1KiB"): their piece count is what's reliable
            const frag = l.match(/\(frag (\d+)\/(\d+)\)/);
            const now = frag ? +frag[1] / Math.max(1, +frag[2]) : Number(y ? y[1] : a![1]) / 100;
            pct[part] = Math.max(pct[part], Math.min(frag ? 0.99 : 1, now)); // never backwards (pieces report one by one)
            speed[part] = (y ? y[2] : a && `${a[2]}/s`) || speed[part];
            show();
          }
          const r = l.match(/Retrying \((?:attempt )?(\d+)\/(\d+)\)/i);
          if (r) report("download", 0, `Slow connection to ${host} - trying again (${r[1]}/${r[2]})`);
          if (l.startsWith("FILE:")) file = l.slice(5).trim();
        },
      });
    } catch (e) { out += "\n" + (e as Error).message; }
    if (!file || !fs.existsSync(file)) { // the printed path can be missing on some sites: look for the file itself
      const f = fs.readdirSync(jd).find((n) => wanted.test(n));
      if (f) file = path.join(jd, f);
    }
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error(explain(out, url, net)), { raw: out });
    if (!(await whole(file))) {
      throw Object.assign(new Error(`The download from ${host} stopped early and came back incomplete - try again.`), { raw: "INCOMPLETE\n" + out });
    }
    pct[part] = 1;
    speed[part] = "";
    show();
    return file;
  };
  /** fetchOnce, again with fresh addresses when the site says the old ones expired; it goes on where it stopped. */
  const fetchPart = async (part: "sound" | "picture", args: string[], name: string, wanted: RegExp) => {
    let safe = false;
    for (let attempt = 0; ; attempt++) {
      try { return await fetchOnce(part, args, name, wanted, safe); } catch (e) {
        const raw = (e as { raw?: string }).raw ?? "";
        if (attempt >= 3) throw e;
        if (raw.startsWith("INCOMPLETE")) { // came back short: again, from the start, with yt-dlp's own downloader
          report("download", 0, `The ${part} came back incomplete - downloading it again, more carefully`);
          safe = true;
          await dropPartials(name);
        } else if (EXPIRED.test(raw)) {
          report("download", pct[part], `The download address expired - asking ${host} for a new one`);
          await refresh();
        } else throw e;
        pct[part] = 0;
      }
    }
  };
  // the site's own subtitles, with the first part; a missing subtitle must not stop the download (-i)
  const subs = ["--write-subs", "--sub-langs", SUB_LANGS, "--sub-format", "srt/vtt/best", "--convert-subs", "srt", "-i"];
  const res = `res:${maxRes}`;

  if (!split) { // one file with picture and sound (TikTok, Facebook, plain video links...)
    const file = await fetchPart("sound", [...subs, "-f", "b/bv*+ba", "-S", `${res},ext:mp4:m4a`, "--remux-video", "mp4/mkv"],
      "input", WHOLE_FILE);
    await moveSubs(jd, captions);
    if (soundOnly) return;
    return { title, sound: file, soundOnly: false, video: Promise.resolve(file), watch: () => {} };
  }

  if (soundOnly) { // started on paste: the sound only - the picture comes on Start, at the export size then chosen
    await fetchPart("sound", [...subs, "-f", "ba", "-S", "ext:m4a"], "sound", SOUND_FILE);
    await moveSubs(jd, captions);
    return;
  }
  const picture = fetchPart("picture", ["-f", "bv*", "-S", `${res},ext:mp4`], "picture", /^picture\.(mp4|webm|mkv)$/i);
  picture.catch(() => {}); // awaited below; a failure is reported then
  const sound = await fetchPart("sound", [...subs, "-f", "ba", "-S", "ext:m4a"], "sound", SOUND_FILE);
  await moveSubs(jd, captions);
  watching = false; // the caller works on the sound now; the picture goes on quietly
  const video = picture.then(async (pic) => {
    if (watching) report("download", 1, "Putting picture and sound together");
    const out = path.join(jd, "input.mp4");
    const merge = (audio: string[]) => run(tool("ffmpeg"), ["-y", "-v", "error", "-i", pic, "-i", sound,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...audio, "-movflags", "+faststart", out]);
    // the sound as it is; re-encoded only when mp4 can't hold it (rare)
    await merge(["-c:a", "copy"]).catch(() => merge(["-c:a", "aac", "-b:a", "192k"]));
    await fsp.rm(pic, { force: true });
    return out;
  });
  video.catch(() => {}); // awaited by the caller
  return { title, sound, soundOnly: true, video, watch: () => { watching = handedOff = true; show(); } };
}

async function moveSubs(jd: string, captions: string) {
  for (const n of fs.readdirSync(jd).filter((n) => /^(input|sound)\..+\.(srt|vtt)$/i.test(n))) {
    await fsp.rename(path.join(jd, n), path.join(captions, n));
  }
}

// ---------------------------------------------------------------- started on paste

/**
 * A link starts downloading as soon as it is pasted: what the site says about it, and its sound (the part the work
 * starts on), into jobs/_prefetch/<id>. Start then takes these over (adopt) instead of starting from nothing.
 * Kept for 2 hours if Start is never pressed.
 */
export type Prefetch = {
  url: string; dir: string; done: Promise<void>;
  title?: string; duration?: number; site?: string;
  progress: number; message: string; ready: boolean; error?: string;
  forward?: Report; // the job that took it over shows its progress
};
const PREFETCH_DIR = path.join(JOBS_DIR, "_prefetch");
const PREFETCH_KEEP = 2 * 3600_000;
const g = globalThis as unknown as { __khmerPrefetch?: Map<string, Prefetch> };
const prefetches = (g.__khmerPrefetch ??= (() => {
  fs.rmSync(PREFETCH_DIR, { recursive: true, force: true }); // left from before a restart
  return new Map<string, Prefetch>();
})());

/** Starts (or finds) the download of a pasted link; resolves once the site has said what the link is. */
export async function startPrefetch(url: string, maxRes = 1080): Promise<Prefetch> {
  let p = prefetches.get(url);
  if (!p || p.error) {
    const dir = path.join(PREFETCH_DIR, Math.random().toString(36).slice(2, 10));
    fs.mkdirSync(dir, { recursive: true });
    let infoReady!: () => void;
    const info = new Promise<void>((r) => (infoReady = r));
    const entry: Prefetch = { url, dir, done: Promise.resolve(), progress: 0, message: "Starting", ready: false };
    const report: Report = (stage, frac, message) => {
      Object.assign(entry, { progress: frac, message });
      entry.forward?.(stage, frac, `${message} (started when the link was pasted)`);
    };
    entry.done = fetchLink(url, dir, report, maxRes, true, (i) => {
      Object.assign(entry, { title: String(i.title ?? "video"), duration: Number(i.duration) || 0,
        site: String(i.extractor_key ?? i.extractor ?? "") });
      infoReady();
    }).then(() => { Object.assign(entry, { ready: true, progress: 1, message: "Sound downloaded - ready to start" }); },
      (e) => { entry.error = (e as Error).message; });
    entry.done.finally(infoReady);
    prefetches.set(url, (p = entry));
    setTimeout(() => { // never started: let it go
      if (prefetches.get(url) !== entry) return;
      prefetches.delete(url);
      entry.done.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }, PREFETCH_KEEP).unref?.();
    await info;
  } else await Promise.race([p.done, new Promise((r) => setTimeout(r, 100))]);
  return p;
}

export const prefetchStatus = (url: string) => prefetches.get(url);

/** The paste-time download of this link, for the job that now starts (each one is taken once). */
function takePrefetch(url: string): Prefetch | undefined {
  const p = prefetches.get(url);
  if (p) prefetches.delete(url);
  return p;
}

/** Waits for a paste-time download (its progress shown in the job), then moves its files into the job folder. */
async function adopt(p: Prefetch, jd: string, report: Report) {
  p.forward = report;
  if (!p.ready && !p.error) report("download", p.progress, `${p.message} (started when the link was pasted)`);
  await p.done;
  p.forward = undefined;
  // moved (copied when the job folder is on another drive), keeping the times: info.json's age says if it's still good
  const move = (from: string, to: string) => fsp.rename(from, to)
    .catch(() => fsp.cp(from, to, { recursive: true, force: true, preserveTimestamps: true }));
  for (const n of fs.readdirSync(p.dir)) {
    const from = path.join(p.dir, n), to = path.join(jd, n);
    if (n === CAPTIONS_DIR && fs.existsSync(to)) {
      for (const c of fs.readdirSync(from)) await move(path.join(from, c), path.join(to, c));
    } else await move(from, to);
  }
  await fsp.rm(p.dir, { recursive: true, force: true });
}

/**
 * Stops before hours of downloading when the drive is too full for the video: the download itself, the exported
 * video (about as big) and the work files (separated voices and music, ~1 GB an hour). Picture 0: sound only.
 */
function checkDisk(jd: string, seconds: number, picture: number) {
  if (!seconds) return;
  const perSec = picture >= 1080 ? 700e3 : picture >= 720 ? 350e3 : picture ? 160e3 : 0; // bytes/s of picture
  const need = seconds * (2 * perSec + 300e3);
  try {
    const s = fs.statfsSync(jd), free = s.bavail * s.bsize;
    if (free < need) {
      const gb = (n: number) => (n / 1e9).toFixed(1);
      throw new Error(`Not enough disk space for this ${Math.round(seconds / 60)}-minute video: about ${gb(need)} GB is needed, `
        + `${gb(free)} GB is free. Free some space (or choose a smaller Export size) and try again.`);
    }
  } catch (e) { if ((e as Error).message.startsWith("Not enough")) throw e; } // statfs missing: no check
}

/**
 * The video of an earlier try of this link (input.*), when it is whole; a short one (a download that ended early)
 * is deleted so the link is downloaded again.
 */
export async function reusableInput(jd: string): Promise<string | undefined> {
  const name = fs.readdirSync(jd).find((n) => WHOLE_FILE.test(n));
  if (!name) return undefined;
  const infoFile = path.join(jd, "info.json");
  const want = fs.existsSync(infoFile) ? Number((JSON.parse(fs.readFileSync(infoFile, "utf8")) as Info).duration) || 0 : 0;
  const got = await probeDuration(path.join(jd, name)).catch(() => 0);
  if (want && got < want * 0.97 - 2) {
    console.error(`${name}: ${got.toFixed(0)} s of ${want.toFixed(0)} s - downloading the link again`);
    await fsp.rm(path.join(jd, name), { force: true });
    return undefined;
  }
  return name;
}
