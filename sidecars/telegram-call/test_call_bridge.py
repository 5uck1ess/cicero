"""Bridge playback lifecycle — the call must be connected before audio flows.

The incident these tests pin down: the daemon flushes parked notify clips the
moment the bridge's WebSocket connects, which happens before the outgoing
Telegram call is answered. The player then hit send_frame on a call that was
still ringing ("The userbot is not in a call"), and the resulting exception
killed the play loop permanently — the answered call was silent end to end.

call_agent imports heavyweight call/runtime deps (pyrogram, pytgcalls, numpy);
CI runs these tests with a bare interpreter, so the deps are stubbed the same
way tests/python/test_sidecar_contracts.py stubs model modules.
"""
import asyncio
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path


def _module(name: str, **attrs: object) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


class FakeClip:
    """Minimal ndarray stand-in for the play loop: size, slicing, tobytes."""

    def __init__(self, payload: bytes) -> None:
        self._payload = bytes(payload)

    @property
    def size(self) -> int:
        return len(self._payload)

    def __getitem__(self, item: slice) -> "FakeClip":
        return FakeClip(self._payload[item])

    def tobytes(self) -> bytes:
        return self._payload


_STUBS = {
    "numpy": _module(
        "numpy",
        ndarray=FakeClip,
        int16="int16",
        float32="float32",
        frombuffer=lambda *_a, **_k: FakeClip(b""),
        sqrt=lambda value: value,
        mean=lambda *_a, **_k: 0.0,
        concatenate=lambda parts: parts[0] if parts else FakeClip(b""),
    ),
    "pyrogram": _module("pyrogram", Client=type("Client", (), {})),
    "pytgcalls": _module(
        "pytgcalls",
        PyTgCalls=type("PyTgCalls", (), {}),
        filters=_module("pytgcalls.filters"),
    ),
    "pytgcalls.types": _module(
        "pytgcalls.types",
        **{
            name: type(name, (), {})
            for name in (
                "CallConfig", "ChatUpdate", "ExternalMedia", "MediaStream",
                "RecordStream", "StreamFrames",
            )
        },
        Frame=type("Frame", (), {"Info": type("Info", (), {"__init__": lambda self, capture_time=0: None})}),
        Device=type("Device", (), {"MICROPHONE": "microphone", "SPEAKER": "speaker"}),
        Direction=type("Direction", (), {"INCOMING": "incoming", "OUTGOING": "outgoing"}),
    ),
    "pytgcalls.types.raw": _module(
        "pytgcalls.types.raw", AudioParameters=type("AudioParameters", (), {})
    ),
}
for _name, _mod in _STUBS.items():
    sys.modules.setdefault(_name, _mod)

import call_agent  # noqa: E402


class FakeCalls:
    """send_frame that behaves like py-tgcalls: raises unless the call is live."""

    def __init__(self) -> None:
        self.connected = False
        self.sent: list[bytes] = []
        self.failures = 0

    async def send_frame(self, _chat_id, _device, payload: bytes, _info) -> None:
        if not self.connected:
            self.failures += 1
            raise RuntimeError("The userbot is not in a call")
        self.sent.append(payload)


class FakeDaemonSocket:
    """Daemon WS stand-in: async-iterates messages, blocks when idle."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()
        self.closed = False

    def __aiter__(self) -> "FakeDaemonSocket":
        return self

    async def __anext__(self):
        return await self._queue.get()

    async def close(self) -> None:
        self.closed = True


async def _fake_daemon_socket() -> FakeDaemonSocket:
    return FakeDaemonSocket()


def make_bridge(calls: FakeCalls) -> "call_agent.Bridge":
    return call_agent.Bridge(app=None, calls=calls, chat_id=7)


def clip(payload: bytes) -> FakeClip:
    return FakeClip(payload)


async def eventually(check, timeout: float = 2.0, message: str = "condition not met") -> None:
    """Condition-based wait: no scheduler-dependent fixed sleeps for positives."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(message)


async def settle(seconds: float = 0.05) -> None:
    """Bounded grace period — only for asserting that something did NOT happen."""
    await asyncio.sleep(seconds)


class BridgePlaybackLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_connect_does_not_start_player(self) -> None:
        """The ordering boundary itself: connect() (daemon socket + reader) must
        leave the player unstarted — a regression that re-adds player startup
        to connect() replays the silent-ring incident."""
        calls = FakeCalls()
        bridge = make_bridge(calls)
        original = call_agent.connect_daemon_socket
        call_agent.connect_daemon_socket = _fake_daemon_socket
        try:
            await bridge.connect()
            self.assertIsNone(
                bridge.player,
                "connect() must not start the player — the call is not dialed yet",
            )
            # The daemon's parked flush lands now, while the call is ringing.
            await bridge.playq.put(clip(b"x" * bridge.FRAME_SAMPLES))
            await settle()
            self.assertEqual(calls.failures, 0, "audio was pushed into a ringing call")
            self.assertEqual(calls.sent, [])

            # answer_locked() reaches start_player only after calls.play() —
            # i.e. only once the callee accepted and WebRTC is connected.
            calls.connected = True
            bridge.start_player()
            await eventually(lambda: len(calls.sent) == 1,
                             message="queued clip must play once connected")
        finally:
            call_agent.connect_daemon_socket = original
            await bridge.close()

    async def test_start_player_is_idempotent(self) -> None:
        calls = FakeCalls()
        calls.connected = True
        bridge = make_bridge(calls)
        try:
            bridge.start_player()
            first = bridge.player
            bridge.start_player()
            self.assertIs(bridge.player, first, "start_player must not spawn a second loop")
        finally:
            await bridge.close()

    async def test_send_failure_drops_clip_but_player_survives(self) -> None:
        """One failed clip must not silence the rest of the call."""
        calls = FakeCalls()
        calls.connected = True
        bridge = make_bridge(calls)
        try:
            bridge.start_player()
            calls.connected = False  # transient: e.g. a brief transport wobble
            await bridge.playq.put(clip(b"a" * bridge.FRAME_SAMPLES))
            await eventually(lambda: calls.failures >= 1)
            self.assertFalse(
                bridge.player.done(),
                "a single send failure must not kill the play loop",
            )

            calls.connected = True
            await bridge.playq.put(clip(b"b" * bridge.FRAME_SAMPLES))
            await eventually(
                lambda: calls.sent == [b"b" * bridge.FRAME_SAMPLES],
                message="later clips must still play after an earlier clip failed",
            )
        finally:
            await bridge.close()

    async def test_player_latches_muted_after_consecutive_failures(self) -> None:
        """A dead call must not be hammered until shutdown: after the failure
        limit the player drains quietly instead of retrying send_frame."""
        calls = FakeCalls()
        calls.connected = True
        bridge = make_bridge(calls)
        bridge.PLAYER_PROBE_INTERVAL_S = 60.0  # no probe fires inside this test
        try:
            bridge.start_player()
            limit = bridge.PLAYER_FAILURE_LIMIT
            calls.connected = False  # the callee hung up; no call-end handler runs
            for i in range(limit):
                await bridge.playq.put(clip(bytes([i]) * bridge.FRAME_SAMPLES))
            await eventually(lambda: calls.failures == limit)

            for _ in range(2):  # the daemon keeps streaming sentences
                await bridge.playq.put(clip(b"z" * bridge.FRAME_SAMPLES))
            await eventually(lambda: bridge.playq.empty(),
                             message="latched player must still drain the queue")
            await settle()
            self.assertEqual(
                calls.failures, limit,
                "latched player must stop hitting send_frame on a dead call",
            )
            self.assertFalse(bridge.player.done(), "latched player stays cancellable")
        finally:
            await bridge.close()

    async def test_latched_player_probes_and_recovers(self) -> None:
        """The mute latch is retryable: a call that survived a transient wobble
        gets its voice back after a successful probe, without a redial."""
        calls = FakeCalls()
        calls.connected = True
        bridge = make_bridge(calls)
        bridge.PLAYER_PROBE_INTERVAL_S = 0.02
        try:
            bridge.start_player()
            limit = bridge.PLAYER_FAILURE_LIMIT
            calls.connected = False  # transient transport wobble
            for i in range(limit):
                await bridge.playq.put(clip(bytes([i]) * bridge.FRAME_SAMPLES))
            await eventually(lambda: calls.failures == limit)

            calls.connected = True  # WebRTC recovered
            await asyncio.sleep(0.03)  # let the probe window open
            await bridge.playq.put(clip(b"r" * bridge.FRAME_SAMPLES))
            await eventually(
                lambda: b"r" * bridge.FRAME_SAMPLES in calls.sent,
                message="a successful probe must unmute the player",
            )
            # Fully unlatched: the next clip plays immediately, no probe wait.
            await bridge.playq.put(clip(b"s" * bridge.FRAME_SAMPLES))
            await eventually(lambda: b"s" * bridge.FRAME_SAMPLES in calls.sent)
        finally:
            await bridge.close()

    async def test_probe_flushed_before_first_frame_does_not_unlatch(self) -> None:
        """A barge-in can flush a probe clip before any frame is sent; that
        proves nothing about call health and must not reset the mute latch.
        An empty clip exercises the same no-frames-sent path deterministically."""
        calls = FakeCalls()
        calls.connected = True
        bridge = make_bridge(calls)
        bridge.PLAYER_PROBE_INTERVAL_S = 0.01
        try:
            bridge.start_player()
            limit = bridge.PLAYER_FAILURE_LIMIT
            calls.connected = False  # the call is dead and stays dead
            for i in range(limit):
                await bridge.playq.put(clip(bytes([i]) * bridge.FRAME_SAMPLES))
            await eventually(lambda: calls.failures == limit)

            await asyncio.sleep(0.02)  # probe window opens
            await bridge.playq.put(clip(b""))  # zero frames sent — like a flushed probe
            await eventually(lambda: bridge.playq.empty())
            await asyncio.sleep(0.02)  # next probe window
            # Still latched: the next two clips must cost exactly ONE probe
            # attempt (timer re-arms on its failure), not two eager attempts
            # from a falsely-unlatched player.
            await bridge.playq.put(clip(b"p" * bridge.FRAME_SAMPLES))
            await bridge.playq.put(clip(b"q" * bridge.FRAME_SAMPLES))
            await eventually(lambda: bridge.playq.empty())
            await settle()
            self.assertEqual(
                calls.failures, limit + 1,
                "an empty probe must leave the latch armed (one probe, not eager retries)",
            )
        finally:
            await bridge.close()

    async def test_close_unblocks_reader_stuck_on_full_queue(self) -> None:
        """While ringing (player not started) the daemon can flush more clips
        than playq holds; the reader blocks in put(). close() must cancel it
        promptly, not deadlock replacement-call bookkeeping."""
        calls = FakeCalls()
        bridge = make_bridge(calls)

        async def flood() -> None:
            for i in range(bridge.playq.maxsize + 2):
                await bridge.playq.put(clip(bytes([i]) * bridge.FRAME_SAMPLES))

        bridge.reader = asyncio.create_task(flood())
        reader = bridge.reader
        await eventually(lambda: bridge.playq.full(), message="queue never filled")
        await asyncio.wait_for(bridge.close(), timeout=5)
        self.assertTrue(reader.done(), "close() must cancel a reader blocked on put()")


