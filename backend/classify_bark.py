#!/usr/bin/env python3
"""Classify a WAV audio clip using YAMNet TFLite.

Reads a WAV file path from argv[1] (or raw WAV bytes from stdin when path is "-").
Prints a JSON object: {"labels": [{"class": "Bark", "score": 0.82}, ...], "is_bark": true}

Optional second stage: logistic regression on YAMNet embeddings (see train_custom_head.py).

The model and class-map are expected next to this script:
  models/yamnet.tflite
  models/yamnet_class_map.csv
"""
import sys
import os
import json
import importlib
import csv
import struct
import io
import re
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "models", "yamnet.tflite")
CLASS_MAP_PATH = os.path.join(SCRIPT_DIR, "models", "yamnet_class_map.csv")

BARK_CLASSES = frozenset([
    "Bark",
    "Bow-wow",
    "Canidae, dogs, wolves",
    "Dog",
    "Growling",
    "Howl",
    "Whimper",
    "Whimper (dog)",
    "Yip",
])

# AudioSet class count and YAMNet embedding size (standard TF Hub export)
NUM_AUDIOSET_CLASSES = 521
EMBEDDING_DIM = 1024

SAMPLE_RATE = 16000

# TFLite/XNNPack sometimes concatenates the same failure message dozens of times.
_XNNPACK_REPEAT = re.compile(
    r"(XNNPack delegate failed to reshape runtimeNode number \d+ "
    r"\(TfLiteXNNPackDelegate\) failed to prepare\.)+"
)


def _compact_error(exc: BaseException | str, max_len: int = 360) -> str:
    """Single-line friendly error for JSON logs; dedupe repeated TFLite lines and cap length."""
    s = str(exc).strip() if exc else ""
    if not s:
        return s
    s = _XNNPACK_REPEAT.sub(r"\1", s)
    if len(s) > max_len:
        return f"{s[: max_len - 24]}… ({len(s)} chars)"
    return s

# Cache custom head JSON by path mtime
_HEAD_CACHE = {}  # path -> (mtime, dict)


