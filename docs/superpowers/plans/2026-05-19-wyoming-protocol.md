# Wyoming Protocol Support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Wyoming protocol support to Cicero's backend layer so STT / TTS / wake-word components can interoperate with the [Home Assistant voice ecosystem](https://www.home-assistant.io/voice_control/). Wyoming is a JSON-over-TCP/stdin wire format for voice pipeline components — adopting it gives Cicero:

1. **Interop with existing Wyoming servers** (`wyoming-faster-whisper`, `wyoming-piper`, `wyoming-openwakeword`, etc.) — drop-in backends without writing custom Python server wrappers.
2. **ESP32 hardware reuse** — Willow-firmware mics and other Wyoming-compatible IoT devices become valid Cicero clients once multi-device support lands.
3. **Cicero as a Wyoming service** — Home Assistant can route voice through Cicero as a backend, opening the bidirectional integration path.

**Architecture:** Add a Wyoming TCP client to `src/backends/` (Bun's TCP socket support handles the wire protocol natively, no new deps). Implement `WyomingSTTProvider`, `WyomingTTSProvider`, `WyomingWakeWordProvider` as alternative implementations of the existing provider interfaces. They register in `src/backends/registry.ts` alongside the bespoke HTTP providers (`mlx-whisper`, `faster-whisper`, `kokoro`, etc.) — config-driven, no architectural change. Optional: expose a Wyoming server endpoint (Cicero-as-service for HA) as a follow-up task.

**Non-goals:**
- Not replacing existing providers. Wyoming is an *alternative* backend, not a forced migration. Defaults stay on current bespoke providers.
- Not implementing Home Assistant smart-home control here — that's Plan 4 (MCP).
- Not multi-device daemon work — Wyoming is a *backend* protocol, not a client-server transport.
- Not ESP32 firmware. Willow + other existing Wyoming-compatible firmware already exists; we just need to be compatible.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `Bun.connect` for TCP. No new deps.

**Reference:**
- [Wyoming protocol spec](https://github.com/rhasspy/wyoming) — JSON header + optional binary payload over newline-delimited TCP.
- Existing servers: [`wyoming-faster-whisper`](https://github.com/rhasspy/wyoming-faster-whisper), [`wyoming-piper`](https://github.com/rhasspy/wyoming-piper), [`wyoming-openwakeword`](https://github.com/rhasspy/wyoming-openwakeword).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/backends/wyoming/client.ts` | NEW | TCP client + protocol framing (event-based: `describe`, `info`, `audio-start`, `audio-chunk`, `audio-stop`, `transcript`, `synthesize`, `detect`, `detection`) |
| `src/backends/wyoming/types.ts` | NEW | Event/payload type definitions matching the spec |
| `src/backends/stt/wyoming.ts` | NEW | `WyomingSTTProvider` implementing `STTProvider` |
| `src/backends/tts/wyoming.ts` | NEW | `WyomingTTSProvider` implementing `TTSProvider` |
| `src/backends/wake-word/wyoming.ts` | NEW | `WyomingWakeWordProvider` (creates the wake-word backend slot if it doesn't yet exist) |
| `src/backends/registry.ts` | MODIFY | Add `case "wyoming-faster-whisper"`, `case "wyoming-piper"`, `case "wyoming-openwakeword"` (or a generic `case "wyoming"` with the underlying server in config) |
| `src/types.ts` | MODIFY | Extend STT/TTS/WakeWord backend unions with `"wyoming-*"` values |
| `src/config.ts` | MODIFY | Document Wyoming backend config in `DEFAULT_CONFIG` comments; add server-spec entries |
| `tests/wyoming-client.test.ts` | NEW | Protocol-level test against a mock TCP server |
| `tests/backends-wyoming-stt.test.ts` | NEW | STT provider integration test (mocked client) |
| `tests/backends-wyoming-tts.test.ts` | NEW | TTS provider integration test (mocked client) |
| `tests/backends-wyoming-wakeword.test.ts` | NEW | Wake-word provider test (mocked client) |
| `docs/superpowers/wyoming-integration.md` | NEW | Short user-facing doc: how to point Cicero at a Home Assistant Wyoming server, and what's compatible |

**Optional follow-up task (gated on user interest):**
- `src/servers/wyoming-server.ts` — expose Cicero's pipeline as a Wyoming service so Home Assistant can route voice through Cicero. Stretch goal; not required for the primary "use Wyoming backends" use case.

---

## Task 1: Wyoming protocol client

**Files:**
- Create: `src/backends/wyoming/client.ts`
- Create: `src/backends/wyoming/types.ts`

Wyoming wire format: each message is a JSON header (single line, newline-terminated) optionally followed by binary payload bytes. The header declares `type`, `data` (event-specific), and optional `payload_length`. Audio events carry PCM bytes as the payload.

- [ ] **Step 1: Write the failing test**

Create `tests/wyoming-client.test.ts`. Spin up a minimal mock TCP server using `Bun.listen`; assert the client sends a well-formed `describe` event on connect and parses an `info` response correctly.

```ts
import { test, expect } from "bun:test";
import { WyomingClient } from "../src/backends/wyoming/client";

test("client connects, sends describe, receives info", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const line = data.toString().trim();
        const msg = JSON.parse(line);
        if (msg.type === "describe") {
          socket.write(JSON.stringify({ type: "info", data: { models: [{ name: "test" }] } }) + "\n");
        }
      },
    },
  });

  const client = new WyomingClient({ host: "127.0.0.1", port: server.port });
  const info = await client.describe();
  expect(info.data.models[0].name).toBe("test");
  client.close();
  server.stop();
});
```

- [ ] **Step 2: Run test — expect FAIL** (file doesn't exist yet)

- [ ] **Step 3: Implement the client**

In `src/backends/wyoming/client.ts`, build the TCP wrapper. Pseudocode:

```ts
import type { WyomingEvent, WyomingHeader } from "./types";

export interface WyomingClientOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export class WyomingClient {
  private socket: ReturnType<typeof Bun.connect> | null = null;
  private readBuffer: Uint8Array = new Uint8Array(0);
  private waiters: Array<(event: WyomingEvent) => void> = [];

  constructor(private opts: WyomingClientOptions) {}

  async connect(): Promise<void> {
    this.socket = await Bun.connect({
      hostname: this.opts.host,
      port: this.opts.port,
      socket: {
        data: (_sock, data) => this.onData(data),
        close: () => { this.socket = null; },
      },
    });
  }

  private onData(chunk: Uint8Array) {
    // Concat into readBuffer, split on \n for header line, then read payload_length bytes if present.
    // Emit parsed WyomingEvent to whichever waiter is next.
  }

  async send(event: WyomingEvent, payload?: Uint8Array): Promise<void> {
    if (!this.socket) await this.connect();
    const header = JSON.stringify({ ...event, payload_length: payload?.byteLength ?? null }) + "\n";
    this.socket!.write(header);
    if (payload) this.socket!.write(payload);
  }

  async receive(): Promise<WyomingEvent> {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async describe(): Promise<WyomingEvent> {
    await this.send({ type: "describe", data: {} });
    return this.receive();
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}
```

The actual `onData` logic is the only tricky part — splitting headers from binary payloads in a streaming TCP buffer. Reference the Python `wyoming` library's `AsyncEventHandler.read_event` for the exact framing logic.

- [ ] **Step 4: Add `WyomingEvent` and `WyomingHeader` types in `wyoming/types.ts`** matching the protocol spec: `describe`, `info`, `audio-start`, `audio-chunk`, `audio-stop`, `transcript`, `synthesize`, `audio`, `detect`, `detection`, `not-detected`.

- [ ] **Step 5: Re-run test — expect PASS**

---

## Task 2: Wyoming STT provider

**Files:**
- Create: `src/backends/stt/wyoming.ts`

`WyomingSTTProvider.transcribe(audioFile)` opens a connection, sends `audio-start` + `audio-chunk(s)` with the WAV PCM payload + `audio-stop`, waits for a `transcript` event, returns the text.

- [ ] **Step 1: Write the failing test**

Create `tests/backends-wyoming-stt.test.ts`. Mock the `WyomingClient` to feed a canned `transcript` event; assert `transcribe()` returns the cleaned text.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the provider**

Mirror `MlxWhisperProvider`'s shape. Read the WAV file as bytes, strip the WAV header (or send the whole file — many Wyoming servers accept either; check `wyoming-faster-whisper` expectations), send as `audio-chunk` events of ~16KB each, then `audio-stop`. Await `transcript`.

- [ ] **Step 4: Run — expect PASS**

---

## Task 3: Wyoming TTS provider

**Files:**
- Create: `src/backends/tts/wyoming.ts`

`WyomingTTSProvider.synthesize(text)` sends `synthesize { text, voice }`, receives `audio-start` + N × `audio-chunk` + `audio-stop`, assembles bytes into a WAV buffer the speaker can play.

- [ ] **Step 1: Write the failing test**

- [ ] **Step 2: Implement the provider**

Mirror `KokoroProvider`'s shape. The output buffer is raw PCM — wrap it in a WAV header before handing off to the speaker (or extend the speaker interface to accept raw PCM + sample rate, if cleaner). Match whatever existing TTS providers return.

- [ ] **Step 3: Run — expect PASS**

---

## Task 4: Wyoming wake-word provider

**Files:**
- Create: `src/backends/wake-word/wyoming.ts`
- Modify: `src/types.ts` (add `WakeWordProvider` interface if it doesn't exist yet — coordinate with [Plan 2](2026-05-14-listener-upgrades.md) which adds wake-word handling)

This is the most loosely-defined slot because Cicero's current listener uses transcript-scan, not a continuous wake-word detector. Plan 2 introduces the wake-word abstraction; this task adds a Wyoming-backed implementation of it.

- [ ] **Step 1: Coordinate with Plan 2**

If Plan 2 hasn't landed yet, defer this task and ship Tasks 1-3 first. The Wyoming protocol pieces (client, STT, TTS) are valuable independently.

- [ ] **Step 2: If Plan 2 has landed** — implement `WyomingWakeWordProvider` that streams mic audio to a Wyoming wake-word server (`wyoming-openwakeword`) and emits a callback on `detection` events.

---

## Task 5: Registry + config wiring

**Files:**
- Modify: `src/backends/registry.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write the failing registry test**

Create `tests/registry-wyoming.test.ts`:

```ts
test("registry returns WyomingSTTProvider when backend is 'wyoming'", () => {
  const provider = createSTTProvider({
    sttBackend: { backend: "wyoming", host: "127.0.0.1", port: 10300 },
  } as any);
  expect(provider.name).toBe("wyoming");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update registry**

Add `case "wyoming":` branches to `createSTTProvider`, `createTTSProvider`, and (if Plan 2 in progress) `createWakeWordProvider`. Each constructs the provider with `{ host, port }` from config.

- [ ] **Step 4: Update type unions**

In `src/types.ts`, add `"wyoming"` to the STT/TTS/wake-word backend unions.

- [ ] **Step 5: Document config in `src/config.ts`**

Add commented example:

```yaml
# Use a Home Assistant Wyoming server as STT:
stt:
  backend: wyoming
  host: 192.168.1.10        # HA host
  port: 10300               # default wyoming-faster-whisper port

tts:
  backend: wyoming
  host: 192.168.1.10
  port: 10200               # default wyoming-piper port
```

- [ ] **Step 6: Run — expect PASS** + full `bun test` green

---

## Task 6: Documentation

**Files:**
- Create: `docs/superpowers/wyoming-integration.md`

Short user-facing doc (~200-300 words):

- What Wyoming is (one paragraph)
- Why a Cicero user would care (HA interop, ESP32 device reuse, swap STT/TTS without writing a Python wrapper)
- How to point Cicero at an HA Wyoming server (config example)
- Currently-compatible servers (`wyoming-faster-whisper`, `wyoming-piper`, `wyoming-openwakeword`, others as we test them)
- What this is NOT (not smart-home control — that's Plan 4 MCP; not multi-device transport — that's a future plan)

Link from the README's "Roadmap" section once this plan lands.

---

## Task 7 (optional follow-up): Cicero as Wyoming server

**Files:**
- Create: `src/servers/wyoming-server.ts`
- Create: `tests/wyoming-server.test.ts`

Expose Cicero's pipeline as a Wyoming TCP service so Home Assistant can use Cicero as a voice backend in HA's voice pipeline. Inverse of Tasks 2-3 — Cicero accepts `audio-chunk`s from HA, runs them through its STT, dispatches to brain, runs the response through TTS, returns `audio-chunk`s.

**Gate this task on a user decision.** It's substantial (~1 day on its own) and only valuable if you want HA users to invoke Cicero from inside HA. Skip for v1 if the use case is "Cicero uses HA's voice components," not "HA uses Cicero."

---

## Acceptance checklist

- [ ] `WyomingClient` connects, frames events correctly, handles binary payloads
- [ ] `WyomingSTTProvider` transcribes a WAV file through a real `wyoming-faster-whisper` server (manual smoke test)
- [ ] `WyomingTTSProvider` synthesizes audio through a real `wyoming-piper` server (manual smoke test)
- [ ] Registry returns Wyoming providers when configured
- [ ] All Wyoming-related unit tests pass; full `bun test` suite stays green
- [ ] `docs/superpowers/wyoming-integration.md` documents the integration
- [ ] No regression in existing providers — Wyoming is purely additive
