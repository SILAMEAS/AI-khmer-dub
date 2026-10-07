# Khmer AI Dubber · បញ្ចូលសំឡេងខ្មែរ (Next.js)

Upload a Chinese or English video (or paste a link) and get back:

- 🎬 the video dubbed in Khmer, either
  - 🧬 **in each person's own voice** (voice cloning: a child stays a child, grandma stays grandma), or
  - with a **Khmer AI voice**: 🎭 auto (boy or girl per line, like the original speaker), 👦 boy (Piseth) or 👧 girl (Sreymom)
- 📝 **Khmer subtitles** as a `.srt` file and as a selectable track, optionally burned into the picture
  in your own style (any Khmer font – also your own .ttf/.otf –, size, colours, outline or box, top or bottom)
- 🏷️ **your logo** sliding across the picture once a minute (or every 30 s … 5 min)
- ✂️ only **part of the video** if you like (cut from … to …)
- 📱 in the **shape for each platform**: as the source, 16:9 YouTube, 9:16 TikTok / Reels / Shorts, 1:1 or 4:5 posts,
  at 1080p / 720p / 480p
- 🔊 a **sound mix you control**: the original voices removed (or kept quietly), music level, Khmer voice level and
  sound, your own background music, other levels for parts of the video – normalised to −14 LUFS like YouTube plays
- ✨ CapCut-style **effects**: cover the subtitles already in the video, filters (Vivid, Warm, Cool, Cinematic,
  Vintage, Black & white), brightness / contrast / saturation, sharpen, mirror, fade in & out, a progress bar,
  your text on the picture (channel name, episode) and animated subtitles (fade or pop)
- 📝 the original-language `.srt`, plus the Khmer audio on its own
- ⚡ **subtitles the video already has** (an English or Chinese track in the file, or the uploader's subtitles on
  YouTube / Bilibili …) are used as they are instead of listening with Whisper – much faster. Subtitles burned into
  the picture are not read. With 🎭 auto, 👦 boy or 👧 girl the voices are separated from the music in the
  background, so the Khmer voice is ready without waiting for it

---

## Quick start (Windows 10/11)

### Step 1 – Get the code (once)

Open **PowerShell**, go to the drive with the most free space (the app downloads ~9 GB into its own folder,
never onto drive C:), and clone the project:

```powershell
D:
git clone https://github.com/SILAMEAS/AI-khmer-dub.git
cd AI-khmer-dub
```

No git? Download the ZIP from GitHub (**Code → Download ZIP**), unzip it on drive D: and open that folder instead.

### Step 2 – Run one command

```powershell
.\start.cmd
```

Or **double-click `start.cmd`** in File Explorer. That's all – nothing else to install or configure by hand.

The first time, it installs everything by itself (15–30 minutes, mostly downloads):

```text
[1/7] Checking this PC and installing Node packages
[2/7] ffmpeg (audio and video processing)
[3/7] Speech recognition (whisper.cpp) and video downloader (yt-dlp)
[4/7] Speech recognition models
[5/7] Python for voice cloning
[6/7] Voice cloning packages and models (~5 GB, takes a while the first time)
[7/7] Building the app
Khmer AI Dubber: http://127.0.0.1:5000
```

