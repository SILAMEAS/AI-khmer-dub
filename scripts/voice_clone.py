"""
Voice cloning worker for the Khmer dubber. Runs on CPU; started by lib/clone.ts.

  python voice_clone.py <command> <request.json> <result.json>
  python voice_clone.py download - -        (fetch all models once)

separate  {"input", "ffmpeg", "duration", "vocals", "background"}
          Splits the soundtrack into voices and everything else (Demucs htdemucs), 60 s at a time.
speakers  {"vocals", "lines": [{"start", "end"}], "out_dir", "threshold"}
          -> {"pieces": [{"line", "start", "end", "speaker"}], "refs": {speaker: wav}}
          Splits lines where another person starts talking, groups the pieces by who says them
          (CAMPPlus voice prints) and saves a voice sample per person.
convert   {"steps", "ref_seconds", "items": [{"src", "ref", "out"}]}
          Re-speaks each Khmer line in the voice of its speaker sample (Seed-VC, zero-shot).

Progress is printed as "PROGRESS <done> <total>".
"""
import json
import os
import subprocess
import sys
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_VC = os.path.join(ROOT, "py", "src", "seed-vc")
os.environ.setdefault("HF_HOME", os.path.join(ROOT, "models", "hf"))
os.environ.setdefault("TORCH_HOME", os.path.join(ROOT, "models", "torch"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TQDM_DISABLE", "1")
sys.path.insert(0, SEED_VC)

# Seed-VC imports descript-audio-codec only for an option this model does not use; skip that heavy package.
_dac = types.ModuleType("dac.nn.quantize")
_dac.VectorQuantize = None
sys.modules.update({"dac": types.ModuleType("dac"), "dac.nn": types.ModuleType("dac.nn"), "dac.nn.quantize": _dac})

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import torchaudio  # noqa: E402

# hyper-threads and efficiency cores slow these models down: about one thread per physical core is fastest
torch.set_num_threads(int(os.environ.get("VC_THREADS", 0)) or max(1, min(12, (os.cpu_count() or 4) // 2 + 1)))
VC_SR = 22050


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- separate

def cmd_separate(req):
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs").eval()
    sr, vi = model.samplerate, model.sources.index("vocals")
    chunk, ov = sr * 60, sr * 2  # 60 s pieces, 2 s cross-faded overlap
    fade = np.linspace(0, 1, ov, dtype=np.float32)[:, None]
    total = max(1, int(float(req["duration"]) * sr))

    dec = subprocess.Popen([req["ffmpeg"], "-v", "error", "-i", req["input"], "-vn", "-f", "f32le", "-ac", "2",
                            "-ar", str(sr), "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    voc_out = sf.SoundFile(req["vocals"], "w", sr, 1, "PCM_16")
    bg_out = sf.SoundFile(req["background"], "w", sr, 2, "PCM_16")

    def read(n):
        raw = dec.stdout.read(n * 8)
        return np.frombuffer(raw[: len(raw) // 8 * 8], dtype=np.float32).reshape(-1, 2)

    buf, tail_v, done = read(chunk + ov), None, 0
    while len(buf):
        x = torch.from_numpy(buf.T.copy())[None]
        mean, std = x.mean(), x.std() + 1e-8
        with torch.no_grad():
            v = apply_model(model, (x - mean) / std, shifts=0, overlap=0.1, split=True, progress=False)[0, vi]
        v = (v * std).numpy().T  # stereo vocals, same length as buf
        if tail_v is not None:
            n = min(ov, len(v))
            v[:n] = tail_v[:n] * (1 - fade[:n]) + v[:n] * fade[:n]
        last = len(buf) < chunk + ov
        keep = len(v) if last else chunk
        voc_out.write(v[:keep].mean(axis=1))
        bg_out.write(np.clip(buf[:keep] - v[:keep], -1, 1))
        done += keep
        log(f"PROGRESS {min(done, total)} {total}")
        if last:
            break
        tail_v = v[chunk:]
        buf = np.concatenate([buf[chunk:], read(chunk)])
    err = dec.stderr.read().decode("utf-8", "replace").strip()
    dec.wait()
    voc_out.close()
    bg_out.close()
    if not done:  # nothing decoded: say why instead of leaving two silent files
        raise RuntimeError("No sound could be read from the video" + (f": {err[-500:]}" if err else ""))
    return {"seconds": done / sr}


# ---------------------------------------------------------------- speakers

def load_campplus():
    from modules.campplus.DTDNN import CAMPPlus
    model = CAMPPlus(feat_dim=80, embedding_size=192)
    model.load_state_dict(torch.load(os.path.join(SEED_VC, "campplus_cn_common.bin"), map_location="cpu"))
    return model.eval()


def style_of(campplus, wave16k: torch.Tensor) -> torch.Tensor:
    feat = torchaudio.compliance.kaldi.fbank(wave16k, num_mel_bins=80, dither=0, sample_frequency=16000)
    return campplus((feat - feat.mean(dim=0, keepdim=True)).unsqueeze(0))


def trim(x: np.ndarray, sr: int) -> np.ndarray:
    """Cuts quiet edges (pauses, breaths, separation leftovers) off a line."""
    frame = sr // 50
    if len(x) < frame * 3:
        return x
    rms = np.sqrt(np.mean(x[: len(x) // frame * frame].reshape(-1, frame) ** 2, axis=1))
    loud = np.where(rms > rms.max() * 0.1)[0]
    return x[loud[0] * frame: (loud[-1] + 1) * frame] if len(loud) else x[:0]


def voice_print(campplus, x: np.ndarray, sr: int) -> np.ndarray:
    w = torchaudio.functional.resample(torch.from_numpy(np.ascontiguousarray(x))[None], sr, 16000)
    with torch.no_grad():
        return torch.nn.functional.normalize(style_of(campplus, w)[0], dim=0).numpy()


def change_points(campplus, x: np.ndarray, sr: int, depth: int = 0) -> list:
    """
    Sample offsets where another person starts talking inside one subtitle line.
    Whisper often puts a quick reply in the same line ("Are you coming? - Yes!"), which would mix two voices.
    Slides a 1 s window along the line and splits where the voices left and right of a point differ most.
    """
    win, hop = int(sr * 1.0), int(sr * 0.25)
    if depth > 2 or len(x) < win * 2 + hop:
        return []
    frame = sr // 50
    rms = np.sqrt(np.mean(x[: len(x) // frame * frame].reshape(-1, frame) ** 2, axis=1))
    starts = [s for s in range(0, len(x) - win + 1, hop)
              if rms[s // frame: (s + win) // frame].mean() > rms.max() * 0.15]  # windows with speech in them
    if len(starts) < 4:
        return []
    prints = {s: voice_print(campplus, x[s: s + win], sr) for s in starts}
    best, cut = 1.0, None
    for b in range(win, len(x) - win + 1, hop):
        left = [prints[s] for s in starts if s + win <= b]
        right = [prints[s] for s in starts if s >= b]
        if len(left) < 2 or len(right) < 2:
            continue
        l, r = np.mean(left, axis=0), np.mean(right, axis=0)
        sim = float(l @ r / (np.linalg.norm(l) * np.linalg.norm(r) + 1e-8))
        if sim < best:
            best, cut = sim, b
    if cut is None or best >= 0.5:  # same person; different people scored ~0.3 in our tests
        return []
    # move the cut into the pause between the two people (quietest 20 ms within 0.5 s)
    lo, hi = max(0, (cut - sr // 2) // frame), min(len(rms), (cut + sr // 2) // frame)
    cut = (lo + int(np.argmin(rms[lo:hi]))) * frame + frame // 2
    return (change_points(campplus, x[:cut], sr, depth + 1) + [cut]
            + [cut + c for c in change_points(campplus, x[cut:], sr, depth + 1)])


def listen(req):
    """Every line cut where the speaker changes ("pieces"), with its audio and voice print."""
    snd = sf.SoundFile(req["vocals"])
    sr = snd.samplerate
    campplus = load_campplus()
    lines, clips, emb, pitches = [], [], [], []
    for n, ln in enumerate(req["lines"]):
        a = max(0, int(ln["start"] * sr))
        snd.seek(a)
        x = snd.read(max(0, int((ln["end"] - ln["start"]) * sr)), dtype="float32", always_2d=False)
        # voice prints work at 16 kHz: convert the line once, not every window
        x16 = torchaudio.functional.resample(torch.from_numpy(np.ascontiguousarray(x))[None], sr, 16000)[0].numpy()
        cuts = [0] + [round(c * sr / 16000) for c in change_points(campplus, x16, 16000)] + [len(x)]
        for s, e in zip(cuts, cuts[1:]):
            part = trim(x[s:e], sr)
            part16 = trim(x16[round(s * 16000 / sr): round(e * 16000 / sr)], 16000)
            # whisper's line edges often hold the last word of the person before: judge the voice by the middle
            if len(part16) >= 16000 * 2:
                part16 = part16[6400:-6400]
            lines.append({"line": n, "start": (a + s) / sr, "end": (a + e) / sr})
            clips.append(part)
            # under a quarter second there is nothing to go on
            emb.append(voice_print(campplus, part16, 16000) if len(part16) >= 4000 else None)
            pitches.append(pitch(part16) if len(part16) >= 4000 else 0.0)
        if n % 20 == 0 or n == len(req["lines"]) - 1:
            log(f"PROGRESS {n + 1} {len(req['lines'])}")
    return lines, clips, emb, pitches, sr


def pitch(x16: np.ndarray) -> float:
    """Typical speaking pitch (Hz) of a 16 kHz clip; 0 if unclear."""
    import librosa
    f0 = librosa.yin(x16, fmin=65, fmax=420, sr=16000, frame_length=1024, hop_length=256)
    rms = librosa.feature.rms(y=x16, frame_length=1024, hop_length=256)[0][: len(f0)]
    voiced = f0[rms > rms.max() * 0.3] if len(rms) else f0[:0]
    return float(np.median(voiced)) if len(voiced) >= 5 else 0.0


def group(emb, seconds, pitches, threshold=0.65, merge=0.55):
    """
    Speaker number of each piece (-1: not decided yet).
    First a strict grouping of the pieces (never mixes people, but splits one person into several groups),
    then groups are joined when their average voices match: an average over several lines is much steadier
    than one short line, which is what made one-by-one merging mix people up. Groups whose typical pitch
    differs by more than 30% (a man and a woman, a child and a grandpa) are never joined.
    """
    from scipy.cluster.hierarchy import fcluster, linkage

    # people are grouped on lines of 1 s or more; shorter ones ("Yes.", "Oh!") give unsteady voice prints
    known = [i for i, e in enumerate(emb) if e is not None and seconds[i] >= 1]
    if not known:
        known = [i for i, e in enumerate(emb) if e is not None]
    spk = [-1] * len(emb)
    if len(known) == 1:
        spk[known[0]] = 0
    elif known:
        E = np.stack([emb[i] for i in known])
        ids = fcluster(linkage(E, method="average", metric="cosine"), t=1 - threshold, criterion="distance")
        for i, c in zip(known, ids):
            spk[i] = int(c)

    def average(c):  # duration-weighted mean voice print of a group
        members = [i for i in known if spk[i] == c]
        v = np.sum([emb[i] * seconds[i] for i in members], axis=0)
        return v / (np.linalg.norm(v) + 1e-8)

    def typical_pitch(c):
        p = [pitches[i] for i in known if spk[i] == c and pitches[i] > 0]
        return float(np.median(p)) if p else 0.0

    def same_range(a, b):
        return not a or not b or max(a, b) / min(a, b) <= 1.3

    while True:
        ids = sorted({c for c in spk if c >= 0})
        avg = {c: average(c) for c in ids}
        f0 = {c: typical_pitch(c) for c in ids}
        pairs = [(float(avg[a] @ avg[b]), a, b) for k, a in enumerate(ids) for b in ids[k + 1:]
                 if same_range(f0[a], f0[b])]
        if not pairs or max(pairs)[0] < merge:
            return spk
        _, a, b = max(pairs)
        spk = [a if s == b else s for s in spk]


def cmd_speakers(req):
    lines, clips, emb, pitches, sr = listen(req)
    seconds = [len(c) / sr for c in clips]
    spk = group(emb, seconds, pitches, float(req.get("threshold", 0.65)), float(req.get("merge", 0.55)))
    known = [i for i, s in enumerate(spk) if s >= 0]

    # short lines: the person whose voice is closest. In a dialogue the neighbouring line is usually the
    # other person, so this beats copying the neighbour.
    groups = {c: np.mean([emb[i] for i in known if spk[i] == c], axis=0) for c in set(spk) if c >= 0}
    for i in range(len(lines)):
        if spk[i] < 0 and emb[i] is not None and groups:
            spk[i] = max(groups, key=lambda c: float(emb[i] @ groups[c]) / (np.linalg.norm(groups[c]) + 1e-8))
    # nothing to hear at all: same person as the nearest line
    for i in range(len(lines)):
        if spk[i] < 0:
            near = sorted((j for j in range(len(lines)) if spk[j] >= 0), key=lambda j: abs(j - i))
            spk[i] = spk[near[0]] if near else 0

    order = {}  # number speakers in order of appearance
    for s in spk:
        order.setdefault(s, len(order))
    spk = [order[s] for s in spk]

    # voice sample per speaker: the lines most typical of that voice first, up to 12 s
    os.makedirs(req["out_dir"], exist_ok=True)
    refs = {}
    gap = np.zeros(int(sr * 0.12), dtype=np.float32)
    for c in sorted(set(spk)):
        mine = [i for i in range(len(lines)) if spk[i] == c and len(clips[i])]
        with_emb = [i for i in mine if emb[i] is not None]
        if with_emb:
            cc = np.mean([emb[i] for i in with_emb], axis=0)
            mine = sorted(with_emb, key=lambda i: -float(emb[i] @ cc)) + [i for i in mine if emb[i] is None]
        parts, total = [], 0
        for i in mine:
            parts += [clips[i], gap]
            total += len(clips[i])
            if total >= sr * 12:
                break
        if not parts:
            continue
        x = np.concatenate(parts)
        x = x / (np.abs(x).max() + 1e-6) * 0.9
        x = torchaudio.functional.resample(torch.from_numpy(x)[None], sr, VC_SR)[0].numpy()
        path = os.path.join(req["out_dir"], f"speaker_{c + 1}.wav")
        sf.write(path, x, VC_SR)
        refs[str(c)] = path
    return {"pieces": [{**ln, "speaker": s} for ln, s in zip(lines, spk)], "refs": refs}


# ---------------------------------------------------------------- convert

class SeedVC:
    """Seed-VC v1 voice conversion (whisper-small content, DiT, BigVGAN 22 kHz), loaded once."""

    def __init__(self):
        import yaml
        from huggingface_hub import hf_hub_download
        from modules.audio import mel_spectrogram
        from modules.bigvgan import bigvgan
        from modules.commons import build_model, load_checkpoint, recursive_munch
        from transformers import AutoFeatureExtractor, WhisperModel

        repo = "Plachta/Seed-VC"
        ckpt = hf_hub_download(repo, "DiT_seed_v2_uvit_whisper_small_wavenet_bigvgan_pruned.pth")
        cfg = yaml.safe_load(open(hf_hub_download(repo, "config_dit_mel_seed_uvit_whisper_small_wavenet.yml")))
        params = recursive_munch(cfg["model_params"])
        params.dit_type = "DiT"
        model = build_model(params, stage="DiT")
        model, *_ = load_checkpoint(model, None, ckpt, load_only_params=True, ignore_modules=[], is_distributed=False)
        for k in model:
            model[k].eval()
        model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)
        self.model = model
        self.campplus = load_campplus()
        voc = bigvgan.BigVGAN.from_pretrained(params.vocoder.name, use_cuda_kernel=False)
        voc.remove_weight_norm()
        self.vocoder = voc.eval()
        name = params.speech_tokenizer.name
        self.whisper = WhisperModel.from_pretrained(name, torch_dtype=torch.float32).eval()
        del self.whisper.decoder
        self.whisper_fe = AutoFeatureExtractor.from_pretrained(name)
        sp = cfg["preprocess_params"]["spect_params"]
        args = dict(n_fft=sp["n_fft"], win_size=sp["win_length"], hop_size=sp["hop_length"], num_mels=sp["n_mels"],
                    sampling_rate=VC_SR, fmin=sp.get("fmin", 0), fmax=None, center=False)
        self.to_mel = lambda x: mel_spectrogram(x, **args)
        self.refs = {}

    @staticmethod
    def load(path: str) -> torch.Tensor:
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        w = torch.from_numpy(x.mean(axis=1))[None]
        return torchaudio.functional.resample(w, sr, VC_SR) if sr != VC_SR else w

    @torch.no_grad()
    def semantic(self, wave16k: torch.Tensor) -> torch.Tensor:
        inp = self.whisper_fe([wave16k[0].numpy()], return_tensors="pt", return_attention_mask=True,
                              sampling_rate=16000)
        feats = self.whisper._mask_input_features(inp.input_features, attention_mask=inp.attention_mask)
        out = self.whisper.encoder(feats, return_dict=True).last_hidden_state
        return out[:, : wave16k.size(-1) // 320 + 1]

    @torch.no_grad()
    def reference(self, path: str, seconds: float):
        key = (path, seconds)
        if key not in self.refs:
            wave = self.load(path)[:, : int(VC_SR * seconds)]
            w16 = torchaudio.functional.resample(wave, VC_SR, 16000)
            mel2 = self.to_mel(wave)
            prompt, *_ = self.model.length_regulator(self.semantic(w16), ylens=torch.LongTensor([mel2.size(2)]),
                                                     n_quantizers=3, f0=None)
            self.refs[key] = dict(mel2=mel2, style=style_of(self.campplus, w16), prompt=prompt)
        return self.refs[key]

    @torch.no_grad()
    def convert(self, wave: torch.Tensor, ref_path: str, steps: int, ref_seconds: float) -> np.ndarray:
        """Re-speaks `wave` (1 x n samples at VC_SR, up to BATCH_SECONDS) in the voice of the sample at ref_path."""
        ref = self.reference(ref_path, ref_seconds)
        mel = self.to_mel(wave)
        cond, *_ = self.model.length_regulator(self.semantic(torchaudio.functional.resample(wave, VC_SR, 16000)),
                                               ylens=torch.LongTensor([mel.size(2)]), n_quantizers=3, f0=None)
        cat = torch.cat([ref["prompt"], cond], dim=1)
        # guidance (cfg) off: half the work on CPU, same likeness in our tests
        target = self.model.cfm.inference(cat, torch.LongTensor([cat.size(1)]), ref["mel2"], ref["style"], None,
                                          steps, inference_cfg_rate=0.0)
        return self.vocoder(target[:, :, ref["mel2"].size(-1):].float()).squeeze().numpy()


BATCH_SECONDS = 20  # with the 6 s voice sample this stays inside the model's 30 s window
BATCH_GAP = 0.3     # silence between lines in a batch


def cmd_convert(req):
    """
    Lines of the same person are converted together, up to 20 s at a time. Each pass has a fixed cost
    (the voice sample and the content encoder's 30 s window), which one line at a time paid for every line.
    The model keeps timing 1:1, so every line is cut out of the result where it was put in.
    """
    vc = SeedVC()
    items, steps, ref_s = req["items"], int(req.get("steps", 10)), float(req.get("ref_seconds", 6))
    log(f"PROGRESS 0 {len(items)}")
    by_ref = {}
    for i, it in enumerate(items):
        by_ref.setdefault(it["ref"], []).append(i)
    gap = torch.zeros(1, int(VC_SR * BATCH_GAP))
    done = 0

    def run(ref, batch):
        nonlocal done
        parts, spans, at = [], [], 0
        for i, w in batch:
            parts += [w, gap]
            spans.append((i, at, at + w.size(-1)))
            at += w.size(-1) + gap.size(-1)
        x = torch.cat(parts, dim=1)
        y = vc.convert(x, ref, steps, ref_s)
        scale = len(y) / x.size(-1)
        for i, a, b in spans:
            sf.write(items[i]["out"], y[int(a * scale): int(b * scale)], VC_SR, subtype="FLOAT")
        done += len(batch)
        log(f"PROGRESS {done} {len(items)}")

    for ref, idx in by_ref.items():
        batch, length = [], 0
        for i in idx:
            w = vc.load(items[i]["src"])[:, : VC_SR * BATCH_SECONDS]
            if batch and length + w.size(-1) > VC_SR * BATCH_SECONDS:
                run(ref, batch)
                batch, length = [], 0
            batch.append((i, w))
            length += w.size(-1) + gap.size(-1)
        if batch:
            run(ref, batch)
    return {"done": len(items)}


def cmd_download(_req):
    """Fetches every model once (used by npm run setup -- --clone)."""
    from demucs.pretrained import get_model
    get_model("htdemucs")
    SeedVC()
    return {}


if __name__ == "__main__":
    command, req_path, res_path = sys.argv[1:4]
    request = {} if req_path == "-" else json.load(open(req_path, encoding="utf-8"))
    result = {"separate": cmd_separate, "speakers": cmd_speakers, "convert": cmd_convert,
              "download": cmd_download}[command](request)
    if res_path != "-":
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
