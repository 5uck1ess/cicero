"""
Smart-Turn v3 semantic end-of-turn server for Cicero.

Answers one question: "has the speaker finished their turn?" — from the raw
waveform, not the transcript. Backbone is the Whisper-tiny encoder + a shallow
linear head (8M params, ~8MB int8 ONNX), so CPU inference is a few milliseconds.

Wire contract (matches src/backends/turn/smart-turn.ts):
  POST /predict  {model, sample_rate, audio: number[]}  ->  {prediction, probability, is_complete}
  GET  /health   ->  {"status": "ok"}
  GET  /         ->  {"status": "ok"}   (managed-startup health probe)

The model outputs a sigmoid probability in [0, 1] that the turn is COMPLETE.
"""

from __future__ import annotations

import argparse
import math
import sys

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from huggingface_hub import hf_hub_download
from scipy.signal import resample_poly
from transformers import WhisperFeatureExtractor
from starlette.concurrency import run_in_threadpool
import uvicorn

from sidecar_limits import (
    AdmissionError,
    MAX_TURN_JSON_BYTES,
    MAX_TURN_MODEL_CHARS,
    MAX_TURN_WINDOW_SECONDS,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    TURN_MODEL_INFERENCE_TIMEOUT_SECONDS,
    model_gate_pair,
    read_json_body_limited,
    validate_turn_samples,
)

app = FastAPI(title="Cicero Smart-Turn end-of-turn detector")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/predict": MAX_TURN_JSON_BYTES},
)

SAMPLE_RATE = 16000
WINDOW_SECONDS = MAX_TURN_WINDOW_SECONDS  # fixed analysis window (80 mels x 800 frames)

# Global state set at startup.
_session: ort.InferenceSession | None = None
_feature_extractor: WhisperFeatureExtractor | None = None
_threshold = 0.5
_model_gate = ModelGate(timeout_seconds=TURN_MODEL_INFERENCE_TIMEOUT_SECONDS)
_ready = False


def _resample_to_16k(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Resample to 16kHz if needed (the recorder records 16kHz, so usually a no-op)."""
    if sample_rate == SAMPLE_RATE:
        return audio
    return resample_poly(audio, SAMPLE_RATE, sample_rate).astype(np.float32)


def _predict(audio: np.ndarray, sample_rate: int) -> tuple[float, int]:
    """Return (probability_complete, prediction) for a mono float waveform."""
    if _session is None or _feature_extractor is None:
        raise RuntimeError("turn model not loaded")

    audio = _resample_to_16k(np.asarray(audio, dtype=np.float32), sample_rate)
    # Keep the END of the utterance — the turn boundary lives at the tail.
    window = WINDOW_SECONDS * SAMPLE_RATE
    if audio.shape[0] > window:
        audio = audio[-window:]

    inputs = _feature_extractor(
        audio,
        sampling_rate=SAMPLE_RATE,
        return_tensors="np",
        padding="max_length",
        max_length=window,
        truncation=True,
        do_normalize=True,
    )
    feats = np.expand_dims(inputs.input_features.squeeze(0).astype(np.float32), axis=0)
    outputs = _session.run(None, {"input_features": feats})
    probability = float(np.asarray(outputs[0]).reshape(-1)[0])
    if not math.isfinite(probability) or probability < 0 or probability > 1:
        raise RuntimeError("turn model returned an invalid probability")
    return probability, int(probability >= _threshold)


def _predict_samples(audio: list[int | float], sample_rate: int) -> tuple[float, int]:
    return _predict(np.asarray(audio, dtype=np.float32), sample_rate)


def _validate_request_body(body: object) -> tuple[list[int | float], int]:
    if not isinstance(body, dict):
        raise AdmissionError("JSON body must be an object")
    model = body.get("model")
    if model is not None and (
        not isinstance(model, str) or len(model) > MAX_TURN_MODEL_CHARS
    ):
        raise AdmissionError(
            f"model must be a string of at most {MAX_TURN_MODEL_CHARS} characters"
        )
    return validate_turn_samples(
        body.get("audio"),
        body.get("sample_rate", SAMPLE_RATE),
        WINDOW_SECONDS,
    )


@app.get("/")
async def root():
    if _session is None or _feature_extractor is None or not _ready or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not warmed"},
            status_code=503,
        )
    return {"status": "ok"}


@app.get("/health")
async def health():
    return await root()


@app.post("/predict")
async def predict(request: Request) -> JSONResponse:
    if _session is None or _feature_extractor is None or not _ready:
        return JSONResponse({"error": "turn model not warmed"}, status_code=503)
    try:
        body = await read_json_body_limited(request, MAX_TURN_JSON_BYTES)
        audio, sample_rate = await run_in_threadpool(
            _validate_request_body,
            body,
        )
    except AdmissionError as err:
        return JSONResponse(
            {"error": str(err)},
            status_code=err.status_code,
            headers={"Connection": "close"} if err.status_code == 413 else None,
        )
    except Exception as err:
        return JSONResponse({"error": f"could not read prediction request: {err}"}, status_code=400)

    try:
        probability, prediction = await run_in_threadpool(
            _model_gate.run,
            _predict_samples,
            audio,
            sample_rate,
        )
    except ModelGateError as err:
        headers = {"Retry-After": "1"} if err.status_code == 429 else None
        return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
    except Exception as err:
        return JSONResponse({"error": f"turn prediction failed: {err}"}, status_code=500)
    return JSONResponse(
        {
            "prediction": prediction,
            "probability": probability,
            "is_complete": bool(prediction),
        }
    )


def _load(onnx_path: str) -> None:
    """Build the ONNX session single-threaded — the model is tiny and latency wins."""
    global _session, _feature_extractor, _ready
    _ready = False
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    _session = ort.InferenceSession(onnx_path, sess_options=so, providers=["CPUExecutionProvider"])
    _feature_extractor = WhisperFeatureExtractor(chunk_length=WINDOW_SECONDS)


def _warmup() -> bool:
    """One throwaway inference so the first real turn check isn't a cold start."""
    global _ready
    _ready = False
    try:
        prob, _ = _model_gate.run(
            _predict,
            np.zeros(SAMPLE_RATE, dtype=np.float32),
            SAMPLE_RATE,
        )
        _ready = True
        print(f"[turn] warmed up (silence prob={prob:.3f})", flush=True)
        return True
    except Exception as err:
        print(f"[turn] warmup failed: {err}", flush=True)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Smart-Turn v3 end-of-turn server for Cicero")
    parser.add_argument("--port", type=int, default=8087, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument(
        "--model",
        type=str,
        default="pipecat-ai/smart-turn-v3",
        help="HuggingFace repo id hosting the ONNX checkpoint",
    )
    parser.add_argument(
        "--onnx-file",
        type=str,
        default="smart-turn-v3.2-cpu.onnx",
        help="ONNX filename within the repo",
    )
    parser.add_argument("--threshold", type=float, default=0.5, help="P(complete) cutoff for the prediction label")
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=TURN_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    global _threshold, _model_gate
    if not math.isfinite(args.threshold) or args.threshold < 0 or args.threshold > 1:
        parser.error("--threshold must be between 0 and 1")
    _threshold = args.threshold
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        TURN_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate

    onnx_path = hf_hub_download(args.model, args.onnx_file)
    _load(onnx_path)
    print(f"[turn] loaded {args.model}/{args.onnx_file}", flush=True)
    if not _warmup():
        print("[turn] FATAL: warmup prediction failed", file=sys.stderr, flush=True)
        sys.exit(1)
    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
