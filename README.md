# Khmer AI Dubber · បញ្ចូលសំឡេងខ្មែរ (Next.js)

Upload a Chinese or English video (or paste a link) and get back:

- 🎬 the video dubbed with a **Khmer AI voice**: 👦 boy (Piseth) or 👧 girl (Sreymom)
- 📝 **Khmer subtitles** as a `.srt` file and as a selectable track, optionally burned into the picture
- 📝 the original-language `.srt`, plus the Khmer audio on its own

## First time

```powershell
npm install
npm run setup      # downloads whisper.cpp, yt-dlp and the speech models (~1.6 GB)
npm run build
```

ffmpeg must be installed (`winget install Gyan.FFmpeg`).

## Every time

```powershell
.\start.ps1        # or: npm start   → http://127.0.0.1:5000
```

## How it works

| Step | Tool |
|---|---|
| Download link | `bin/yt-dlp.exe` (YouTube, Facebook, TikTok, Bilibili, … up to 1080p) |
| Speech → text | whisper.cpp + `large-v3-turbo` (or medium / small), Silero VAD to skip music |
| Translate → Khmer | Google Translate, sent in batches so lines keep their context |
| Khmer voice | Microsoft Edge neural voices via `msedge-tts`, 8 lines in parallel |
| Sync | each line is fitted into its original time slot (ffmpeg `atempo`, at most 1.6× faster) |
| Soundtrack | original audio lowered while people speak, music kept (or Khmer voice only) |
| Output | ffmpeg: video copied as-is, or re-encoded when subtitles are burned in |

Code: `lib/pipeline.ts` (all processing steps), `lib/jobs.ts` (queue), `app/api/*` (routes), `app/page.tsx` (UI).
Jobs are stored in `jobs/<id>/`.

Translation and the Khmer voices need internet. Only dub videos you have the rights to use.
