"""faster-whisper (CTranslate2) STT server for Cicero — the CUDA/CPU sibling of
the Mac `stt_server.py` (MLX).

CTranslate2 is the fastest practical Whisper engine on an NVIDIA GPU (custom
CUDA kernels, FP16/INT8) — ahead of raw PyTorch and whisper.cpp/ggml for the
short single-utterance turns a voice loop transcribes. It runs the SAME model
you use on Mac: `large-v3-turbo` (mobiuslabsgmbh/faster-whisper-large-v3-turbo) is
the CTranslate2 build of the MLX `whisper-large-v3-turbo`, so accuracy is at
parity across platforms.

Runs from a dedicated `.venv-stt` (symlink to a venv that ships faster-whisper +
torch's bundled CUDA 12 / cuDNN 9 libs), same pattern as `.venv-kokoro`.

Exposes the OpenAI-ish surface the TypeScript provider expects
(src/backends/stt/faster-whisper.ts):
    POST /v1/audio/transcriptions  (multipart file, model, response_format) -> {"text": ...}
    GET  /health                                                            -> {"status": ...}

CRITICAL — cuDNN preload: CTranslate2 4.x dlopens libcudnn/libcublas itself and
won't find them unless they're already resolved. Rather than require the caller
to set LD_LIBRARY_PATH, we preload the venv's bundled nvidia libs with ctypes
(RTLD_GLOBAL) BEFORE importing faster_whisper, so CT2's own dlopen resolves
against the already-loaded symbols. This keeps the launcher (the managed-server
command) a plain `python server.py` with no special env.

CRITICAL — pre-warm: the first GPU transcription pays a one-time model-load +
kernel-autotune cost. This server transcribes 1s of silence at startup BEFORE
serving, so the first real utterance is warm (mirrors the kokoro warmup).
"""

from __future__ import annotations

import argparse
import ctypes
import glob
import io
import os
import site
import sys
from collections.abc import Iterable

# --- Preload bundled CUDA libs so CTranslate2's dlopen resolves (see docstring).
def _preload_cuda_libs() -> None:
    roots = list(site.getsitepackages()) if hasattr(site, "getsitepackages") else []
    roots.append(os.path.join(sys.prefix, "lib"))
    patterns = ("nvidia/cudnn/lib/libcudnn*.so*", "nvidia/cublas/lib/libcublas*.so*")
    seen: set[str] = set()
    for root in roots:
        for pattern in patterns:
            for so in glob.glob(os.path.join(root, pattern)):
                if so in seen:
                    continue
                seen.add(so)
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass  # best-effort; CPU path or already-resolved lib


_preload_cuda_libs()

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402
from sidecar_limits import (  # noqa: E402
    AdmissionError,
    MAX_AUDIO_UPLOAD_BYTES,
    MAX_MULTIPART_BODY_BYTES,
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_SEGMENTS,
    ModelGate,
    ModelGateError,
    RequestBodyLimitMiddleware,
    STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
    model_gate_pair,
    read_file_limited,
    validate_pcm_wav_bytes,
)

app = FastAPI(title="Cicero faster-whisper STT")
app.add_middleware(
    RequestBodyLimitMiddleware,
    limits={"/v1/audio/transcriptions": MAX_MULTIPART_BODY_BYTES},
)

# Set at startup.
_model: WhisperModel | None = None
_model_name: str = "large-v3-turbo"
_language: str | None = "en"  # None = Whisper auto-detect
_model_gate = ModelGate(timeout_seconds=STT_MODEL_INFERENCE_TIMEOUT_SECONDS)


def bounded_transcript(segments: Iterable[object]) -> str:
    parts: list[str] = []
    characters = 0
    for segment_count, segment in enumerate(segments, start=1):
        if segment_count > MAX_TRANSCRIPT_SEGMENTS:
            raise RuntimeError("transcription returned too many segments")
        text = getattr(segment, "text", None)
        if not isinstance(text, str):
            raise RuntimeError("transcription returned invalid segment text")
        if not text:
            continue
        characters += len(text)
        if characters > MAX_TRANSCRIPT_CHARS:
            raise RuntimeError("transcription text is too long")
        parts.append(text)
    return "".join(parts).strip()


