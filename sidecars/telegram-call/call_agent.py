#!/usr/bin/env python3
"""Cicero on a real phone call — Telegram private-call bridge.

A userbot (pyrogram session from login.py) plus pytgcalls/ntgcalls carries a
live 1:1 Telegram call; this bridge pipes the call's audio through Cicero's
existing turn pipeline:

    caller audio (48k mono s16) → energy VAD → authenticated WebSocket WAV
        → streamed transcript/reply/audio → resample → frames back into the call

So the person on the phone is talking to the same brain, same cloned voice,
same everything as the browser client — just over a phone call with the
screen locked.

Usage (inside ~/.cicero/tgcalls-venv):
    python call_agent.py --call <user-id-or-@username>   # Cicero rings you
    python call_agent.py --listen                        # auto-answer when you ring Cicero

Config comes from the repo .env / environment:
    CICERO_TG_API_ID / CICERO_TG_API_HASH   Telegram app credentials
    CICERO_WEB_URL     default https://127.0.0.1:8090 (local cert is trusted)
    CICERO_WEB_TOKEN   default read from ~/.cicero/config.yaml web_voice.token
    CICERO_WEB_CA_FILE optional CA/certificate PEM for a remote Cicero daemon
    CICERO_WEB_INSECURE_TLS
                       set exactly to I_UNDERSTAND only for a legacy bad cert
    CICERO_WEB_ALLOW_PLAINTEXT
                       exact acknowledgement required for non-loopback HTTP
    CICERO_CALL_*_TIMEOUT_S
                       bounded HTTP, WebSocket, and call-setup deadline tuning
    CICERO_TG_ALLOWED  comma-separated user ids allowed to call in; required for
                       --listen unless the explicit allow-any override is set
    CICERO_TG_ALLOW_ANY_CALLER
                       set exactly to I_UNDERSTAND to accept calls from anyone
"""
import argparse
import asyncio
import base64
import json
import os
import signal
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

from call_access import (
    incoming_call_allowed,
    parse_allow_any_caller,
    parse_allowed_callers,
    validate_listener_access,
)
from call_security import (
    MAX_HTTP_REQUEST_BYTES,
    MAX_HTTP_RESPONSE_BYTES,
    MAX_WAV_BYTES,
    bounded_float,
    build_ssl_context,
    consume_callback_reason,
    decode_pcm16_wav,
    disable_websocket_redirects,
    ensure_private_directory,
    load_env_file,
    normalize_web_url,
    open_url_no_redirect,
    parse_exact_ack,
    read_private_text,
    read_response_limited,
    redact_secrets,
    secure_session_files,
    validate_bearer_token,
    websocket_auth_kwargs,
    websocket_url,
)

# ---------- env / config ----------

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"
try:
    load_env_file(ENV_FILE)
except (OSError, ValueError) as exc:
    if __name__ == "__main__":
        sys.exit(f"Refusing insecure/invalid .env: {redact_secrets(exc, os.environ.get('CICERO_TG_API_HASH'))}")
    raise

API_ID = os.environ.get("CICERO_TG_API_ID")
API_HASH = os.environ.get("CICERO_TG_API_HASH")
CICERO_HOME = Path.home() / ".cicero"
WORKDIR = CICERO_HOME / "telegram-call"
DEFAULT_WEB_CA = CICERO_HOME / "web-voice" / "cert.pem"
# Heartbeat the callback poll loop re-touches every tick. Its mtime is the
# daemon's only honest signal that a dial-back CONSUMER is alive: the daemon
# refuses to promise "Ringing you now." when this is missing or stale. It
# stays fresh even while we defer a ring (mid-call, empty allowlist) — those
# branches keep the loop running — so a waiting listener still reads as alive.
LISTENER_HEARTBEAT = WORKDIR / "listener.alive"


