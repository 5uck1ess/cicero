"""Laya switchboard sidecar: typed intent, target and request-now questions.

POST /v1/switchboard {"utterance": str, "roster": [{"name": str, "aliases": [str]}]}
GET /health reports readiness, checkpoint name and current device.
Never logs utterances. Run with requirements/laya-switchboard.txt and --ckpt.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Callable, Optional

# Checkpoint training strings: copied verbatim from sb_common_ref.py.
INTENTS = ["transfer", "release", "rollcall", "standup", "callme", "none"]
# One line per intent, condensed from Cicero's intentPrompt (src/brain/switchboard-intent.ts).
INTENT_DESC = {
    "transfer": "speak with one particular employee now in this conversation",
    "release": "end the current employee conversation, undo the transfer, return to the main assistant or reception",
    "rollcall": "gather the employees for introductions, attendance, presence check-ins or a group connection",
    "standup": "get progress or status updates from the employees as a group",
    "callme": "place an outgoing call to the operator's phone now, optionally with one employee",
    "none": "ordinary work, small talk, mentions or questions about actions, unclear speech",
}
INTENT_INSTR = ("Which switchboard action does the operator want? Interpret meaning, paraphrases and speech "
                "recognition noise. Discussing an action, past or hypothetical mentions are none.")
TARGET_INSTR = ("Which employee should the operator be connected to, or called by? Only for a transfer or a "
                "call-me request; otherwise nobody, even if an employee is mentioned.")
NOW_INSTR = ("The operator is requesting this action now (including polite questions and delegation), "
             "not mentioning it in the past, hypothetically, for later, or asking about it.")
NOBODY = "nobody"

# Covers even JSON-escaped Unicode at every field's maximum length.
MAX_BODY_BYTES = 1024 * 1024
MAX_UTTERANCE = 2000
MAX_LANES = 32
MAX_ALIASES = 16
MAX_STRING = 128
HTTP_TIMEOUT = 5.0


def questions(roster: dict) -> dict:
    tgt = {name: "also called " + ", ".join(l.get("aliases") or [name]) for name, l in roster.items()}
    tgt[NOBODY] = "no particular employee is named or meant"
    return {
        "intent": {"type": "choice", "instructions": INTENT_INSTR, "criteria": dict(INTENT_DESC)},
        "target": {"type": "choice", "instructions": TARGET_INSTR, "criteria": tgt},
        "request_now": {"type": "noul", "instructions": NOW_INSTR},
    }


def state(utterance: str) -> str:
    return f"Operator said: {' '.join(utterance.split())[:500]}"


def parse(intent: str, target: str | None, request_now: bool, confidence: float) -> dict:
    """Reference parse rules, retaining the selected probability for none on the wire."""
    none = {"intent": "none", "target": None, "request_now": False, "confidence": float(confidence)}
    if intent not in INTENTS or not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError("invalid intent answer")
    if target is not None and (not isinstance(target, str) or len(target) > MAX_STRING):
        raise ValueError("invalid target answer")
    if intent == "none":
        return none
    if intent == "transfer" and target is None:
        return none
    return {"intent": intent, "target": target if intent in ("transfer", "callme") else None,
            "request_now": bool(request_now), "confidence": float(confidence)}


def from_answers(ans: dict) -> dict:
    """Laya/Jev answers -> parsed intent. ans values expose .choice/.probabilities/.noul (dict or attrs)."""
    g = lambda a, k: a[k] if isinstance(a, dict) else getattr(a, k)
    ia, ta, na = ans["intent"], ans["target"], ans["request_now"]
    intent = g(ia, "choice")
    conf = float(g(ia, "probabilities")[intent])
    target = g(ta, "choice")
    # Only callme has a deferred form ("call me when ..."); every other action is a present request
    # in the teacher data (Fable never labels them request_now=false), so don't let the head veto it.
    now = float(g(na, "noul")) > 0.5 if intent == "callme" else True
    return parse(intent, None if target == NOBODY else target, now, conf)

def parse_request(body: bytes) -> tuple[str, dict]:
    """Validate before retaining or passing any request data to the model."""
    if len(body) > MAX_BODY_BYTES:
        raise ValueError("body too large")
    data = json.loads(body.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("body must be an object")
    utterance, lanes = data.get("utterance"), data.get("roster")
    if not isinstance(utterance, str) or len(utterance) > MAX_UTTERANCE:
        raise ValueError("invalid utterance")
    if not isinstance(lanes, list) or len(lanes) > MAX_LANES:
        raise ValueError("invalid roster")
    roster = {}
    for lane in lanes:
        if not isinstance(lane, dict):
            raise ValueError("invalid lane")
        name, aliases = lane.get("name"), lane.get("aliases")
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_STRING:
            raise ValueError("invalid lane name")
        if name == NOBODY or name in roster:
            raise ValueError("reserved or duplicate lane name")
        if not isinstance(aliases, list) or len(aliases) > MAX_ALIASES or any(
            not isinstance(alias, str) or len(alias) > MAX_STRING for alias in aliases
        ):
            raise ValueError("invalid aliases")
        roster[name] = {"aliases": aliases}
    return utterance, roster


Scorer = Callable[[str, dict], dict]


def desired_device(running: Any, cpu_when: "re.Pattern[str]") -> Optional[str]:
    """Where the model should live, given llama-swap's GET /running body.

    "cpu" while a model matching `cpu_when` is loaded OR still starting (moving at "starting"
    frees the VRAM before the big model allocates); "cuda" otherwise; None if the body is not
    understood, meaning "leave it where it is".
    """
    if not isinstance(running, dict) or not isinstance(running.get("running"), list):
        return None
    for m in running["running"]:
        if isinstance(m, dict) and isinstance(m.get("model"), str) and cpu_when.search(m["model"]) \
                and m.get("state") in ("starting", "ready"):
            return "cpu"
    return "cuda"


class LayaModel:
    """A Laya agent that can move between GPU and CPU at runtime (all moves under `lock`)."""

    def __init__(self, ckpt: str, device: str):
        import laya  # imported here so the protocol code above is testable without the model
        import torch

        self.torch = torch
        self.lock = threading.Lock()
        self.agent = laya.Agent(ckpt, device=device)
        self.gpu_settings = (self.agent.dtype, self.agent.amp_enabled) if self.agent.device.type == "cuda" else None

    @property
    def device(self) -> str:
        return self.agent.device.type

    def move(self, target: str) -> None:
        torch = self.torch
        if target == self.device or (target == "cuda" and not torch.cuda.is_available()):
            return
        with self.lock:
            a = self.agent
            if target == "cpu":
                a.model.to("cpu"); a.device = torch.device("cpu")
                a.dtype, a.amp_enabled = torch.float32, False
                torch.cuda.empty_cache()
            else:
                try:
                    a.model.to("cuda"); a.device = torch.device("cuda")
                except torch.cuda.OutOfMemoryError:
                    a.model.to("cpu"); torch.cuda.empty_cache()
                    print("laya-switchboard: no room on the GPU, staying on CPU", file=sys.stderr, flush=True)
                    return
                if self.gpu_settings is None:  # started on CPU: use laya's own CUDA defaults
                    self.gpu_settings = (torch.float16, True)
                a.dtype, a.amp_enabled = self.gpu_settings
        print(f"laya-switchboard: now on {self.device}", file=sys.stderr, flush=True)

    def score(self, state: str, questions: dict) -> dict:
        with self.lock:
            out = self.agent.system_one(state, questions, max_len=512, head_max_len=384)
        return out["answers"]


def follow_llama_swap(model: LayaModel, url: str, cpu_when: "re.Pattern[str]", interval: float,
                      stop: threading.Event) -> None:
    """Poll llama-swap and keep the switchboard off the GPU while a big model needs it."""
    while not stop.is_set():
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                target = desired_device(json.loads(r.read(64 * 1024)), cpu_when)
        except Exception:
            target = None  # llama-swap down or restarting: leave the model where it is
        if target:
            try:
                model.move(target)
            except Exception as exc:
                print(f"laya-switchboard: device move failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        stop.wait(interval)


def make_handler(score: Scorer, model_name: str, device: Callable[[], str] = lambda: "unknown"):
    lock = threading.Lock()  # one model, one forward pass at a time

    class Handler(BaseHTTPRequestHandler):
        server_version = "laya-switchboard/1"

        def setup(self) -> None:
            self.request.settimeout(HTTP_TIMEOUT)
            super().setup()

        def log_message(self, fmt: str, *args: Any) -> None:  # never log transcripts
            return

        def _send(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(200, {"ok": True, "model": model_name, "device": device()})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/v1/switchboard":
                self._send(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                self._send(400, {"error": "invalid body length"})
                return
            try:
                # An absolute read deadline also bounds a peer trickling bytes.
                deadline = time.monotonic() + HTTP_TIMEOUT
                body = bytearray()
                while len(body) < length:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError()
                    self.connection.settimeout(remaining)
                    chunk = self.rfile.read1(length - len(body))
                    if not chunk:
                        raise ValueError("incomplete body")
                    body.extend(chunk)
                self.connection.settimeout(HTTP_TIMEOUT)
                utterance, roster = parse_request(body)
            except (ValueError, OSError, RecursionError):
                self._send(400, {"error": "invalid request"})
                return
            try:
                with lock:
                    result = from_answers(score(state(utterance), questions(roster)))
            except Exception:  # never expose provider errors or transcript text
                self._send(500, {"error": "classification failed"})
                return
            self._send(200, result)

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--ckpt", required=True, help="fine-tuned Laya checkpoint directory")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8096)
    ap.add_argument("--device", default="cuda", help="starting device: cuda | cpu")
    ap.add_argument("--llama-swap", default="", help="llama-swap /running URL to follow, e.g. "
                    "http://127.0.0.1:8080/running (empty = stay on --device)")
    ap.add_argument("--cpu-when", default=r"^qwen3\.8", help="regex: move to CPU while a matching llama-swap model is loaded")
    ap.add_argument("--poll", type=float, default=1.0, help="seconds between llama-swap checks")
    a = ap.parse_args()
    if not math.isfinite(a.poll) or a.poll <= 0:
        ap.error("--poll must be finite and positive")
    cpu_when = re.compile(a.cpu_when)
    ckpt = os.path.expanduser(a.ckpt)
    model = LayaModel(ckpt, a.device)
    model.score(state("warm up"), questions({}))
    stop = threading.Event()
    follower = None
    server = HTTPServer((a.host, a.port), make_handler(model.score, os.path.basename(ckpt.rstrip("/")),
                                                       lambda: model.device))
    if a.llama_swap:
        follower = threading.Thread(target=follow_llama_swap, args=(model, a.llama_swap, cpu_when, a.poll, stop),
                         daemon=True)
    print(f"laya-switchboard listening on http://{a.host}:{a.port}/v1/switchboard ({model.device})", file=sys.stderr, flush=True)
    try:
        if follower is not None:
            follower.start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        if follower is not None and follower.ident is not None:
            follower.join(timeout=3)
    return 0


if __name__ == "__main__":
    sys.exit(main())
