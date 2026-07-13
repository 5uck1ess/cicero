"""
Speech-emotion (SER) sidecar for Cicero — the input side of tone.

Classifies the emotional tone of an utterance from the raw waveform (the
transcript carries none of it), using emotion2vec+ base (~90M params) via
FunASR. Runs on CPU by design: ~50ms per second of audio, so a normal turn
classifies in well under the STT pass it runs alongside, and it never
competes with the TTS/LLM stack for VRAM.

Lives in its own venv (.venv-ser) so its FunASR/ModelScope dependency tree
can't destabilize the faster-whisper STT server's stack.

Wire contract (matches src/backends/ser/emotion2vec.ts):
  POST /infer    raw WAV bytes  ->  {label, score, all}
                 label is the English name ("happy"), score its softmax prob,
                 `all` the full label->score map for debugging.
  GET  /health   ->  {"status": "ok"}
  GET  /         ->  {"status": "ok"}   (managed-startup health probe)
"""

from __future__ import annotations

import argparse
import io
import math
import sys
from collections.abc import Mapping

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from scipy.signal import resample_poly
from starlette.concurrency import run_in_threadpool

from sidecar_limits import (
    AdmissionError,
    MAX_AUDIO_UPLOAD_BYTES,
    MAX_SER_LABEL_CHARS,
    MAX_SER_LABELS,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    SER_MODEL_INFERENCE_TIMEOUT_SECONDS,
    model_gate_pair,
    read_request_body_limited,
    validate_pcm_wav_bytes,
)

app = FastAPI(title="Cicero speech-emotion (tone) sidecar")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/infer": MAX_AUDIO_UPLOAD_BYTES},
)

SAMPLE_RATE = 16000

# Global state set at startup.
_model = None
_model_gate = ModelGate(timeout_seconds=SER_MODEL_INFERENCE_TIMEOUT_SECONDS)
_ready = False


def _english(label: str) -> str:
    """FunASR labels are bilingual ("中立/neutral") — keep the English half."""
    return label.split("/")[-1].strip().lower()


def _classify(audio: np.ndarray, sample_rate: int) -> tuple[str, float, dict[str, float]]:
    if _model is None:
        raise RuntimeError("SER model not loaded")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    if sample_rate != SAMPLE_RATE:
        audio = resample_poly(audio, SAMPLE_RATE, sample_rate).astype(np.float32)
    res = _model.generate(audio, fs=SAMPLE_RATE, granularity="utterance", extract_embedding=False)
    if not isinstance(res, (list, tuple)) or not res or not isinstance(res[0], Mapping):
        raise RuntimeError("SER model returned an invalid result")
    raw_labels = res[0].get("labels")
    raw_scores = res[0].get("scores")
    try:
        label_count = len(raw_labels)
        score_count = len(raw_scores)
    except (TypeError, AttributeError) as err:
        raise RuntimeError("SER model returned invalid label or score arrays") from err
    if label_count == 0 or label_count > MAX_SER_LABELS or label_count != score_count:
        raise RuntimeError("SER model returned mismatched or unbounded labels and scores")

    labels: list[str] = []
    scores: list[float] = []
    for raw_label, raw_score in zip(raw_labels, raw_scores):
        if not isinstance(raw_label, str) or not raw_label or len(raw_label) > MAX_SER_LABEL_CHARS:
            raise RuntimeError("SER model returned an invalid label")
        label = _english(raw_label)
        if (
            not label
            or len(label) > MAX_SER_LABEL_CHARS
            or any(ord(char) < 32 or ord(char) == 127 for char in label)
        ):
            raise RuntimeError("SER model returned an invalid label")
        if isinstance(raw_score, bool):
            raise RuntimeError("SER model returned an invalid score")
        try:
            score = float(raw_score)
        except (TypeError, ValueError, OverflowError) as err:
            raise RuntimeError("SER model returned an invalid score") from err
        if not math.isfinite(score) or score < 0 or score > 1:
            raise RuntimeError("SER model returned an invalid score")
        labels.append(label)
        scores.append(score)
    if len(set(labels)) != len(labels):
        raise RuntimeError("SER model returned duplicate labels")
    top = max(range(len(scores)), key=scores.__getitem__)
    return labels[top], scores[top], dict(zip(labels, scores))


def _decode_and_classify(body: bytes) -> tuple[str, float, dict[str, float]]:
    validate_pcm_wav_bytes(body)
    try:
        audio, sample_rate = sf.read(io.BytesIO(body), dtype="float32")
    except Exception as err:
        raise AdmissionError(f"unreadable audio: {err}") from err
    if len(audio) == 0:
        raise AdmissionError("empty audio")
    return _classify(audio, sample_rate)


@app.get("/")
async def root():
    if _model is None or not _ready or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not warmed"},
            status_code=503,
        )
    return {"status": "ok"}


@app.get("/health")
async def health():
    return await root()


@app.post("/infer")
async def infer(request: Request) -> JSONResponse:
    if _model is None or not _ready:
        return JSONResponse({"error": "SER model not warmed"}, status_code=503)
    try:
        body = await read_request_body_limited(request, MAX_AUDIO_UPLOAD_BYTES)
        if not body:
            raise AdmissionError("empty body — POST WAV bytes")
    except AdmissionError as err:
        return JSONResponse(
            {"error": str(err)},
            status_code=err.status_code,
            headers={"Connection": "close"} if err.status_code == 413 else None,
        )
    except Exception as err:
        return JSONResponse({"error": f"could not read audio body: {err}"}, status_code=400)
    try:
        label, score, all_scores = await run_in_threadpool(
            _model_gate.run,
            _decode_and_classify,
            body,
        )
    except ModelGateError as err:
        headers = {"Retry-After": "1"} if err.status_code == 429 else None
        return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
    except AdmissionError as err:
        return JSONResponse({"error": str(err)}, status_code=err.status_code)
    except Exception as err:
        return JSONResponse({"error": f"emotion classification failed: {err}"}, status_code=500)
    return JSONResponse({"label": label, "score": score, "all": all_scores})


def _warmup() -> bool:
    """One throwaway inference so the first real turn isn't a cold start."""
    global _ready
    _ready = False
    try:
        label, score, _ = _model_gate.run(
            _classify,
            np.zeros(SAMPLE_RATE, dtype=np.float32),
            SAMPLE_RATE,
        )
        _ready = True
        print(f"[ser] warmed up (silence -> {label} {score:.3f})", flush=True)
        return True
    except Exception as err:
        print(f"[ser] warmup failed: {err}", flush=True)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Speech-emotion sidecar for Cicero")
    parser.add_argument("--port", type=int, default=8091, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument(
        "--model",
        type=str,
        default="emotion2vec/emotion2vec_plus_base",
        help="HF repo id of the emotion2vec checkpoint",
    )
    parser.add_argument("--device", type=str, default="cpu", help="Inference device (cpu keeps VRAM free)")
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=SER_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    from funasr import AutoModel  # deferred: ~9s import, only the server pays it

    global _model, _model_gate
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        SER_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate
    _model = AutoModel(model=args.model, hub="hf", device=args.device, disable_update=True)
    print(f"[ser] loaded {args.model} on {args.device}", flush=True)
    if not _warmup():
        print("[ser] FATAL: warmup classification failed", file=sys.stderr, flush=True)
        sys.exit(1)
    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