def write_listener_heartbeat(path: Path = LISTENER_HEARTBEAT) -> None:
    """Refresh the callback-consumer heartbeat the daemon polls. Best-effort:
    a heartbeat failure must never break the ring loop."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    except OSError as exc:
        print(f"[call] listener heartbeat write failed: {redact_secrets(exc, TOKEN, API_HASH)}", flush=True)

def runtime_settings() -> tuple[bool, bool, bool, str, Path | None, float, float, float, float, float, float, float, float]:
    allow_plaintext = parse_exact_ack(
        os.environ.get("CICERO_WEB_ALLOW_PLAINTEXT"),
        "CICERO_WEB_ALLOW_PLAINTEXT",
    )
    insecure_tls = parse_exact_ack(
        os.environ.get("CICERO_WEB_INSECURE_TLS"),
        "CICERO_WEB_INSECURE_TLS",
    )
    log_content = parse_exact_ack(
        os.environ.get("CICERO_CALL_LOG_CONTENT"),
        "CICERO_CALL_LOG_CONTENT",
    )
    web_url = normalize_web_url(
        os.environ.get("CICERO_WEB_URL", "https://127.0.0.1:8090"),
        allow_plaintext=allow_plaintext,
    )
    ca_file = Path(os.environ["CICERO_WEB_CA_FILE"]).expanduser() if os.environ.get("CICERO_WEB_CA_FILE") else None
    return (
        allow_plaintext,
        insecure_tls,
        log_content,
        web_url,
        ca_file,
        bounded_float(os.environ, "CICERO_CALL_HTTP_TIMEOUT_S", 60, minimum=1, maximum=180),
        bounded_float(os.environ, "CICERO_CALL_WS_OPEN_TIMEOUT_S", 15, minimum=1, maximum=60),
        bounded_float(os.environ, "CICERO_CALL_WS_IO_TIMEOUT_S", 15, minimum=1, maximum=60),
        bounded_float(os.environ, "CICERO_CALL_SETUP_TIMEOUT_S", 120, minimum=30, maximum=240),
        bounded_float(os.environ, "CICERO_CALL_BARGE_RMS", 1400, minimum=1, maximum=32767),
        bounded_float(os.environ, "CICERO_CALL_BARGE_MIN_S", 0.25, minimum=0.05, maximum=5),
        bounded_float(os.environ, "CICERO_CALL_THINK_RMS", 900, minimum=1, maximum=32767),
        bounded_float(os.environ, "CICERO_CALL_THINK_MIN_S", 0.35, minimum=0.05, maximum=5),
    )


try:
    (
        ALLOW_PLAINTEXT,
        INSECURE_TLS,
        LOG_CONTENT,
        WEB_URL,
        WEB_CA_FILE,
        HTTP_TIMEOUT_S,
        WS_OPEN_TIMEOUT_S,
        WS_IO_TIMEOUT_S,
        CALL_SETUP_TIMEOUT_S,
        CONFIG_BARGE_RMS,
        CONFIG_BARGE_MIN_S,
        CONFIG_THINK_RMS,
        CONFIG_THINK_MIN_S,
    ) = runtime_settings()
except (OSError, ValueError) as exc:
    if __name__ == "__main__":
        sys.exit(f"Invalid Telegram call setting: {redact_secrets(exc, API_HASH)}")
    raise


def ssl_context():
    """Build per-connection so a newly generated/rotated local cert is picked up."""
    return build_ssl_context(
        WEB_URL,
        ca_file=WEB_CA_FILE,
        default_local_ca=DEFAULT_WEB_CA,
        insecure_tls=INSECURE_TLS,
    )

def web_token() -> str:
    tok = os.environ.get("CICERO_WEB_TOKEN")
    if tok:
        token = tok
    else:
        import yaml
        config_path = CICERO_HOME / "config.yaml"
        cfg = yaml.safe_load(read_private_text(config_path))
        try:
            token = cfg["web_voice"]["token"]
        except (AttributeError, KeyError, TypeError) as exc:
            raise ValueError(
                "web_voice.token is missing from ~/.cicero/config.yaml; "
                "set a stable token or CICERO_WEB_TOKEN"
            ) from exc
    return validate_bearer_token(token)

TOKEN = ""  # loaded only after the listener access policy has validated

# ---------- audio helpers (48k mono s16 on the call side) ----------

CALL_RATE = 48000
STT_RATE = 16000

def resample(pcm: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or pcm.size == 0:
        return pcm
    n = int(round(pcm.size * dst / src))
    x_src = np.linspace(0.0, 1.0, pcm.size, endpoint=False)
    x_dst = np.linspace(0.0, 1.0, n, endpoint=False)
    return np.interp(x_dst, x_src, pcm.astype(np.float32)).astype(np.int16)

def pcm_to_wav(pcm: np.ndarray, rate: int) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()

def wav_to_pcm(data: bytes) -> tuple[np.ndarray, int]:
    raw, rate, ch = decode_pcm16_wav(data)
    pcm = np.frombuffer(raw, dtype=np.int16)
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return pcm, rate

# ---------- Cicero API ----------

def api(path: str, body: bytes, content_type: str) -> bytes:
    if len(body) > MAX_HTTP_REQUEST_BYTES:
        raise ValueError(f"HTTP request exceeds {MAX_HTTP_REQUEST_BYTES} bytes")
    req = urllib.request.Request(
        WEB_URL + path,
        data=body,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": content_type},
        method="POST",
    )
    with open_url_no_redirect(req, context=ssl_context(), timeout=HTTP_TIMEOUT_S) as res:
        return read_response_limited(
            res,
            max_bytes=MAX_HTTP_RESPONSE_BYTES,
            deadline_s=HTTP_TIMEOUT_S,
        )

async def cicero_say(text: str) -> np.ndarray | None:
    """Render text in Cicero's voice (greeting) via /api/say."""
    try:
        async with asyncio.timeout(HTTP_TIMEOUT_S + 1):
            raw = await asyncio.to_thread(api, "/api/say", json.dumps({"text": text}).encode(), "application/json")
        pcm, rate = wav_to_pcm(raw)
        return resample(pcm, rate, CALL_RATE)
    except Exception as e:  # greeting is best-effort
        print(f"[bridge] greeting failed: {redact_secrets(e, TOKEN, API_HASH)}", flush=True)
        return None


async def connect_daemon_socket():
    """Open a bounded daemon socket with the bearer in a header, never the URL."""
    import websockets
    disable_websocket_redirects(websockets.connect)
    auth = websocket_auth_kwargs(
        websockets.connect,
        TOKEN,
        version=getattr(websockets, "__version__", ""),
    )
    return await websockets.connect(
        websocket_url(WEB_URL),
        ssl=ssl_context(),
        open_timeout=WS_OPEN_TIMEOUT_S,
        close_timeout=10,
        ping_interval=20,
        ping_timeout=20,
        max_size=8 * 1024 * 1024,
        max_queue=4,
        **auth,
    )