def _transcribe_bytes(data: bytes) -> str:
    """Decode WAV bytes to float32 mono @ 16kHz and run faster-whisper.

    Cicero sends one short utterance per turn, so we greedily concatenate the
    (typically single) segment. `condition_on_previous_text=False` keeps each
    turn independent — no context bleed between utterances."""
    if _model is None:
        raise RuntimeError("model not loaded")
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)  # downmix to mono
    if sr != 16000:
        # faster-whisper expects 16kHz; linear resample is fine for speech.
        n = int(round(len(audio) * 16000 / sr))
        audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                          np.arange(len(audio)), audio).astype("float32")
    segments, _info = _model.transcribe(
        audio,
        language=_language,
        beam_size=5,
        condition_on_previous_text=False,
        # Silero VAD gate: silent/noise-only audio yields no segments instead of
        # Whisper's hallucinated "You"/"Thank you." — a mis-captured utterance
        # becomes "didn't catch that" rather than a phantom brain turn.
        vad_filter=True,
    )
    return bounded_transcript(segments)


@app.get("/")
async def root():
    if _model is None or not _model_gate.healthy:
        return JSONResponse(
            {"status": "unhealthy", "error": _model_gate.unhealthy_reason or "model not loaded"},
            status_code=503,
        )
    return {"status": "ok"}


@app.get("/health")
async def health():
    """Health endpoint the TypeScript provider probes. Only ok once warm."""
    return await root()


@app.post("/v1/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    response_format: str = Form(default="json"),
) -> JSONResponse:
    # Plain `def` (not async): FastAPI runs it in a threadpool, so the blocking
    # CTranslate2 inference doesn't stall the event loop (health probes stay live).
    if _model is None:
        return JSONResponse({"error": "model not loaded"}, status_code=503)
    try:
        data = read_file_limited(file.file, MAX_AUDIO_UPLOAD_BYTES)
        if not data:
            raise AdmissionError("empty audio")
        validate_pcm_wav_bytes(data)
    except AdmissionError as err:
        return JSONResponse(
            {"error": str(err)},
            status_code=err.status_code,
            headers={"Connection": "close"} if err.status_code == 413 else None,
        )
    except Exception as err:
        return JSONResponse({"error": f"audio upload failed: {err}"}, status_code=400)
    try:
        text = _model_gate.run(_transcribe_bytes, data)
    except ModelGateError as err:
        headers = {"Retry-After": "1"} if err.status_code == 429 else None
        return JSONResponse({"error": str(err)}, status_code=err.status_code, headers=headers)
    except Exception as err:  # decode / inference failure
        return JSONResponse({"error": f"transcription failed: {err}"}, status_code=500)
    if len(text) > MAX_TRANSCRIPT_CHARS:
        return JSONResponse({"error": "transcription text is too long"}, status_code=500)
    return JSONResponse({"text": text})


def main() -> None:
    parser = argparse.ArgumentParser(description="faster-whisper STT server for Cicero")
    parser.add_argument("--port", type=int, default=8083)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--model", type=str, default="large-v3-turbo")
    parser.add_argument("--device", type=str, default="auto", help="cuda | cpu | auto")
    parser.add_argument("--compute-type", type=str, default="auto",
                        help="float16 | int8_float16 | int8 | auto")
    parser.add_argument("--language", type=str, default="en",
                        help="Transcription language code (e.g. en, es, de) or 'auto' to detect")
    parser.add_argument(
        "--inference-timeout",
        type=float,
        default=STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
        help="Native inference watchdog deadline in seconds",
    )
    args = parser.parse_args()

    device = args.device
    compute_type = args.compute_type
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    global _model, _model_name, _language, _model_gate
    _model_name = args.model
    _language = None if args.language == "auto" else args.language
    warmup_gate, request_gate = model_gate_pair(
        args.inference_timeout,
        STT_MODEL_INFERENCE_TIMEOUT_SECONDS,
    )
    _model_gate = warmup_gate
    _model = WhisperModel(args.model, device=device, compute_type=compute_type)

    # Pre-warm: one throwaway pass on 1s of silence so the first real utterance
    # is warm (model load + CUDA autotune paid up front).
    # A warmup failure means every real transcription would fail the same way
    # (broken CUDA/cuDNN, bad model), so die loudly now — the daemon watches for
    # early exit and surfaces this traceback instead of reporting a
    # healthy-but-dead server.
    try:
        buf = io.BytesIO()
        sf.write(buf, np.zeros(16000, dtype="float32"), 16000, format="WAV", subtype="PCM_16")
        _model_gate.run(_transcribe_bytes, buf.getvalue())
        print(f"[stt] warmed up {args.model} on {device}/{compute_type}", flush=True)
    except Exception:
        import traceback

        traceback.print_exc()
        print(f"[stt] FATAL: warmup transcription failed ({args.model} on {device}/{compute_type})", flush=True)
        sys.exit(1)

    _model_gate = request_gate
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