class ZombieBridgeReleaseTest(unittest.IsolatedAsyncioTestCase):
    """The 2026-07-13 incident: a call ended (daemon restart mid-call, callee
    hung up) but nothing released the bridge — its daemon-socket reconnector
    even restored ws — so callback_poll read "already on a call" forever and
    silently swallowed every later "call me". These pin the decision logic."""

    async def test_hung_up_bridge_with_reconnected_socket_counts_as_busy(self) -> None:
        # The raw predicate is truthful only if a discard actually releases
        # the bridge — this is the exact zombie state from the incident.
        bridge = make_bridge(FakeCalls())
        bridge.ws = FakeDaemonSocket()  # reconnector restored the socket
        self.assertTrue(call_agent.bridge_is_busy(bridge))
        # ...and the discard handler is what must break the deadlock:
        self.assertTrue(call_agent.discard_releases_bridge(bridge, chat_id=7, answer_in_flight=False))
        await bridge.close()
        self.assertFalse(call_agent.bridge_is_busy(bridge))

    async def test_no_bridge_or_closed_bridge_is_not_busy(self) -> None:
        self.assertFalse(call_agent.bridge_is_busy(None))
        bridge = make_bridge(FakeCalls())
        self.assertFalse(call_agent.bridge_is_busy(bridge), "no daemon socket yet — not delivering")
        bridge.ws = FakeDaemonSocket()
        await bridge.close()
        self.assertFalse(call_agent.bridge_is_busy(bridge))

    async def test_discard_ignored_while_replacement_answer_in_flight(self) -> None:
        # answer() discards the previous call on purpose; that echo must not
        # tear down the candidate it is busy setting up for the same chat.
        bridge = make_bridge(FakeCalls())
        bridge.ws = FakeDaemonSocket()
        self.assertFalse(call_agent.discard_releases_bridge(bridge, chat_id=7, answer_in_flight=True))

    async def test_frames_refresh_liveness_and_silence_marks_stale(self) -> None:
        # The callback poller's self-heal: a "busy" bridge that has delivered
        # no caller audio for STALE_CALL_S is a corpse and may be released.
        bridge = make_bridge(FakeCalls())
        self.assertFalse(bridge.stale(time.monotonic()), "fresh bridge must not read as stale")
        bridge.last_frame_at = time.monotonic() - bridge.STALE_CALL_S - 1
        self.assertTrue(bridge.stale(time.monotonic()))
        await bridge.on_audio(clip(b""))  # any frame proves the call is alive
        self.assertFalse(bridge.stale(time.monotonic()))

    async def test_start_player_resets_liveness_clock(self) -> None:
        # The ring can outlast STALE_CALL_S; a just-connected call must not
        # read as stale before its first frames arrive.
        bridge = make_bridge(FakeCalls())
        bridge.last_frame_at = time.monotonic() - bridge.STALE_CALL_S - 1
        bridge.start_player()
        try:
            self.assertFalse(bridge.stale(time.monotonic()))
        finally:
            await bridge.close()

    async def test_discard_for_other_chat_or_dead_bridge_is_ignored(self) -> None:
        self.assertFalse(call_agent.discard_releases_bridge(None, chat_id=7, answer_in_flight=False))
        bridge = make_bridge(FakeCalls())
        self.assertFalse(call_agent.discard_releases_bridge(bridge, chat_id=8, answer_in_flight=False))
        await bridge.close()
        self.assertFalse(call_agent.discard_releases_bridge(bridge, chat_id=7, answer_in_flight=False))


