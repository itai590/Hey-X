#!/usr/bin/env python3
"""Train a logistic-regression head on YAMNet embeddings from labeled WAV clips.

Expects:
  data/custom_clips/bark/*.wav
  data/custom_clips/not_bark/*.wav

Writes:
  data/custom_model/head.json

Run from the backend directory (same as classify_bark.py).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import numpy as np

# Ensure we import the sibling module
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from classify_bark import (  # noqa: E402
    EMBEDDING_DIM,
    NUM_AUDIOSET_CLASSES,
    load_model,
    read_wav_mono_16k,
    yamnet_forward,
)


def list_wavs(root: str, sub: str) -> list[str]:
    d = os.path.join(root, sub)
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        if name.lower().endswith(".wav"):
            out.append(os.path.join(d, name))
    return out


def train_logistic(
    X: np.ndarray,
    y: np.ndarray,
    epochs: int = 3000,
    lr: float = 0.3,
    l2: float = 1e-3,
) -> tuple[np.ndarray, float]:
    """Binary logistic regression; labels y in {0, 1}."""
    n, d = X.shape
    assert d in (EMBEDDING_DIM, NUM_AUDIOSET_CLASSES)
    w = np.zeros(d, dtype=np.float64)
    b = 0.0

    for epoch in range(epochs):
        logits = X @ w + b
        logits = np.clip(logits, -60.0, 60.0)
        p = 1.0 / (1.0 + np.exp(-logits))
        error = p - y
        grad_w = (X.T @ error) / n + l2 * w
        grad_b = float(error.mean())
        w -= lr * grad_w
        b -= lr * grad_b
        if epoch > 0 and epoch % 500 == 0:
            lr *= 0.95

    return w, b


def accuracy(X: np.ndarray, y: np.ndarray, w: np.ndarray, b: float, thr: float = 0.5) -> float:
    logits = np.clip(X @ w + b, -60.0, 60.0)
    p = 1.0 / (1.0 + np.exp(-logits))
    pred = (p >= thr).astype(np.float64)
    return float((pred == y).mean())


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Train a custom YAMNet embedding head for per-dog bark classification."
    )
    ap.add_argument(
        "--clips-root",
        default=os.path.join(BACKEND_DIR, "data", "custom_clips"),
        help="Directory containing bark/ and not_bark/ WAV folders",
    )
    ap.add_argument(
        "--output",
        default=os.path.join(BACKEND_DIR, "data", "custom_model", "head.json"),
        help="Output head.json path",
    )
    ap.add_argument("--epochs", type=int, default=3000)
    ap.add_argument("--threshold", type=float, default=0.55, help="Decision threshold stored in head.json")
    args = ap.parse_args()

    bark_files = list_wavs(args.clips_root, "bark")
    not_files = list_wavs(args.clips_root, "not_bark")

    if len(bark_files) < 1 or len(not_files) < 1:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Need at least one WAV in both bark/ and not_bark/",
                    "bark": len(bark_files),
                    "not_bark": len(not_files),
                }
            ),
            flush=True,
        )
        sys.exit(1)

    print(f"[train] bark clips: {len(bark_files)}, not_bark: {len(not_files)}", file=sys.stderr, flush=True)

    interpreter, class_names = load_model()

    rows = []
    labels = []
    feature_mode: str | None = None  # "embedding" | "yamnet_scores"

    def add_file(fpath: str, label: int) -> None:
        nonlocal feature_mode
        with open(fpath, "rb") as f:
            wav_data = f.read()
        waveform = read_wav_mono_16k(wav_data)
        out = yamnet_forward(interpreter, class_names, waveform)
        emb = out.get("embedding")
        ms = out.get("mean_scores")

        if feature_mode is None:
            if emb is not None and np.asarray(emb).size == EMBEDDING_DIM:
                feature_mode = "embedding"
                print(
                    "[train] using 1024-D YAMNet embedding output",
                    file=sys.stderr,
                    flush=True,
                )
            elif ms is not None and len(np.asarray(ms).reshape(-1)) == NUM_AUDIOSET_CLASSES:
                feature_mode = "yamnet_scores"
                print(
                    "[train] no 1024-D embedding in this .tflite — using 521-D YAMNet class score vector",
                    file=sys.stderr,
                    flush=True,
                )
            else:
                print(
                    f"[train] skip (no embedding and no 521-D scores): {fpath}",
                    file=sys.stderr,
                    flush=True,
                )
                return

        if feature_mode == "embedding":
            vec = out.get("embedding")
        else:
            vec = np.asarray(out.get("mean_scores"), dtype=np.float64).reshape(-1)
        if vec is None or np.asarray(vec).size == 0:
            print(f"[train] skip (empty feature): {fpath}", file=sys.stderr, flush=True)
            return
        if feature_mode == "embedding" and np.asarray(vec).size != EMBEDDING_DIM:
            print(f"[train] skip (bad embedding size): {fpath}", file=sys.stderr, flush=True)
            return
        if feature_mode == "yamnet_scores" and len(vec) != NUM_AUDIOSET_CLASSES:
            print(f"[train] skip (bad scores size): {fpath}", file=sys.stderr, flush=True)
            return
        rows.append(np.asarray(vec, dtype=np.float64))
        labels.append(label)

    for f in bark_files:
        add_file(f, 1)
    for f in not_files:
        add_file(f, 0)

    if len(rows) < 4:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Too few usable clips after feature extraction (embeddings or YAMNet scores)",
                    "usable": len(rows),
                }
            ),
            flush=True,
        )
        sys.exit(1)

    X = np.stack(rows, axis=0)
    y = np.array(labels, dtype=np.float64)

    # Light normalization helps optimization across clips
    mu = X.mean(axis=0)
    sigma = X.std(axis=0) + 1e-6
    Xn = (X - mu) / sigma

    w, b = train_logistic(Xn, y, epochs=args.epochs)
    acc = accuracy(Xn, y, w, b, thr=0.5)

    # Pack weights that apply to raw embeddings: undo normalization in one linear layer
    # If x_raw is original, xn = (x_raw - mu) / sigma  => w_raw = w / sigma, b_raw = b - dot(w, mu/sigma)
    w_raw = w / sigma
    b_raw = float(b - np.dot(w, mu / sigma))

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), mode=0o755, exist_ok=True)

    input_dim = int(w_raw.shape[0])
    assert feature_mode in ("embedding", "yamnet_scores")
    payload = {
        "version": 1,
        "head_feature": feature_mode,
        "input_dim": input_dim,
        "weights": [float(x) for x in w_raw.tolist()],
        "bias": b_raw,
        "threshold": float(args.threshold),
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "samples": {"bark": len(bark_files), "not_bark": len(not_files), "usable": len(rows)},
        "train_accuracy": round(acc, 4),
        "embedding_dim": input_dim,
        "normalize": {"mean": [float(x) for x in mu.tolist()], "std": [float(x) for x in sigma.tolist()]},
    }

    if input_dim not in (EMBEDDING_DIM, NUM_AUDIOSET_CLASSES):
        print(json.dumps({"ok": False, "error": "weight dimension mismatch"}), flush=True)
        sys.exit(1)

    with open(args.output, "w", encoding="utf8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    print(f"[train] wrote {args.output} train_accuracy={acc:.4f}", file=sys.stderr, flush=True)
    print(
        json.dumps({"ok": True, "output": args.output, "train_accuracy": acc, "samples": payload["samples"]}),
        flush=True,
    )


if __name__ == "__main__":
    main()