# ── WAV reader (no scipy/soundfile dependency) ──────────────────
def read_wav_mono_16k(data: bytes) -> np.ndarray:
    """Parse a PCM WAV from raw bytes, resample to 16 kHz mono float32."""
    with io.BytesIO(data) as f:
        riff = f.read(4)
        if riff != b"RIFF":
            raise ValueError("Not a WAV file")
        f.read(4)  # file size
        if f.read(4) != b"WAVE":
            raise ValueError("Not a WAV file")

        fmt_parsed = False
        audio_data = b""
        while True:
            chunk_id = f.read(4)
            if len(chunk_id) < 4:
                break
            chunk_size = struct.unpack("<I", f.read(4))[0]
            if chunk_id == b"fmt ":
                fmt_raw = f.read(chunk_size)
                audio_fmt = struct.unpack("<H", fmt_raw[0:2])[0]
                n_channels = struct.unpack("<H", fmt_raw[2:4])[0]
                sr = struct.unpack("<I", fmt_raw[4:8])[0]
                bits_per_sample = struct.unpack("<H", fmt_raw[14:16])[0]
                fmt_parsed = True
            elif chunk_id == b"data":
                audio_data = f.read(chunk_size)
            else:
                f.read(chunk_size)

        if not fmt_parsed or not audio_data:
            raise ValueError("Incomplete WAV")
        if audio_fmt != 1:
            raise ValueError(f"Unsupported WAV format: {audio_fmt} (need PCM)")

        if bits_per_sample == 16:
            samples = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0
        elif bits_per_sample == 32:
            samples = np.frombuffer(audio_data, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise ValueError(f"Unsupported bit depth: {bits_per_sample}")

        if n_channels > 1:
            samples = samples.reshape(-1, n_channels).mean(axis=1)

        if sr != SAMPLE_RATE:
            duration = len(samples) / sr
            new_len = int(duration * SAMPLE_RATE)
            indices = np.linspace(0, len(samples) - 1, new_len).astype(int)
            samples = samples[indices]

        return samples


# ── Model loader ─────────────────────────────────────────────────
def _import_interpreter():
    """Resolve Interpreter + optional OpResolverType from whichever TFLite package is installed."""
    for mod_name in (
        "ai_edge_litert.interpreter",
        "tflite_runtime.interpreter",
        "tensorflow.lite",
    ):
        try:
            m = importlib.import_module(mod_name)
        except ImportError:
            continue
        if not hasattr(m, "Interpreter"):
            continue
        ort = getattr(m, "OpResolverType", None)
        if ort is None and mod_name == "tensorflow.lite":
            try:
                ex = importlib.import_module("tensorflow.lite.experimental")
                ort = getattr(ex, "OpResolverType", None)
            except ImportError:
                pass
        return m.Interpreter, ort
    raise ImportError(
        "No TFLite interpreter (need ai-edge-litert, tflite-runtime, or tensorflow)"
    )


def load_model():
    """Load YAMNet. Default CPU path disables XNNPACK (fixes reshape errors on some aarch64/qemu setups).

    Set HEY_TFLITE_USE_DEFAULT_DELEGATES=1 to re-enable default delegates (faster when stable).
    """
    Interpreter, OpResolverType = _import_interpreter()
    use_default_delegates = os.environ.get(
        "HEY_TFLITE_USE_DEFAULT_DELEGATES", ""
    ).strip().lower() in ("1", "true", "yes")

    kwargs = {"model_path": MODEL_PATH}
    if OpResolverType is not None and not use_default_delegates:
        kwargs["experimental_op_resolver_type"] = (
            OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES
        )

    try:
        interpreter = Interpreter(**kwargs)
    except TypeError:
        interpreter = Interpreter(model_path=MODEL_PATH)

    interpreter.allocate_tensors()

    class_names = []
    with open(CLASS_MAP_PATH, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            class_names.append(row["display_name"])

    return interpreter, class_names


def _pool_time_axis(arr: np.ndarray) -> np.ndarray:
    """Mean over time frames; supports (frames, dim), (batch, frames, dim), or (dim,)."""
    if arr.ndim <= 1:
        return arr
    if arr.ndim == 2:
        return arr.mean(axis=0)
    # Collapse leading dims (e.g. batch) into one time axis
    flat = arr.reshape(-1, arr.shape[-1])
    return flat.mean(axis=0)


def _yamnet_input_num_samples(interpreter) -> int:
    """YAMNet TFLite expects fixed-length waveform chunks (reshape layer ~15600 samples @16 kHz)."""
    d = interpreter.get_input_details()[0]
    shape = np.asarray(d.get("shape", []), dtype=np.int64).flatten()
    # e.g. [1, 15600] or [15600]; ignore batch dim 1, take the audio length
    positive = [int(x) for x in shape if int(x) > 1]
    if positive:
        return int(max(positive))
    env = os.environ.get("YAMNET_FRAME_SAMPLES", "").strip()
    if env:
        return int(env)
    return 15600


def _iter_yamnet_frames(waveform: np.ndarray, frame: int, hop: int):
    """Sliding windows with 50% overlap (YAMNet-style); pad short clips to one frame."""
    w = np.asarray(waveform, dtype=np.float32).reshape(-1)
    n = w.shape[0]
    if n == 0:
        return
    if n < frame:
        yield np.pad(w, (0, frame - n))
        return
    starts = []
    pos = 0
    while pos + frame <= n:
        starts.append(pos)
        pos += hop
    last_start = n - frame
    if not starts:
        starts = [last_start]
    elif last_start > starts[-1]:
        starts.append(last_start)
    for s in starts:
        yield w[s : s + frame].copy()


def _prepare_input_waveform(w_flat: np.ndarray, input_detail: dict) -> np.ndarray:
    """Match TFLite input layout: (N,) or (1, N)."""
    w = np.asarray(w_flat, dtype=np.float32).reshape(-1)
    shape = input_detail.get("shape")
    if shape is None:
        return w
    s = np.asarray(shape).flatten()
    if len(s) >= 2 and int(s[0]) == 1:
        return w.reshape(1, -1)
    return w.reshape(-1)


def _extract_scores_and_embedding(interpreter, output_details):
    """Map TFLite outputs to score vector (521) and embedding (1024). Handles varied export layouts."""
    scores_arr = None
    emb_arr = None

    for od in output_details:
        t = interpreter.get_tensor(od["index"])
        if t.size == 0:
            continue
        last = t.shape[-1] if t.ndim >= 1 else t.size
        if last == NUM_AUDIOSET_CLASSES:
            scores_arr = t
        elif last == EMBEDDING_DIM:
            emb_arr = t

    # Fallback: flat 1024 (some exports use a 1-D embedding tensor)
    if emb_arr is None:
        for od in output_details:
            t = interpreter.get_tensor(od["index"])
            if t is None or t.size != EMBEDDING_DIM:
                continue
            last_d = t.shape[-1] if t.ndim >= 1 else t.size
            if last_d == NUM_AUDIOSET_CLASSES:
                continue
            emb_arr = t
            break

    # Fallback: match output tensor name (TF Hub / Lite naming varies)
    if emb_arr is None:
        for od in output_details:
            name = (od.get("name") or "").lower()
            if "score" in name or "classification" in name:
                continue
            if "embedding" not in name and "identity_1" not in name:
                continue
            t = interpreter.get_tensor(od["index"])
            if t is None or t.size == 0:
                continue
            last_d = t.shape[-1] if t.ndim >= 1 else t.size
            if last_d == EMBEDDING_DIM:
                emb_arr = t
                break

    if scores_arr is None:
        scores_arr = interpreter.get_tensor(output_details[0]["index"])

    mean_scores = _pool_time_axis(scores_arr)
    emb_mean = None
    if emb_arr is not None:
        emb_mean = _pool_time_axis(emb_arr).astype(np.float64)
    return mean_scores, emb_mean


def _yamnet_invoke_one_frame(
    interpreter,
    frame_waveform: np.ndarray,
    input_detail: dict,
    output_details: list,
    idx: int,
    *,
    initial_setup: bool,
):
    """
    Run one fixed-size frame. Call with initial_setup=True only on the first frame:
    resize + allocate once per waveform — repeating allocate every frame breaks some TFLite builds
    (embedding output stays empty → train_custom_head skips all clips).
    """
    tensor_in = _prepare_input_waveform(frame_waveform, input_detail)
    if initial_setup:
        interpreter.resize_tensor_input(idx, tensor_in.shape)
        interpreter.allocate_tensors()
    interpreter.set_tensor(idx, tensor_in)
    interpreter.invoke()
    return _extract_scores_and_embedding(interpreter, output_details)


def yamnet_forward(interpreter, class_names, waveform: np.ndarray, top_k=5):
    """Run YAMNet over sliding windows; aggregate scores/embeddings (matches TF Hub YAMNet usage)."""
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    idx = input_details[0]["index"]
    input_detail = input_details[0]

    frame_len = _yamnet_input_num_samples(interpreter)
    hop = int(os.environ.get("YAMNET_FRAME_HOP", str(max(1, frame_len // 2))))
    sum_scores = None
    sum_emb = None
    n_frames = 0
    first = True
    for fr in _iter_yamnet_frames(waveform, frame_len, hop):
        ms, emb = _yamnet_invoke_one_frame(
            interpreter,
            fr,
            input_detail,
            output_details,
            idx,
            initial_setup=first,
        )
        first = False
        sum_scores = ms if sum_scores is None else sum_scores + ms
        if emb is not None:
            sum_emb = emb if sum_emb is None else sum_emb + emb
        n_frames += 1

    if n_frames == 0:
        mean_scores = np.zeros(NUM_AUDIOSET_CLASSES, dtype=np.float32)
        emb_mean = None
    else:
        mean_scores = sum_scores / float(n_frames)
        emb_mean = (sum_emb / float(n_frames)) if sum_emb is not None else None

    top_indices = mean_scores.argsort()[-top_k:][::-1]
    labels = [{"class": class_names[i], "score": round(float(mean_scores[i]), 4)} for i in top_indices]

    bark_score = max(
        (float(mean_scores[i]) for i, name in enumerate(class_names) if name in BARK_CLASSES),
        default=0.0,
    )

    return {
        "labels": labels,
        "bark_score": round(float(bark_score), 4),
        "mean_scores": mean_scores,
        "embedding": emb_mean,
    }


def load_custom_head(path: str) -> dict | None:
    """Load head.json; returns None if missing/invalid."""
    try:
        st = os.stat(path)
        mtime = st.st_mtime
    except OSError:
        return None

    cached = _HEAD_CACHE.get(path)
    if cached and cached[0] == mtime:
        return cached[1]

    try:
        with open(path, encoding="utf8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None

    w = raw.get("weights")
    if not isinstance(w, list) or len(w) not in (EMBEDDING_DIM, NUM_AUDIOSET_CLASSES):
        return None
    n_w = len(w)
    hf = raw.get("head_feature")
    if hf is None:
        hf = "embedding" if n_w == EMBEDDING_DIM else "yamnet_scores"
    elif hf not in ("embedding", "yamnet_scores"):
        return None
    if (hf == "embedding" and n_w != EMBEDDING_DIM) or (hf == "yamnet_scores" and n_w != NUM_AUDIOSET_CLASSES):
        return None
    try:
        weights = np.array(w, dtype=np.float64)
        bias = float(raw.get("bias", 0.0))
        thr = float(raw.get("threshold", 0.5))
    except (TypeError, ValueError):
        return None

    data = {
        "weights": weights,
        "bias": bias,
        "threshold": thr,
        "head_feature": hf,
        "_mtime": mtime,
    }
    _HEAD_CACHE[path] = (mtime, data)
    return data


def custom_head_probability(embedding: np.ndarray, head: dict) -> float:
    """Sigmoid(w·x + b)."""
    z = float(np.dot(embedding, head["weights"]) + head["bias"])
    z = np.clip(z, -60.0, 60.0)
    return float(1.0 / (1.0 + np.exp(-z)))


def classify(
    interpreter,
    class_names,
    waveform: np.ndarray,
    top_k=5,
    bark_threshold=0.25,
    custom_head=None,
):
    """
    custom_head: optional dict with keys enabled (bool), path (str), threshold (float).
    Final is_bark = yamnet_is_bark OR (custom_prob >= head.threshold) when head applies.
    """
    out = yamnet_forward(interpreter, class_names, waveform, top_k=top_k)
    labels = out["labels"]
    bark_score = out["bark_score"]
    yamnet_is_bark = bark_score >= bark_threshold

    custom_prob = None
    custom_used = False

    ch = custom_head or {}
    if ch.get("enabled") and isinstance(ch.get("path"), str) and ch["path"].strip():
        head = load_custom_head(ch["path"].strip())
        if head is not None:
            thr_h = float(ch.get("threshold", head["threshold"]))
            hf = head.get("head_feature", "embedding")
            if hf == "yamnet_scores":
                x_vec = np.asarray(out.get("mean_scores"), dtype=np.float64).reshape(-1)
            else:
                x_vec = out.get("embedding")
                if x_vec is not None:
                    x_vec = np.asarray(x_vec, dtype=np.float64).reshape(-1)
            if x_vec is not None and x_vec.size == head["weights"].size:
                custom_prob = custom_head_probability(x_vec, head)
                custom_used = True
                is_bark = yamnet_is_bark or (custom_prob >= thr_h)
            else:
                is_bark = yamnet_is_bark
        else:
            is_bark = yamnet_is_bark
    else:
        is_bark = yamnet_is_bark

    result = {
        "labels": labels,
        "bark_score": bark_score,
        "yamnet_is_bark": yamnet_is_bark,
        "is_bark": is_bark,
    }
    if custom_prob is not None:
        result["custom_head_score"] = round(custom_prob, 4)
        result["custom_head_used"] = custom_used
    else:
        result["custom_head_used"] = False

    return result


# ── Main ─────────────────────────────────────────────────────────
def main():
    if not os.path.exists(MODEL_PATH):
        print(json.dumps({"error": f"Model not found at {MODEL_PATH}"}), flush=True)
        sys.exit(1)

    bark_threshold = float(os.environ.get("BARK_THRESHOLD", "0.25"))
    interpreter, class_names = load_model()

    if len(sys.argv) > 1 and sys.argv[1] == "--stream":
        # Streaming mode: read one request per line. Accepts either:
        #   {"path": "/tmp/clip.wav", "threshold": 0.3, "custom_head": {...}}
        #   /tmp/clip.wav
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                custom_head = None
                if line.startswith("{"):
                    req = json.loads(line)
                    path = req["path"]
                    threshold = float(req.get("threshold", bark_threshold))
                    custom_head = req.get("custom_head")
                else:
                    path = line
                    threshold = bark_threshold
                with open(path, "rb") as f:
                    wav_data = f.read()
                waveform = read_wav_mono_16k(wav_data)
                result = classify(
                    interpreter,
                    class_names,
                    waveform,
                    bark_threshold=threshold,
                    custom_head=custom_head,
                )
            except Exception as e:
                result = {"error": _compact_error(e), "is_bark": False, "bark_score": 0.0, "labels": []}
            print(json.dumps(result), flush=True)
    else:
        # Single-shot: read from file arg or stdin
        if len(sys.argv) > 1 and sys.argv[1] != "-":
            with open(sys.argv[1], "rb") as f:
                wav_data = f.read()
        else:
            wav_data = sys.stdin.buffer.read()

        waveform = read_wav_mono_16k(wav_data)
        result = classify(interpreter, class_names, waveform, bark_threshold=bark_threshold)
        print(json.dumps(result))


if __name__ == "__main__":
    main()