def log_daemon_text(label: str, value: object) -> None:
    """Conversation content is sensitive and stays out of logs by default."""
    text = value if isinstance(value, str) else ""
    if LOG_CONTENT:
        print(f"[call] {label}: {redact_secrets(text, TOKEN, API_HASH)!r}", flush=True)
    else:
        print(f"[call] {label} received ({len(text)} chars; content logging off)", flush=True)

# ---------- the call bridge ----------

from pyrogram import Client  # noqa: E402
from pytgcalls import PyTgCalls  # noqa: E402
from pytgcalls import filters as call_filters  # noqa: E402
from pytgcalls.types import (  # noqa: E402
    CallConfig,
    ChatUpdate,
    Device,
    Direction,
    ExternalMedia,
    Frame,
    MediaStream,
    RecordStream,
    StreamFrames,
)
from pytgcalls.types.raw import AudioParameters  # noqa: E402

class Vad:
    """Energy VAD on the caller's 48k mono stream — same shape as the browser's."""

    OPEN_RMS = 900.0        # int16 scale (~2.7% FS)
    CLOSE_RMS = 500.0
    HANGOVER_S = 0.8
    MIN_UTTER_S = 0.3
    MAX_UTTER_S = 15.0

    def __init__(self) -> None:
        self.buf: list[np.ndarray] = []
        self.speech = False
        self.last_voice = 0.0
        self.started = 0.0

    def feed(self, pcm: np.ndarray, now: float) -> np.ndarray | None:
        """Returns a finished utterance (48k mono) when one closes, else None."""
        rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2))) if pcm.size else 0.0
        if not self.speech:
            if rms >= self.OPEN_RMS:
                self.speech = True
                self.started = now
                self.last_voice = now
                self.buf = [pcm]
            return None
        self.buf.append(pcm)
        if rms >= self.CLOSE_RMS:
            self.last_voice = now
        dur = now - self.started
        if (now - self.last_voice >= self.HANGOVER_S and dur >= self.MIN_UTTER_S) or dur >= self.MAX_UTTER_S:
            utter = np.concatenate(self.buf)
            self.buf = []
            self.speech = False
            return utter
        return None