Nothing is installed on drive C: ffmpeg, Python and (when the PC has none) Node.js are downloaded as portable
copies into the project folder, and npm's cache and temporary files stay there too.
If it stops with a message, follow it (see [If something goes wrong](#if-something-goes-wrong)) and run `.\start.cmd` again –
it continues where it stopped.

### Step 3 – Use it

The browser opens **<http://127.0.0.1:5000>** by itself. Upload a video, pick a voice, click **Start dubbing**.
**Keep the `start.cmd` window open** while you use the app – closing it stops the app.

### Every time after that

```powershell
cd D:\AI-khmer-dub
.\start.cmd
```

(or double-click `start.cmd`). It starts in a few seconds.

### Getting updates

```powershell
cd D:\AI-khmer-dub
git pull
.\start.cmd
```

`start.cmd` notices what changed and re-installs or rebuilds only what is needed.

### What `start.cmd` does

1. Uses the Node.js on the PC, or downloads a portable Node.js LTS into `bin\node` if there is none. npm's cache
   (`.cache\npm`) and all temporary files (`tmp\`) are kept in the project folder.
2. Runs **`npm run setup`** – the first time, and again whenever `scripts/setup.mjs` or `package-lock.json` changed
   (it remembers a fingerprint in `.setup-done.json`). Setup is the table below.
3. Runs **`npm run build`** when the code changed since the last build.
4. Starts the app and opens the browser.

It is a `.cmd` file on purpose: new Windows PCs block PowerShell scripts (`.ps1`) by default; `start.cmd` runs
`start.ps1` anyway, so nothing has to be changed in Windows.

### What setup installs and configures

| # | Step | What happens | Where it goes | Size |
|---|---|---|---|---|
| 1 | Checks | Node.js version, free disk space | – | – |
|   | Node packages | `npm install` (Next.js, React, msedge-tts) | `node_modules/` | ~0.5 GB |
| 2 | **ffmpeg** | **downloaded**: gyan.dev's full build (`.zip` from GitHub; it has rubberband and draws Khmer subtitles correctly – other builds don't), or copied in if that build is already on the PC | `bin/` | ~0.4 GB |
| 3 | **whisper.cpp** | speech recognition program (newest Windows build) | `bin/whisper/` | small |
|   | **yt-dlp** | downloads videos from links (updates itself once a day) | `bin/yt-dlp.exe` | small |
|   | **aria2c** | downloads each video file over 8 connections at once | `bin/aria2c.exe` | small |
|   | **Deno** | runs YouTube's JavaScript for yt-dlp (without it: 480p at most, or "not a bot" errors) | `bin/deno.exe` | ~0.1 GB |
| 4 | Speech models | Whisper `large-v3-turbo` + Silero VAD (skips music and silence) | `models/` | ~0.6 GB |
| 5 | **Python 3.12** | a **portable** Python downloaded into the project (nothing installed in Windows); an existing environment made from a Python elsewhere is moved here | `py/python/` | ~0.1 GB |
|   | Python environment | a private environment just for this app | `py/venv/` | – |
| 6 | Voice cloning packages | PyTorch (CPU) 2.14.1, Demucs 4.1.0, OpenVINO 2026.4.1, transformers 4.57.6, librosa, … – **exact tested versions** | `py/venv/` | ~1.5 GB |
|   | Seed-VC | voice conversion code, pinned to the tested version (downloaded as a zip, git not needed) | `py/src/seed-vc/` | small |
|   | Voice models | MDX-Net Kim Vocal 2 + Demucs (voice/music separation), Seed-VC, Whisper-small, BigVGAN | `models/hf/` | ~2.7 GB |
| 7 | Build | `npm run build` | `.next/` | small |

Temporary files and download caches stay in the folder too (`tmp/`, `.cache/npm/`, `py/tmp/`, `py/cache/`).

### Setup options

You normally don't need these: `start.cmd` runs setup for you. To choose options, run setup yourself once –
`start.cmd` remembers your choice (for example `--no-clone`) next time.

```powershell
npm run setup                   # everything (recommended)
npm run setup -- --no-clone     # no Python, ~5 GB less: AI voices only, and the original voices can only be lowered, not removed
npm run setup -- --all          # also the medium + small Whisper models (faster, less accurate recognition)
npm run setup -- --no-build     # skip the build at the end
```

`--no-clone` can be undone later: just run `npm run setup` again.

### If something goes wrong

| Message | What to do |
|---|---|
| `Node.js 20.9 or newer is needed` | your Node.js is too old: install the current LTS from <https://nodejs.org>, then run `start.cmd` again |
| A download of ffmpeg, Python or Node.js failed | check the internet connection and run `start.cmd` again; or put `ffmpeg.exe` + `ffprobe.exe` into `bin\`, or set `$env:PYTHON` to a Python 3.12 |
| `running scripts is disabled on this system` | you ran `start.ps1` directly – use `start.cmd` instead |
| `Only X GB free on D:\` | free some space, or move the project folder to a bigger drive and run `start.cmd` there |
| A download stopped halfway | run `start.cmd` again – it continues where it stopped |
| `The Python environment is broken` | happens when the Python it was made from is uninstalled; setup rebuilds it by itself |

To use a specific Python, set it before running setup: `$env:PYTHON = "D:\Python312\python.exe"; npm run setup`

---

## Start the app (every time)

```powershell
.\start.cmd
```

It opens **<http://127.0.0.1:5000>** for you. Translation and the Khmer AI voices need internet.

## Using it

The editor looks like CapCut: **tools on the left**, **the video in the middle**, **settings on the right** and a
**timeline** at the bottom. Everything you change shows **live in the player** – subtitles, text, logo, filters,
the band over old subtitles, the shape, and the sound (levels, bass / treble, echo, music, parts). Nothing is
merged until you press **Export**, so editing is instant.

```text
┌─ top bar: project · progress · Export ─────────────────────────────────────────┐
│ 📁 🗣 💬 T │ left panel       │          video player          │ right panel     │
│ 🎨 ✨ 🎵 🏷 │ (choose)         │   ▶ 0:12 / 1:47 · shape · 📷   │ (adjust)        │
├───────────┴─────────── timeline: cut · subtitle lines · sound parts ────────────┤
```

1. **📁 Media** – **Import video** (or drop it on the player, or paste a link), the original language, and
   *Check the translation first*. To dub only a part, drag the white **cut handles** in the timeline (or type the
   times on the right). Press **▶ Start dubbing**. Your projects are listed here too (✕ deletes one with its files).
2. **🗣 Voice** – 🧬 *Original voices*, 🎭 *Auto*, 👦 *Boy* or 👧 *Girl*, speaking speed, *sound like the speaker*.
   With original voices, play each **Person** found in the video.
3. **💬 Captions** – every line, editable, with **Find / Replace all**. Click a line (here or in the timeline) to
   jump to it; on the right you can play it, edit the Khmer, change who says it (or 👦 / 👧). Edited lines get a
   yellow dot. On the right: the **subtitle style** – presets, font (or *Upload*), size, colours, outline or box,
   top or bottom, animation (fade / pop), *Khmer + original*.
4. **T Text** – text shown the whole time (channel name, episode), its corner, size and colour.
5. **🎨 Filters** – Vivid, Warm, Cool, Cinematic, Vintage, B & W; brightness, contrast, saturation, sharpen.
6. **✨ Effects** – **hide the original subtitles** (a blurred or solid band: move it over the old text while
   watching), mirror, fade in & out, progress bar.
7. **🎵 Audio** – *Keep original sound* or *Khmer voice only*; **Original voices: Lower / Remove / Custom**
   (*Remove* is the default: the voices are separated from the music by themselves, in the background, about half
   a minute for 2 minutes of video, and the preview then plays the music without them); music level between lines
   and while someone speaks; **your own background music**; the Khmer voice's volume, bass, treble and echo;
   **volume for parts** of the video (shown in the timeline). Only *pitch* is heard after the voices are remade or
   the video is exported.
8. **🏷 Logo** – upload it once; it slides across the picture every 30 s – 5 min.
9. **⬆ Export** – shape (16:9, 9:16 TikTok, 1:1, 4:5), how the empty space is filled, resolution, quality. **Export**
   merges everything into one MP4 and lists the downloads: the video, Khmer `.srt`, Khmer + original `.srt`,
   original `.srt`, Khmer audio. *Exported* in the player shows the finished file; 📷 renders one exact frame.

**Voice changes apply by themselves**: change the voice, the speed or *sound like the speaker* and the new voices
are made in a moment; edit a line and its voice is remade 2 s after you stop typing – only what changed, in seconds.
The player then uses them; no need to export.

You can open a project at a tool and a moment with a link: `http://127.0.0.1:5000/?job=<id>&tab=captions&t=1:30`.

### How long it takes

Without an NVIDIA graphics card everything runs on the processor. On a 12-core PC:

| Voice | Speed |
|---|---|
| 🎭 Auto / 👦 Boy / 👧 Girl | ~1 minute for a 5-minute video (speech recognition alone takes ~40–60 s of that) |
| 🧬 Original voices | ~5 s per spoken line: a 5-minute video ~8–10 minutes |
| Editing (subtitles, logo, effects, sound) | instant – shown live in the player |
| Update voices after editing lines | a few seconds: only the edited lines |
| Export | measured ~35 s for a 1:47 video with burned-in subtitles (the picture is encoded again); faster when nothing on the picture changes |

Times vary by ±30% from run to run on the same PC, and grow when anything else uses the processor
(for example two dubbing jobs at once).
A 5-minute video in 20 seconds would need a fast NVIDIA graphics card – and even then only for the AI voices.

Start with a short clip to try it.

---

## How it works

| Step | Tool |
|---|---|
| Download link | `bin/yt-dlp.exe` + `bin/deno.exe` (YouTube, Facebook, TikTok, Bilibili, Douyin … up to 1080p), with the site's own subtitles – see [Video links](#video-links) |
| Subtitles already there | an English / Chinese subtitle track in the file, or the uploader's subtitles on the site, are used instead of Whisper (`lib/captions.ts`) |
| Speech → text | whisper.cpp + `large-v3-turbo` (or medium / small). Silero VAD finds where people speak (on the voices separated from the music when possible); the speech is glued together, recognised, and every word is put back at its real time – a new line at every pause; speech that came back empty is listened to again |
| Who speaks (AI voices) | pitch of each line (YIN, `lib/voice.ts`) → boy or girl voice |
| Original voices | MDX-Net Kim Vocal 2 (OpenVINO, on the Intel graphics + CPU) splits voices from music, Demucs when that is missing → CAMPPlus voice prints group lines by person and split a line where someone cuts in → a voice sample per person → Seed-VC re-speaks each Khmer line in that person's voice (`scripts/voice_clone.py`, `lib/clone.ts`) |
| Translate → Khmer | Google Translate, sent in batches so lines keep their context |
| Khmer voice | Microsoft Edge neural voices via `msedge-tts`, 8 lines in parallel; pitch moved toward the original speaker; long lines spoken faster by the voice itself |
| Sync | each line fitted into its original time slot (ffmpeg `rubberband`, or `atempo`, at most 1.6× faster), loudness follows the original, short fades against clicks |
| Soundtrack | original voices removed (separated in the background, see above), lowered, or kept at a level you choose; music dips while people speak; your own music mixed in |
| Output | ffmpeg: video copied as-is, or re-encoded when subtitles are burned in |

### Video links

A link goes through these steps (`lib/download.ts`); after step 7 it is exactly like an uploaded file.

| # | Step | What happens |
|---|---|---|
| 1 | Read the link | the first `https://…` in what was pasted – a whole share text works too ("复制打开抖音 https://v.douyin.com/… 看看") |
| 2 | Start on paste | the moment a link is pasted it starts downloading by itself – what the site says (title and length are shown, or why it can't be downloaded) and then the **sound** – into `jobs/_prefetch/`; while you choose the voice and settings it keeps going, and **Start** takes it over (in our test the sound was handed to the pipeline 0.08 s after Start). Not started within 2 hours: deleted |
| 3 | Update yt-dlp | at most once a day (`yt-dlp -U`); sites change often, and an old yt-dlp is the most common reason links stop working |
| 4 | Ask the site once | title, formats and subtitles are read once (on paste, or on Start) (yt-dlp with Deno for YouTube's JavaScript, the proxy from **Network**, 30 s timeouts and many retries) and saved as `info.json`; the downloads use it instead of asking again |
| 5 | Download, fast | the **picture and the sound at the same time**, each file over **8 connections** (aria2c) or 8 pieces at once (streamed formats); the picture no bigger than the export size (Export → size, short side: 480 / 720 / 1080), so nothing is downloaded only to be thrown away; a stopped download goes on where it stopped |
| 6 | Start before the end | as soon as the **sound** is in (a few MB), subtitles, speech recognition and translation start; the picture keeps coming meanwhile and is merged into `input.mp4` (and cut, for a part of the video) at the end – for most videos the download takes no extra time at all |
| – | Sign-in (only if asked) | when YouTube says "confirm you're not a bot", the download runs again with the YouTube login of Firefox, Edge or Chrome on this PC (as chosen under **Network**) |
| 7 | Subtitles | the uploader's English / Chinese subtitles come down with the sound into `captions/` and are used instead of Whisper |
| 8 | Checked whole | every downloaded file's length is compared with the video's: a download can end early while saying all went well (an 82-minute film once came back as 25 s of picture and 60 s of sound). A short file is deleted and downloaded again with fresh addresses (still over 8 connections), and only after a second short file with yt-dlp's own downloader in 10 MB requests (one connection: on networks that slow each connection down it measured ~2 KB/s against ~3.6 MB/s with aria2c); a short `input.mp4` from an earlier try is never reused |
| ✗ | When it fails | the reason in plain words with what to do (network blocked, sign-in, private, removed, blocked in your country, unsupported link, live stream), then yt-dlp's own last error line; a download where nothing comes through for 4 minutes (aria2c keeps printing `DL:0B` then) is reconnected with fresh addresses and goes on where it stopped, up to 5 times |

**Long videos (up to 4 hours and more).** Before downloading, the free disk space is checked against the video's
length (about 25 GB for 4 hours at 1080p: the download, the work files and the export). The site's download
addresses expire after some hours (YouTube's after ~6): when the site starts answering "403 Forbidden", the download
is stopped at once, the site is asked for new addresses, and it goes on where it stopped (an hour-old answer is
renewed before a download even starts). Waits between retries grow from 1 s to 8 s at most. Progress shows the file size, speed and time left (`Downloading video 40% of 3.0GiB · 3.5MiB/s · 9m35s left`); the free-space check also uses the file size the site gives (plain `.mp4` links often have no length), and the picture and sound are merged without a second pass over the file. Unfinished pieces of
streamed videos are an error, never silently left out. The dubbed lines are lined up on disk, not in memory
(a 4-hour film: 0.12 GB instead of 2.5 GB).

**If links fail but uploads work**, the network is the cause almost every time. Some networks (offices, schools)
block or slow video sites: `google.com` loads but YouTube, TikTok, Facebook and Bilibili time out, and after a few
timeouts YouTube starts asking "confirm you're not a bot". Then:

- use another connection (a phone hotspot or home Wi-Fi), or
- put your proxy / VPN address under **Media → Video link → Network** (e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`), or
- download the video another way and use **Upload file** (it is processed exactly the same).

For "not a bot" on a good connection: sign in to YouTube in Firefox (works best – Chrome and Edge often lock their
logins away from other programs), close Firefox, and try again.

### Folders

| Folder | Contents | In git? |
|---|---|---|
| `app/` | the editor (`page.tsx`; `editor/`: `Player.tsx` live preview, `Timeline.tsx`, `look.tsx` picture settings, `sound.tsx` sound settings and live sound, `common.ts`) and API routes (`api/*`) | yes |
| `lib/` | `pipeline.ts` (all processing steps), `download.ts` (video links), `captions.ts` (subtitles already in the video), `jobs.ts` (queue), `voice.ts` (pitch), `clone.ts` (voice cloning bridge), `branding.ts` (subtitle style, fonts, logo), `tools.ts` | yes |
| `branding/` | your logo and uploaded fonts, used for every video | no |
| `scripts/` | `setup.mjs` (installer), `voice_clone.py` (separation, speakers, cloning) | yes |
| `bin/`, `models/`, `py/` | downloaded programs (ffmpeg, whisper.cpp, yt-dlp, a portable Node.js if needed), models, the portable Python (`py/python`) and its environment (`py/venv`) – made by `npm run setup` | no |
| `tmp/`, `.cache/` | temporary files and npm's download cache (kept off drive C:) | no |
| `jobs/<id>/` | one folder per video you dub (input, subtitles, voices, output) – delete old ones to free space | no |

Only dub videos you have the rights to use, and only copy people's voices with their permission.
