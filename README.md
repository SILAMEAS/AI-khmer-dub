# Khmer AI Dubber · បញ្ចូលសំឡេងខ្មែរ (Next.js)

Upload a Chinese or English video (or paste a link) and get back:

- 🎬 the video dubbed in Khmer, either
  - 🧬 **in each person's own voice** (voice cloning: a child stays a child, grandma stays grandma), or
  - with a **Khmer AI voice**: 🎭 auto (boy or girl per line, like the original speaker), 👦 boy (Piseth) or 👧 girl (Sreymom)
- 📝 **Khmer subtitles** as a `.srt` file and as a selectable track, optionally burned into the picture
- 📝 the original-language `.srt`, plus the Khmer audio on its own

---

## Quick start (Windows 10/11)

```powershell
git clone https://github.com/SILAMEAS/AI-khmer-dub.git
cd AI-khmer-dub
.\start.cmd
```

**`start.cmd` is the only command you ever need** – the first time and every time after (you can also double-click it).
It installs whatever is missing, builds the app, starts it and opens <http://127.0.0.1:5000>.
Close its window to stop the app.

- **First run:** 15–30 minutes, mostly downloads (~9 GB). Windows may ask once for permission to install Node.js, ffmpeg or Python.
- **After that:** starts in a few seconds.
- **After `git pull`:** it notices what changed and re-installs or rebuilds only what is needed.

Clone the project onto the drive with the most free space: everything it downloads is stored
**inside the project folder**, never on drive C:.

### What `start.cmd` does

1. Installs **Node.js LTS** with winget if it is not on the PC.
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
| 2 | **ffmpeg** | found on the PC, or **installed automatically with winget** (`Gyan.FFmpeg`, full build incl. rubberband) | WinGet's package folder | ~0.2 GB |
| 3 | **whisper.cpp** | speech recognition program (newest Windows build) | `bin/whisper/` | small |
|   | **yt-dlp** | downloads videos from links | `bin/yt-dlp.exe` | small |
| 4 | Speech models | Whisper `large-v3-turbo` + Silero VAD (skips music and silence) | `models/` | ~0.6 GB |
| 5 | **Python 3.12** | found on the PC (3.11 or 3.12), or **installed automatically with winget** (`Python.Python.3.12`, for the current user, PATH not changed) | Python's own folder | ~0.1 GB |
|   | Python environment | a private environment just for this app | `py/venv/` | – |
| 6 | Voice cloning packages | PyTorch (CPU) 2.14.1, Demucs 4.1.0, transformers 4.57.6, librosa, … – **exact tested versions** | `py/venv/` | ~1.5 GB |
|   | Seed-VC | voice conversion code, pinned to the tested version (downloaded as a zip, git not needed) | `py/src/seed-vc/` | small |
|   | Voice models | Demucs (voice/music separation), Seed-VC, Whisper-small, BigVGAN | `models/hf/` | ~2.7 GB |
| 7 | Build | `npm run build` | `.next/` | small |

Temporary files and download caches of the Python part also stay in the folder (`py/tmp/`, `py/cache/`).

### Setup options

You normally don't need these: `start.cmd` runs setup for you. To choose options, run setup yourself once –
`start.cmd` remembers your choice (for example `--no-clone`) next time.

```powershell
npm run setup                   # everything (recommended)
npm run setup -- --no-clone     # without voice cloning: no Python, ~5 GB less; you get the AI voices only
npm run setup -- --all          # also the medium + small Whisper models (faster, less accurate recognition)
npm run setup -- --no-build     # skip the build at the end
```

`--no-clone` can be undone later: just run `npm run setup` again.

### If something goes wrong

| Message | What to do |
|---|---|
| `Node.js 20.9 or newer is needed` | your Node.js is too old: install the current LTS from <https://nodejs.org>, then run `start.cmd` again |
| `... is missing and winget is not available` | install that program by hand (ffmpeg: <https://www.gyan.dev/ffmpeg/builds/>, Python 3.12: <https://www.python.org>), then run setup again |
| `... was installed but not found` | close the window and run `start.cmd` again (Windows only sees new programs in new windows) |
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

1. **Your video** – upload a file or paste a link; pick the original language (or auto detect).
2. **Khmer voice** – 🧬 *Original voices* (default when installed), 🎭 *Auto*, 👦 *Boy* or 👧 *Girl*.
3. Leave **"Let me check the translation first"** ticked: before the voices are made you can
   - fix the Khmer text of any line,
   - with *Original voices*: play each **Person** found in the video and change who says a line (dropdown on each line),
   - with *Auto*: switch a line between 👦 and 👧.
4. **Generate Khmer voice** → download the video, the Khmer `.srt`, the original `.srt` or the Khmer audio.
   You can re-dub later with another voice or setting without recognising the speech again.

### How long it takes

Without an NVIDIA graphics card everything runs on the processor. On a 12-core PC:

| Voice | Speed |
|---|---|
| 🎭 Auto / 👦 Boy / 👧 Girl | a few minutes for a 20-minute video |
| 🧬 Original voices | ~10–25 s per spoken line: a 2-minute clip ~10 min, a 20-minute video ~1–2 hours |

Start with a short clip to try it.

---

## How it works

| Step | Tool |
|---|---|
| Download link | `bin/yt-dlp.exe` (YouTube, Facebook, TikTok, Bilibili, … up to 1080p) |
| Speech → text | whisper.cpp + `large-v3-turbo` (or medium / small), Silero VAD to skip music, word timings |
| Who speaks (AI voices) | pitch of each line (YIN, `lib/voice.ts`) → boy or girl voice |
| Original voices | Demucs splits voices from music → CAMPPlus voice prints group lines by person and split a line where someone cuts in → a voice sample per person → Seed-VC re-speaks each Khmer line in that person's voice (`scripts/voice_clone.py`, `lib/clone.ts`) |
| Translate → Khmer | Google Translate, sent in batches so lines keep their context |
| Khmer voice | Microsoft Edge neural voices via `msedge-tts`, 8 lines in parallel; pitch moved toward the original speaker; long lines spoken faster by the voice itself |
| Sync | each line fitted into its original time slot (ffmpeg `rubberband`, or `atempo`, at most 1.6× faster), loudness follows the original, short fades against clicks |
| Soundtrack | original audio lowered while people speak, music kept; with original voices the old voices are removed completely |
| Output | ffmpeg: video copied as-is, or re-encoded when subtitles are burned in |

### Folders

| Folder | Contents | In git? |
|---|---|---|
| `app/` | web page (`page.tsx`) and API routes (`api/*`) | yes |
| `lib/` | `pipeline.ts` (all processing steps), `jobs.ts` (queue), `voice.ts` (pitch), `clone.ts` (voice cloning bridge), `tools.ts` | yes |
| `scripts/` | `setup.mjs` (installer), `voice_clone.py` (separation, speakers, cloning) | yes |
| `bin/`, `models/`, `py/` | downloaded programs, models and the Python environment – made by `npm run setup` | no |
| `jobs/<id>/` | one folder per video you dub (input, subtitles, voices, output) – delete old ones to free space | no |

Only dub videos you have the rights to use, and only copy people's voices with their permission.
