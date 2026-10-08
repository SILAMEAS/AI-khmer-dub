"""
Voice separation worker for the Khmer dubber. Runs on CPU (and Intel graphics); started by lib/stems.ts.

  python separate.py separate <request.json> <result.json>
  python separate.py download - -        (fetch the models once; npm run setup does it)

separate  {"input", "ffmpeg", "duration", "vocals", "background"}
          Splits the soundtrack into voices and everything else (MDX-Net Kim Vocal 2 on OpenVINO,
          or Demucs htdemucs), a piece at a time.

Progress is printed as "PROGRESS <done> <total>".
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Always this folder's models, even when the PC sets its own model folders for other AI apps (otherwise the
# models setup put here would be downloaded a second time there).
for _var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE", "HF_HUB_OFFLINE"):
    os.environ.pop(_var, None)
os.environ["HF_HOME"] = os.path.join(ROOT, "models", "hf")
os.environ["TORCH_HOME"] = os.path.join(ROOT, "models", "torch")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

# hyper-threads and efficiency cores slow these models down: about one thread per physical core is fastest
torch.set_num_threads(int(os.environ.get("VC_THREADS", 0)) or max(1, min(12, (os.cpu_count() or 4) // 2 + 1)))


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- separate

MDX_MODEL = os.path.join(ROOT, "models", "mdx", "Kim_Vocal_2.onnx")
MDX_URL = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx"


def cmd_separate(req):
    """
    MDX-Net Kim Vocal 2 on OpenVINO (the Intel graphics and the CPU together when there are both) when installed:
    1.6x faster than Demucs here and cleaner (+1.4 to +3.4 dB on speech over instrumental music in our tests).
    Otherwise Demucs on the CPU.
    """
    try:
        import openvino  # noqa: F401
        mdx = os.path.exists(MDX_MODEL)
    except ImportError:
        mdx = False
    if mdx:
        try:
            return separate_mdx(req)
        except Exception as e:  # e.g. a graphics driver that fails: Demucs still works
            log(f"MDX separation failed, using Demucs: {e}")
    return separate_demucs(req)


def open_mix(req, sr):
    """The soundtrack as stereo float32 at `sr`, streamed from ffmpeg; plus the two output files."""
    dec = subprocess.Popen([req["ffmpeg"], "-v", "error", "-i", req["input"], "-vn", "-f", "f32le", "-ac", "2",
                            "-ar", str(sr), "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read(n):
        raw = dec.stdout.read(n * 8)
        return np.frombuffer(raw[: len(raw) // 8 * 8], dtype=np.float32).reshape(-1, 2)

    def close():
        err = dec.stderr.read().decode("utf-8", "replace").strip()
        dec.wait()
        return err

    return read, close, sf.SoundFile(req["vocals"], "w", sr, 1, "PCM_16"), sf.SoundFile(req["background"], "w", sr, 2, "PCM_16")


def separate_mdx(req):
    import openvino as ov

    sr, n_fft, hop, dim_f, dim_t, compensate = 44100, 7680, 1024, 3072, 256, 1.012
    core = ov.Core()
    core.set_property({"CACHE_DIR": os.path.join(ROOT, "models", "mdx", "cache")})  # 7 s to load becomes 0.4 s
    device = "AUTO:GPU,CPU" if "GPU" in core.available_devices else "CPU"
    model = core.compile_model(MDX_MODEL, device,
                               {"PERFORMANCE_HINT": "CUMULATIVE_THROUGHPUT" if "," in device else "THROUGHPUT"})
    log(f"MDX separation on {device}")

    # each 5.9 s window is heard whole, but only its middle (all but n_fft/2 at each edge) is kept
    chunk = hop * (dim_t - 1)
    trim = n_fft // 2
    gen = chunk - 2 * trim
    bins = n_fft // 2 + 1
    window = torch.hann_window(n_fft, periodic=True)
    per_block = 16  # windows sent at once (~90 s): the graphics and the CPU each work on some
    total = max(1, int(float(req["duration"]) * sr))

    read, close, voc_out, bg_out = open_mix(req, sr)
    queue = ov.AsyncInferQueue(model)
    results = {}
    queue.set_callback(lambda r, k: results.__setitem__(k, r.get_output_tensor(0).data.copy()))

    buf, eof, done = np.zeros((trim, 2), np.float32), False, 0  # buf[trim + j] is sample done + j
    while True:
        want = per_block * gen + 2 * trim
        if not eof and len(buf) < want:
            more = read(want - len(buf))
            eof = len(more) < want - len(buf)
            buf = np.concatenate([buf, more])
        real = len(buf) - trim  # samples of the soundtrack still to do
        if real <= 0:
            break
        n_win = min(per_block, -(-real // gen))
        need = n_win * gen + 2 * trim
        if len(buf) < need:
            buf = np.concatenate([buf, np.zeros((need - len(buf), 2), np.float32)])
        results.clear()
        for k in range(n_win):
            x = torch.from_numpy(buf[k * gen: k * gen + chunk].T.copy())
            spec = torch.view_as_real(torch.stft(x, n_fft, hop, window=window, center=True, return_complex=True))
            queue.start_async({0: spec.permute(0, 3, 1, 2).reshape(1, 4, bins, dim_t)[:, :, :dim_f].numpy()}, k)
        queue.wait_all()
        keep = min(n_win * gen, real)
        voc = np.empty((n_win * gen, 2), np.float32)
        for k in range(n_win):
            y = torch.cat([torch.from_numpy(results[k]), torch.zeros(1, 4, bins - dim_f, dim_t)], 2)
            y = torch.view_as_complex(y.reshape(2, 2, bins, dim_t).permute(0, 2, 3, 1).contiguous())
            voc[k * gen:(k + 1) * gen] = torch.istft(y, n_fft, hop, window=window, center=True,
                                                     length=chunk).numpy()[:, trim:trim + gen].T * compensate
        voc, mix = voc[:keep], buf[trim:trim + keep]
        voc_out.write(voc.mean(axis=1))
        bg_out.write(np.clip(mix - voc, -1, 1))  # music & effects: whatever is not voice
        done += keep
        log(f"PROGRESS {min(done, total)} {total}")
        buf = buf[keep:]
        if eof and keep == real:  # what is left is only the zeros padding the last window
            break
    err = close()
    voc_out.close()
    bg_out.close()
    if not done:
        raise RuntimeError("No sound could be read from the video" + (f": {err[-500:]}" if err else ""))
    return {"seconds": done / sr}


def separate_demucs(req):
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


def cmd_download(_req):
    """Fetches both separation models once (used by npm run setup)."""
    from demucs.pretrained import get_model
    get_model("htdemucs")
    if not os.path.exists(MDX_MODEL):
        import urllib.request
        os.makedirs(os.path.dirname(MDX_MODEL), exist_ok=True)
        urllib.request.urlretrieve(MDX_URL, MDX_MODEL + ".part")
        os.replace(MDX_MODEL + ".part", MDX_MODEL)
    return {}


if __name__ == "__main__":
    command, req_path, res_path = sys.argv[1:4]
    request = {} if req_path == "-" else json.load(open(req_path, encoding="utf-8"))
    result = {"separate": cmd_separate, "download": cmd_download}[command](request)
    if res_path != "-":
        with open(res_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