class ListenerHeartbeatTest(unittest.TestCase):
    """The daemon reads listener.alive's mtime to decide whether to promise a
    ring; the poll loop must keep the file fresh, and a heartbeat failure must
    never break that loop."""

    def test_write_creates_and_refreshes_the_heartbeat(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            hb = Path(d) / "listener.alive"
            self.assertFalse(hb.exists())
            call_agent.write_listener_heartbeat(hb)
            self.assertTrue(hb.exists())
            backdated = hb.stat().st_mtime_ns - 5_000_000_000  # 5s in the past
            os.utime(hb, ns=(backdated, backdated))
            call_agent.write_listener_heartbeat(hb)
            self.assertGreater(hb.stat().st_mtime_ns, backdated)

    def test_write_creates_the_workdir_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            hb = Path(d) / "telegram-call" / "listener.alive"
            call_agent.write_listener_heartbeat(hb)
            self.assertTrue(hb.exists())

    def test_write_never_raises_when_the_path_is_unwritable(self) -> None:
        # A directory planted at the path makes touch() fail; the ring loop
        # must swallow it, not die.
        with tempfile.TemporaryDirectory() as d:
            planted = Path(d) / "listener.alive"
            planted.mkdir()
            call_agent.write_listener_heartbeat(planted)  # must not raise


if __name__ == "__main__":
    unittest.main()