class Bridge:
    """Full-duplex call bridge over the daemon's streaming WebSocket.

    The old v1 posted each utterance to /api/turn and waited for the whole
    reply WAV — no speech until everything rendered, no interrupting anything.
    This bridge mirrors the browser client instead: utterances stream up, reply
    audio streams down sentence-by-sentence (first word ~1s into a long
    answer), and the caller can interrupt in ANY phase — mid-playback cuts the
    voice within a frame; talking while Cicero is still thinking aborts the
    in-flight turn and the new utterance becomes the instruction. A normal
    conversation, in short.
    """

    FRAME_MS = 10
    FRAME_SAMPLES = CALL_RATE * FRAME_MS // 1000
    # Consecutive whole-clip send failures before the player latches muted and
    # drains the queue instead of hammering send_frame on a dead call. The
    # latch is retryable (repo invariant): while muted, one clip per probe
    # interval is tried for real, so a call that survived a transient wobble
    # gets its voice back without a redial.
    PLAYER_FAILURE_LIMIT = 3
    PLAYER_PROBE_INTERVAL_S = 15.0
    # A live private call delivers incoming frames continuously — silence is
    # still RTP (the energy VAD depends on that). A long gap therefore means
    # the call died without a discard we acted on (hang-up inside the answer
    # window, missed update); the callback poller uses this to self-heal
    # instead of treating the corpse as "already on a call" forever.
    STALE_CALL_S = 15.0
    # Barge-in while Cicero speaks: the phone's echo cancellation keeps our
    # voice out of the caller's stream, but a stricter gate (louder + longer
    # onset than the turn VAD) avoids self-interruption on residual echo.
    # Road-tunable via .env / environment — no code edit needed:
    BARGE_RMS = CONFIG_BARGE_RMS
    BARGE_MIN_S = CONFIG_BARGE_MIN_S
    # Interrupting the THINKING phase needs no echo margin (nothing playing),
    # but a slightly long onset so a cough doesn't cancel a running turn.
    THINK_RMS = CONFIG_THINK_RMS
    THINK_MIN_S = CONFIG_THINK_MIN_S

    def __init__(self, app: Client, calls: PyTgCalls, chat_id: int) -> None:
        self.app = app
        self.calls = calls
        self.chat_id = chat_id
        self.vad = Vad()
        self.ws = None                       # daemon streaming socket
        self.reader: asyncio.Task | None = None
        self.player: asyncio.Task | None = None
        self.reconnector: asyncio.Task | None = None
        # Backpressure caps audio buffered when TTS renders faster than a call
        # can play. The socket's own max_queue adds a second bounded layer.
        self.playq: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=4)
        self.playing = False                 # a clip is being paced into the call
        self.sent_turns = 0                  # utterances sent up
        self.done_turns = 0                  # {done} messages received
        self.gate_started = 0.0              # onset tracking for barge/pivot
        self.gate_buf: list[np.ndarray] = []
        self.last_frame_at = time.monotonic()  # call liveness (see STALE_CALL_S)
        self.closed = False

    # -- lifecycle ----------------------------------------------------------

    async def connect(self) -> None:
        self.ws = await connect_daemon_socket()
        self.reader = asyncio.create_task(self._read_loop())

    def start_player(self) -> None:
        """Begin pacing queued clips into the call — only once the Telegram
        call is actually connected. The daemon flushes parked notifications
        the moment the socket opens, which is before an outgoing callback is
        answered; anything queued that early waits here instead of hitting
        send_frame on a call that is still ringing."""
        if self.player is None or self.player.done():
            self.player = asyncio.create_task(self._play_loop())
        # The ring can take most of a minute; liveness starts counting from
        # the connected call, not from construction, or a pending callback
        # request could reap a just-answered call as stale before its first
        # frames arrive.
        self.last_frame_at = time.monotonic()

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        current = asyncio.current_task()
        tasks = [
            task for task in (self.reader, self.player, self.reconnector)
            if task is not None and task is not current and not task.done()
        ]
        for task in tasks:
            task.cancel()
        ws = self.ws
        self.ws = None
        if ws:
            try:
                async with asyncio.timeout(11):
                    await ws.close()
            except Exception:
                pass
        if tasks:
            try:
                async with asyncio.timeout(5):
                    await asyncio.gather(*tasks, return_exceptions=True)
            except TimeoutError:
                pass
        self._flush_playback()
        self.reader = None
        self.player = None
        self.reconnector = None

    # -- state --------------------------------------------------------------

    def _busy(self) -> bool:
        """A turn is in flight (thinking or audio still queued/playing)."""
        return self.sent_turns > self.done_turns or self.playing or not self.playq.empty()

    def _audio_is_stale(self) -> bool:
        """Audio arriving for an aborted turn (a newer utterance was sent)."""
        return self.done_turns + 1 < self.sent_turns

    # -- daemon -> call -----------------------------------------------------

    async def _read_loop(self) -> None:
        try:
            async for msg in self.ws:
                if isinstance(msg, (bytes, bytearray)):
                    if self._audio_is_stale():
                        continue  # sentence from a turn the caller already talked over
                    pcm, rate = wav_to_pcm(bytes(msg))
                    await self.playq.put(resample(pcm, rate, CALL_RATE))
                    continue
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                t = data.get("type")
                if t == "transcript":
                    log_daemon_text("transcript", data.get("text", ""))
                elif t == "sentence" and not self._audio_is_stale():
                    log_daemon_text("reply sentence", data.get("text", ""))
                elif t == "done":
                    self.done_turns += 1
                elif t == "error":
                    log_daemon_text("turn error", data.get("message", ""))
                    self.done_turns += 1  # an errored turn sends no done
                elif t == "notify" and not self._busy() and data.get("audioBase64"):
                    # Proactive voice-back mid-call: Cicero speaks up between turns.
                    log_daemon_text("notification", data.get("text", ""))
                    encoded = data["audioBase64"]
                    if not isinstance(encoded, str) or len(encoded) > (MAX_WAV_BYTES * 4 // 3) + 8:
                        raise ValueError("notification audio exceeds the call bridge limit")
                    pcm, rate = wav_to_pcm(base64.b64decode(encoded, validate=True))
                    await self.playq.put(resample(pcm, rate, CALL_RATE))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not self.closed:
                print(
                    f"[call] daemon socket lost: {redact_secrets(e, TOKEN, API_HASH)} — reconnecting",
                    flush=True,
                )
                if self.reconnector is None or self.reconnector.done():
                    self.reconnector = asyncio.create_task(self._reconnect())

    async def _reconnect(self) -> None:
        """The daemon restarted mid-call: re-dial its socket instead of dead air."""
        self._flush_playback()
        self.sent_turns = self.done_turns = 0  # fresh server session, fresh accounting
        for delay in (1, 2, 5, 5, 10, 10, 15):
            if self.closed:
                return
            await asyncio.sleep(delay)
            try:
                old_ws = self.ws
                self.ws = await connect_daemon_socket()
                if old_ws is not None:
                    try:
                        await old_ws.close()
                    except Exception:
                        pass
                self.reader = asyncio.create_task(self._read_loop())
                print("[call] daemon socket restored", flush=True)
                return
            except Exception as e:
                print(
                    f"[call] reconnect failed ({redact_secrets(e, TOKEN, API_HASH)}); retrying",
                    flush=True,
                )
        print("[call] daemon unreachable — giving up on this call", flush=True)

    async def _play_loop(self) -> None:
        """Pace queued reply clips into the call; a barge-in flushes the queue.

        Frames are paced against an ABSOLUTE deadline, not a relative sleep:
        asyncio.sleep(0.01) overshoots by a millisecond or three every call
        (worse while TTS renders the next sentence), and per-frame drift adds
        up to audible stutter on long replies. The deadline carries across
        clips so back-to-back sentences flow gap-free; after a real stall
        (>200ms behind) it resyncs instead of bursting frames to catch up.
        """
        loop = asyncio.get_running_loop()
        next_at = loop.time()
        failed_clips = 0  # consecutive whole-clip send failures
        probe_at = 0.0    # while latched: earliest time to try a clip for real
        while True:
            pcm48 = await self.playq.get()
            latched = failed_clips >= self.PLAYER_FAILURE_LIMIT
            if latched and loop.time() < probe_at:
                continue  # muted: drain quietly between probes, stay cancellable
            self.playing = True
            next_at = max(next_at, loop.time())  # fresh clip after idle: start now
            sent_any = False
            try:
                for off in range(0, pcm48.size, self.FRAME_SAMPLES):
                    if self.playq.empty() and not self.playing:
                        break  # flushed by a barge-in
                    chunk = pcm48[off : off + self.FRAME_SAMPLES]
                    info = Frame.Info(capture_time=int(time.time() * 1000))
                    async with asyncio.timeout(2):
                        await self.calls.send_frame(self.chat_id, Device.MICROPHONE, chunk.tobytes(), info)
                    sent_any = True
                    next_at += self.FRAME_MS / 1000
                    delay = next_at - loop.time()
                    if delay > 0:
                        await asyncio.sleep(delay)
                    elif delay < -0.2:
                        next_at = loop.time()  # stalled hard — resync, don't burst
                # Health is proven only by a frame actually reaching the call:
                # a clip flushed by a barge-in before its first frame says
                # nothing, and must not unlatch a muted player.
                if sent_any:
                    if latched:
                        print("[call] playback recovered — resuming", flush=True)
                    failed_clips = 0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Drop THIS clip, keep the player: a transient send failure
                # (call dropped mid-clip, brief transport wobble) must not
                # silence every later reply on a bridge that has no other
                # recovery path until the next call replaces it.
                if self.closed:
                    return
                failed_clips += 1
                if failed_clips == self.PLAYER_FAILURE_LIMIT:
                    print(
                        f"[call] playback muted after {failed_clips} consecutive clip failures "
                        f"({redact_secrets(e, TOKEN, API_HASH)}) — probing every "
                        f"{self.PLAYER_PROBE_INTERVAL_S:.0f}s until it recovers or the call is replaced",
                        flush=True,
                    )
                elif failed_clips < self.PLAYER_FAILURE_LIMIT:
                    print(f"[call] clip dropped mid-play ({redact_secrets(e, TOKEN, API_HASH)}) — player continues", flush=True)
                # probe failures past the limit stay quiet — one attempt per interval
                if failed_clips >= self.PLAYER_FAILURE_LIMIT:
                    probe_at = loop.time() + self.PLAYER_PROBE_INTERVAL_S
                next_at = loop.time()
            finally:
                self.playing = False

    def _flush_playback(self) -> None:
        self.playing = False  # stops the frame loop within one frame
        while not self.playq.empty():
            try:
                self.playq.get_nowait()
            except asyncio.QueueEmpty:
                break

    # -- call -> daemon -----------------------------------------------------

    async def _send_utterance(self, utter48: np.ndarray) -> None:
        if self.ws is None:
            raise ConnectionError("daemon socket is unavailable")
        self.sent_turns += 1  # a new utterance implicitly aborts the previous turn
        async with asyncio.timeout(WS_IO_TIMEOUT_S):
            await self.ws.send(pcm_to_wav(resample(utter48, CALL_RATE, STT_RATE), STT_RATE))

    async def _abort_turn(self) -> None:
        try:
            async with asyncio.timeout(WS_IO_TIMEOUT_S):
                await self.ws.send(json.dumps({"type": "abort"}))
        except Exception as e:
            print(
                f"[call] abort not delivered (socket down?): {redact_secrets(e, TOKEN, API_HASH)}",
                flush=True,
            )

    def _interrupt(self, now: float, label: str) -> None:
        """Caller talked over Cicero: cut audio, kill the turn, capture the pivot."""
        self._flush_playback()
        self.sent_turns += 1  # anything still rendering for the old turn is stale
        self.done_turns += 1  # (the abort's own done rebalances the counters)
        # Seed the VAD so the interruption's start isn't clipped.
        self.vad.speech = True
        self.vad.started = self.gate_started or now
        self.vad.last_voice = now
        self.vad.buf = list(self.gate_buf)
        self.gate_started = 0.0
        self.gate_buf = []
        print(f"[call] interrupted while {label} — listening", flush=True)

    def _watch_gate(self, pcm: np.ndarray, now: float, rms_thr: float, min_s: float, label: str) -> bool:
        rms = float(np.sqrt(np.mean(pcm.astype(np.float32) ** 2))) if pcm.size else 0.0
        if rms < rms_thr:
            self.gate_started = 0.0
            self.gate_buf = []
            return False
        if not self.gate_started:
            self.gate_started = now
        self.gate_buf.append(pcm)
        if now - self.gate_started >= min_s:
            self._interrupt(now, label)
            return True
        return False

    def stale(self, now: float) -> bool:
        """The call stopped delivering audio long enough ago to be dead."""
        return now - self.last_frame_at >= self.STALE_CALL_S

    async def on_audio(self, pcm: np.ndarray) -> None:
        now = time.monotonic()
        self.last_frame_at = now  # frames prove the call itself is alive
        if self.ws is None:
            return
        if self._busy() and not self.vad.speech:
            # Cicero is speaking or thinking; watch for the caller talking over.
            speaking = self.playing or not self.playq.empty()
            fired = self._watch_gate(
                pcm, now,
                self.BARGE_RMS if speaking else self.THINK_RMS,
                self.BARGE_MIN_S if speaking else self.THINK_MIN_S,
                "speaking" if speaking else "thinking",
            )
            if fired:
                await self._abort_turn()
            return
        utter = self.vad.feed(pcm, now)
        if utter is None:
            return
        try:
            await self._send_utterance(utter)
        except Exception as e:
            print(f"[call] send failed: {redact_secrets(e, TOKEN, API_HASH)}", flush=True)

    async def speak(self, pcm48: np.ndarray) -> None:
        """Queue a locally-rendered clip (the greeting) through the same player."""
        await self.playq.put(pcm48)


def bridge_is_busy(bridge: "Bridge | None") -> bool:
    """Whether a live call is delivering audio right now.

    Callback requests are skipped only in that state — the daemon flushes the
    parked news over the active call's socket, so ringing again is redundant.
    """
    return bridge is not None and not bridge.closed and bridge.ws is not None


def discard_releases_bridge(bridge: "Bridge | None", chat_id: int, answer_in_flight: bool) -> bool:
    """Whether a DISCARDED_CALL update should tear down the current bridge.

    A replacement call discards its predecessor deliberately: while answer()
    holds its lock the only bridge is the new candidate and the update is the
    old call's echo, so the in-flight answer owns all cleanup. Outside that
    window a discard for the bridge's chat is the callee hanging up — the
    bridge must be released, or it reads as "still on a call" forever and
    every later callback request is swallowed (live incident 2026-07-13: the
    phone stopped ringing until the listener was restarted).
    """
    if answer_in_flight:
        return False
    return bridge is not None and bridge.chat_id == chat_id and not bridge.closed


async def run(
    target: str | None,
    *,
    listen: bool,
    allowed: frozenset[int],
    allow_any_caller: bool,
) -> None:
    global TOKEN
    # Keep this guard inside the runtime as well as the CLI so direct callers
    # cannot accidentally bypass the fail-closed listener policy.
    if target is None and not listen:
        raise ValueError("run requires an outgoing target or listener mode")
    validate_listener_access(listen, allowed, allow_any_caller)
    ensure_private_directory(CICERO_HOME)
    secure_session_files(WORKDIR)
    TOKEN = web_token()
    if not API_ID or not API_HASH:
        sys.exit("Set CICERO_TG_API_ID / CICERO_TG_API_HASH first (see login.py).")
    app = Client("cicero", api_id=int(API_ID), api_hash=API_HASH, workdir=str(WORKDIR))
    calls = PyTgCalls(app)
    bridge: Bridge | None = None
    answer_lock = asyncio.Lock()

    seen_devices: set[str] = set()

    @calls.on_update(call_filters.stream_frame(directions=Direction.INCOMING))
    async def frames(_: PyTgCalls, update: StreamFrames) -> None:  # caller's voice
        # Snapshot: `bridge` can be replaced at any await, and a replacement
        # reuses the same chat_id — the old call's frames must not feed it.
        b = bridge
        if b is None or update.chat_id != b.chat_id:
            return
        key = f"{update.direction}/{update.device}"
        if key not in seen_devices:
            seen_devices.add(key)
            print(f"[call] receiving frames: {key}", flush=True)
        for f in update.frames:
            await b.on_audio(np.frombuffer(f.frame, dtype=np.int16))

    @calls.on_update(call_filters.chat_update(ChatUpdate.Status.INCOMING_CALL))
    async def incoming(_client: PyTgCalls, update: ChatUpdate) -> None:
        nonlocal bridge
        if not incoming_call_allowed(update.chat_id, allowed, allow_any_caller):
            print("[call] rejecting caller not in CICERO_TG_ALLOWED", flush=True)
            return
        print("[call] incoming allowed caller — answering", flush=True)
        try:
            await answer(update.chat_id)
        except Exception as exc:
            print(
                f"[call] answer failed: {redact_secrets(exc, TOKEN, API_HASH)}",
                flush=True,
            )

    @calls.on_update(call_filters.chat_update(ChatUpdate.Status.DISCARDED_CALL))
    async def call_ended(_client: PyTgCalls, update: ChatUpdate) -> None:
        nonlocal bridge
        ended = bridge
        if not discard_releases_bridge(ended, update.chat_id, answer_lock.locked()):
            return
        assert ended is not None  # discard_releases_bridge guarantees it
        # Cleanup runs under the answer lock: replacement calls reuse the same
        # chat_id, so an unlocked leave_call() here could hang up a fresh call
        # that answer_locked() installed while our close() was still awaiting.
        # Handlers run on pyrogram's worker pool, so waiting here cannot stall
        # the update pipeline an in-flight answer depends on.
        async with answer_lock:
            if bridge is not ended or ended.closed:
                return  # replaced or already cleaned while we waited
            print("[call] call ended — releasing the bridge", flush=True)
            seen_devices.clear()
            # bridge stays set until cleanup lands: close() flips .closed
            # first, so the busy check goes false immediately, while a
            # cancellation mid-cleanup still leaves the shutdown finally a
            # reference to finish.
            await ended.close()
            await leave_telegram_call(ended.chat_id)
            if bridge is ended:
                bridge = None

    # Texting the agent account: this line is CALLS ONLY (since Jul 10 the
    # Cicero bot is the text surface — chat, "log …", approvals all live
    # there). Here only "call me" is honored; anything else gets one pointer
    # to the right line. Only allowed ids — and never with an empty allow-list
    # (that would let anyone who finds the account drive your agent).
    from pyrogram import filters as msg_filters
    from pyrogram.types import Message

    @app.on_message(msg_filters.private & msg_filters.text)
    async def on_text(_: Client, m: Message) -> None:
        if not allowed or not m.from_user or m.from_user.id not in allowed:
            return
        if m.text.strip().lower().rstrip(".!") in ("call me", "call me back", "ring me"):
            print("[call] dial-back requested by allowed owner", flush=True)
            await m.reply_text("Ringing you now.")
            await answer(m.from_user.id)
            return
        print("[call] non-call text from allowed owner — pointing at the bot", flush=True)
        await m.reply_text('This line is for calls — say "call me" and I\'ll ring you. For everything else, text the Cicero bot.')

    async def answer(chat_id: int) -> None:
        """Serialize replacement calls so two callbacks cannot race lifecycle state."""
        async with answer_lock:
            await answer_locked(chat_id)

    async def leave_telegram_call(chat_id: int) -> None:
        """Best-effort bounded release; py-tgcalls 2.x has no global stop API."""
        try:
            async with asyncio.timeout(15):
                await calls.leave_call(chat_id)
        except Exception:
            # Telegram may already have ended/rejected the call. Bridge/socket
            # cleanup and app.stop() still run, so this is safe to ignore.
            pass

    async def answer_locked(chat_id: int) -> None:
        nonlocal bridge
        if bridge is not None:
            previous_chat_id = bridge.chat_id
            await bridge.close()  # a new call replaces any previous session
            await leave_telegram_call(previous_chat_id)
        candidate = Bridge(app, calls, chat_id)
        bridge = candidate
        call_started = False
        try:
            async with asyncio.timeout(CALL_SETUP_TIMEOUT_S):
                await candidate.connect()  # daemon socket up before any call audio flows
                media = MediaStream(
                    ExternalMedia.AUDIO,  # we push frames ourselves via send_frame
                    audio_parameters=AudioParameters(bitrate=CALL_RATE, channels=1),
                    audio_flags=MediaStream.Flags.REQUIRED,
                    video_flags=MediaStream.Flags.IGNORE,
                )
                await calls.play(chat_id, media, CallConfig(timeout=60))
                call_started = True
                # play() resolves only once the callee accepted and WebRTC is
                # up — NOW queued audio (parked news, the greeting) may flow.
                candidate.start_player()
                # Raw incoming frames (the caller's voice) arrive as StreamFrames updates.
                await calls.record(chat_id, RecordStream(audio=True, audio_parameters=AudioParameters(bitrate=CALL_RATE, channels=1)))
                greeting = await cicero_say("Hey, it's Cicero. What do you need?")
                if greeting is not None and bridge is candidate:
                    await candidate.speak(greeting)
        except Exception:
            if bridge is candidate:
                bridge = None
            await candidate.close()
            if call_started:
                await leave_telegram_call(chat_id)
            raise

    async def callback_poll() -> None:
        """Callback requests from the daemon (a task finished and nobody was
        listening): ring the owner. The parked notification speaks the news in
        the employee's own voice the moment the call connects."""
        nonlocal bridge
        spool = WORKDIR / "callback.request"
        deferred_note = False
        write_listener_heartbeat()  # present immediately, before the first 5s tick
        while True:
            await asyncio.sleep(5)
            # Prove the consumer is alive on every tick — before any deferral
            # branch below — so the daemon can tell a waiting listener from a
            # missing one, not just an unconsumed spool file.
            write_listener_heartbeat()
            # The request is consumed only once we actually ring: a dial-back
            # is an explicit ask and must never be silently lost. While a call
            # is being placed or is live, the request stays spooled and this
            # loop re-evaluates it — after the call ends it rings.
            if not spool.exists():
                deferred_note = False
                continue
            if answer_lock.locked():
                continue  # a call is being placed; leave the request spooled
            b = bridge
            if bridge_is_busy(b):
                if b is not None and b.stale(time.monotonic()):
                    # Self-heal: a discard we never got to act on (hang-up in
                    # the answer window, missed update) left a corpse that
                    # would otherwise swallow every dial-back forever. Same
                    # lock discipline as call_ended: never leave_call unlocked.
                    async with answer_lock:
                        if bridge is b and not b.closed:
                            print(
                                f"[call] releasing stale call (no caller audio for {Bridge.STALE_CALL_S:.0f}s) — ringing",
                                flush=True,
                            )
                            await b.close()
                            await leave_telegram_call(b.chat_id)
                            bridge = None
                    continue  # ring on the next tick, from a clean slate
                if not deferred_note:
                    # Never silent: a waiting request must be explainable
                    # from the log (once, not every 5s tick).
                    print("[call] callback request deferred — on a live call; it rings after the call ends", flush=True)
                    deferred_note = True
                continue
            deferred_note = False
            target_id = next(iter(allowed), None)
            if target_id is None:
                # Checked before consuming so a misconfiguration doesn't eat
                # the request; it rings once CICERO_TG_ALLOWED is fixed.
                print("[call] callback requested but CICERO_TG_ALLOWED is empty — leaving it spooled", flush=True)
                continue
            try:
                reason = consume_callback_reason(spool)
            except Exception as exc:
                print(
                    f"[security] callback spool rejected: {redact_secrets(exc, TOKEN, API_HASH)}",
                    flush=True,
                )
                # Quarantine, or an unreadable/symlinked file spins this loop
                # and blocks every later request behind the same pathname.
                try:
                    spool.replace(spool.with_name("callback.rejected"))
                except OSError:
                    try:
                        spool.unlink(missing_ok=True)
                    except OSError as unlink_exc:  # e.g. a directory planted at the path
                        print(
                            f"[security] callback spool quarantine failed: {redact_secrets(unlink_exc, TOKEN, API_HASH)}",
                            flush=True,
                        )
                continue
            if reason is None:
                continue
            # Consumed BEFORE ringing on purpose: one attempt per request. A
            # declined or timed-out ring is the owner saying "not now" — it
            # must fail with a log line, never retry into ring-spam.
            print("[call] placing callback to the configured owner", flush=True)
            try:
                await answer(target_id)
            except Exception as e:
                print(
                    f"[call] callback ring failed: {redact_secrets(e, TOKEN, API_HASH)}",
                    flush=True,
                )

    # `pkill -f call_agent.py` is the sanctioned reload; a default SIGTERM
    # kills the process mid-await with no line in the log and no cleanup,
    # abandoning any live Telegram call. Cancel the main task instead so the
    # finally below releases the call and the session, and the supervisor
    # pane shows why the listener exited. Removed first thing in that finally,
    # so a second SIGTERM during cleanup still hard-kills.
    loop = asyncio.get_running_loop()
    main_task = asyncio.current_task()

    def _sigterm() -> None:
        print("[call] SIGTERM received — shutting down", flush=True)
        if main_task is not None and not main_task.done():
            main_task.cancel()

    sigterm_installed = False
    try:
        loop.add_signal_handler(signal.SIGTERM, _sigterm)
        sigterm_installed = True
    except NotImplementedError:  # Windows event loops have no signal handlers
        pass

    callback_task: asyncio.Task | None = None
    calls_started = False
    try:
        async with asyncio.timeout(CALL_SETUP_TIMEOUT_S):
            await calls.start()
        calls_started = True
        secure_session_files(WORKDIR)
        await app.get_me()  # verify the stored session without logging account identifiers
        print("[call] Telegram session connected", flush=True)

        callback_task = asyncio.create_task(callback_poll())

        if allow_any_caller:
            print(
                "[security] WARNING: incoming Telegram calls are open to every caller "
                "(CICERO_TG_ALLOW_ANY_CALLER=I_UNDERSTAND)",
                flush=True,
            )
        if INSECURE_TLS:
            print(
                "[security] WARNING: Cicero daemon certificate verification is disabled "
                "(CICERO_WEB_INSECURE_TLS=I_UNDERSTAND)",
                flush=True,
            )
        if ALLOW_PLAINTEXT:
            print(
                "[security] WARNING: non-loopback plaintext daemon transport is allowed "
                "(CICERO_WEB_ALLOW_PLAINTEXT=I_UNDERSTAND)",
                flush=True,
            )
        if LOG_CONTENT:
            print(
                "[security] WARNING: call transcripts and replies will be written to logs "
                "(CICERO_CALL_LOG_CONTENT=I_UNDERSTAND)",
                flush=True,
            )

        if target:
            async with asyncio.timeout(CALL_SETUP_TIMEOUT_S):
                await app.resolve_peer(target)  # validates the target exists
                chat = await app.get_users(target) if str(target).lstrip("-").isdigit() is False else None
            chat_id = chat.id if chat else int(target)
            print("[call] placing configured outgoing call…", flush=True)
            await answer(chat_id)
        else:
            print("[call] listening for incoming calls…", flush=True)

        await asyncio.Event().wait()  # run until killed
    finally:
        if sigterm_installed:
            loop.remove_signal_handler(signal.SIGTERM)
        if callback_task is not None:
            callback_task.cancel()
            await asyncio.gather(callback_task, return_exceptions=True)
        active_chat_id = bridge.chat_id if bridge is not None else None
        if bridge is not None:
            await bridge.close()
            bridge = None
        if calls_started and active_chat_id is not None:
            await leave_telegram_call(active_chat_id)
        if getattr(app, "is_connected", False):
            try:
                async with asyncio.timeout(10):
                    await app.stop()
            except Exception as exc:
                print(
                    f"[call] session shutdown warning: {redact_secrets(exc, TOKEN, API_HASH)}",
                    flush=True,
                )
        secure_session_files(WORKDIR)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--call", help="user id or @username to ring")
    ap.add_argument("--listen", action="store_true", help="wait for incoming calls")
    args = ap.parse_args()
    if not args.call and not args.listen:
        ap.error("pass --call <user> or --listen")
    try:
        allowed = parse_allowed_callers(os.environ.get("CICERO_TG_ALLOWED"))
        allow_any_caller = parse_allow_any_caller(os.environ.get("CICERO_TG_ALLOW_ANY_CALLER"))
        validate_listener_access(args.listen, allowed, allow_any_caller)
    except ValueError as exc:
        ap.error(str(exc))
    try:
        asyncio.run(
            run(
                args.call,
                listen=args.listen,
                allowed=allowed,
                allow_any_caller=allow_any_caller,
            )
        )
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass  # Ctrl-C or the SIGTERM handler's cancel — cleanup already ran
    except (OSError, PermissionError, ValueError) as exc:
        sys.exit(f"Telegram call sidecar refused to start: {redact_secrets(exc, TOKEN, API_HASH)}")
