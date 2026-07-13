# Conversational Latency & Realism Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring three conversational-realism techniques (proven out in a competing local-voice build) to Cicero's coding-agent path: end-to-end streaming TTS for **brain** responses, pre-warmed TTS to kill first-utterance latency, and barge-in **recovery** so the assistant remembers what it was saying and resumes after an interjection.

**Architecture:** Cicero already has the load-bearing infrastructure — `StreamingTTSSpeaker.speakStream(AsyncIterable<string>)` (pipelined generate-one-ahead + killable playback) and a working SSE→sentence-chunk pipeline for the `local-llm` category (`ActionExecutor.executeLocalLLMStreaming`). The gaps are: (1) the **brain** path (Claude Code / Codex — the actual product) still buffers the full response then batch-speaks; (2) the TTS model is cold until the first real turn; (3) barge-in interrupts but discards what was being said. This plan closes those three gaps by adding `Brain.sendStream()`, a shared sentence segmenter, an optional `warmup()`, and a snapshot+recovery-context mechanism on top of the existing barge-in wiring. No new architectural layers.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `Bun.spawn`, `fetch` (SSE), `bun:test`. No new dependencies.

**Relationship to other plans:** Part C (interruption-with-recovery) composes with **Plan 2 — Listener upgrades** Task 4 (`isStopCommand`, in `docs/superpowers/plans/2026-05-14-listener-upgrades.md`), which distinguishes a verbal "stop" (interrupt only) from a genuine interjection (interrupt + re-dispatch). Plan 2 Task 4 is **not yet executed**. This plan works without it — every barge-in that yields a transcript is treated as an interjection and gets recovery context — but lands cleaner once Task 4 ships, because then a bare "stop" won't trigger a spurious recovery turn. Do Plan 2 Task 4 first if convenient; otherwise note the limitation in the Part C verification step.

---

## What already exists (do NOT rebuild)

Read these before starting — the plan extends them, it does not replace them:

- `src/speaker/streaming-tts.ts` — `StreamingTTSSpeaker extends TTSSpeaker`. Has `speakStream(sentences: AsyncIterable<string>)`, `interrupt()`, `isPlaying()`. Generates the next sentence's audio while the current one plays; `playAudioInterruptible()` keeps a killable `Bun.spawn` handle for barge-in.
- `src/executor/index.ts:273-371` — `executeLocalLLMStreaming()`: an `async *` generator that hits the local llama-server with `stream: true`, strips `<think>` blocks, splits on sentence boundaries (`/^(.*?[.!?])\s+(.*)/s`), and yields sentences. This is the reference pattern for streaming and the source of the segmentation logic Part A extracts.
- `src/daemon.ts:172-184` — Step 6 already wires `local-llm` category → `executeLocalLLMStreaming` → `streamingSpeaker.speakStream`. Part A adds the symmetric branch for the `brain` category.
- `src/daemon.ts:99` — `this.conversational.onBargeIn(() => this.streamingSpeaker?.interrupt())`. Part C expands this callback to snapshot before interrupting.
- `src/backends/tts/provider.ts:12-18` — `TTSProvider` interface (`name`, `generateAudio(text): Promise<ArrayBuffer>`, `health()`, optional `start?()`/`stop?()`). Part B adds optional `warmup?()`.
- `src/types.ts:119-129` — `Brain` interface. Part A adds optional `sendStream?()`.

Test conventions: tests live in `tests/`, named `*.test.ts`, run with `bun test <path>`. Use `import { test, expect, describe } from "bun:test"`. Integration tests that need an external binary (e.g. `claude`) must skip when it is absent — mirror the KittyAdapter pattern.

---

# Part A — Stream brain responses end-to-end

Today a brain reply is fully buffered (`ClaudeCodeBrain.send` does `await new Response(proc.stdout).text()`) then summarized and batch-spoken. Goal: pipe brain output token-by-token through a sentence segmenter into `StreamingTTSSpeaker`, so the first sentence is spoken while the rest is still being produced.

## Task A1: Shared sentence-stream segmenter

**Files:**
- Create: `src/speaker/sentence-stream.ts`
- Test: `tests/sentence-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sentence-stream.test.ts
import { test, expect } from "bun:test";
import { segmentSentences } from "../src/speaker/sentence-stream";

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}
async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of gen) out.push(s);
  return out;
}

test("yields sentences as boundaries arrive across token chunks", async () => {
  const out = await collect(segmentSentences(fromArray(["Hello ", "there. How ", "are you?"])));
  expect(out).toEqual(["Hello there.", "How are you?"]);
});

test("splits multiple sentences contained in one chunk", async () => {
  const out = await collect(segmentSentences(fromArray(["One. Two. Three!"])));
  expect(out).toEqual(["One.", "Two.", "Three!"]);
});

test("flushes trailing text with no terminal punctuation", async () => {
  const out = await collect(segmentSentences(fromArray(["No period here"])));
  expect(out).toEqual(["No period here"]);
});

test("ignores an empty token stream", async () => {
  const out = await collect(segmentSentences(fromArray([])));
  expect(out).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sentence-stream.test.ts`
Expected: FAIL — `Cannot find module "../src/speaker/sentence-stream"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/speaker/sentence-stream.ts

/**
 * Consume a stream of text tokens and yield complete sentences as soon as a
 * boundary appears, flushing any trailing partial sentence when the stream ends.
 *
 * Boundary: `.`, `!`, or `?` followed by whitespace. This mirrors the splitter
 * inlined in ActionExecutor.executeLocalLLMStreaming so the local-llm path and
 * the brain path can converge on one implementation (see optional Task D1).
 *
 * Input tokens must already be free of provider control markup (e.g. <think>
 * blocks) — stripping that is the producer's responsibility.
 */
export async function* segmentSentences(
  tokens: AsyncIterable<string>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const token of tokens) {
    buffer += token;
    let match = buffer.match(/^(.*?[.!?])\s+(.*)/s);
    while (match) {
      const sentence = match[1].trim();
      buffer = match[2];
      if (sentence) yield sentence;
      match = buffer.match(/^(.*?[.!?])\s+(.*)/s);
    }
  }
  const remaining = buffer.trim();
  if (remaining) yield remaining;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sentence-stream.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/speaker/sentence-stream.ts tests/sentence-stream.test.ts
git commit -m "feat(speaker): add shared sentence-stream segmenter"
```

## Task A2: `Brain.sendStream()` + ClaudeCodeBrain streaming

**Files:**
- Create: `src/brain/stream-utils.ts`
- Test: `tests/brain-stream-utils.test.ts`
- Modify: `src/types.ts` (Brain interface, lines 119-129)
- Modify: `src/brain/claude-code.ts`
- Test: `tests/brain-claude-code-stream.test.ts`

- [ ] **Step 1: Write the failing test for the stream reader**

```ts
// tests/brain-stream-utils.test.ts
import { test, expect } from "bun:test";
import { iterateTextStream } from "../src/brain/stream-utils";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function collect(gen: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const s of gen) out += s;
  return out;
}

test("decodes a chunked byte stream into text pieces", async () => {
  const out = await collect(iterateTextStream(streamFrom(["Hel", "lo, ", "world"])));
  expect(out).toBe("Hello, world");
});

test("handles a multi-byte character split across chunks", async () => {
  const enc = new TextEncoder();
  const bytes = enc.encode("café"); // é is 2 bytes
  const a = bytes.slice(0, bytes.length - 1);
  const b = bytes.slice(bytes.length - 1);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(a); c.enqueue(b); c.close(); },
  });
  expect(await collect(iterateTextStream(stream))).toBe("café");
});

test("yields nothing for an empty stream", async () => {
  const out = await collect(iterateTextStream(streamFrom([])));
  expect(out).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-stream-utils.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stream reader**

```ts
// src/brain/stream-utils.ts

/**
 * Decode a byte ReadableStream (e.g. a subprocess stdout) into text pieces,
 * correctly handling multi-byte UTF-8 characters split across chunk boundaries.
 */
export async function* iterateTextStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-stream-utils.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `sendStream` to the Brain interface**

In `src/types.ts`, inside the `Brain` interface (currently lines 119-129), add the optional method directly under `send`:

```ts
  send(message: string): Promise<string>;
  /**
   * Optional streaming variant of `send`. Yields response text incrementally
   * as the backend produces it, enabling low-latency TTS. Brains that cannot
   * stream omit this; callers must feature-detect with `typeof brain.sendStream`.
   */
  sendStream?(message: string): AsyncIterable<string>;
```

- [ ] **Step 6: Write the failing test for ClaudeCodeBrain.sendStream**

```ts
// tests/brain-claude-code-stream.test.ts
import { test, expect } from "bun:test";
import { ClaudeCodeBrain } from "../src/brain/claude-code";

const hasClaude = Bun.which("claude") !== null;

test.skipIf(!hasClaude)("sendStream yields the same text as send", async () => {
  const brain = new ClaudeCodeBrain();
  await brain.start();
  let streamed = "";
  for await (const piece of brain.sendStream!("Reply with exactly: pong")) {
    streamed += piece;
  }
  expect(streamed.toLowerCase()).toContain("pong");
});

test("sendStream is advertised on the interface", () => {
  const brain = new ClaudeCodeBrain();
  expect(typeof brain.sendStream).toBe("function");
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `bun test tests/brain-claude-code-stream.test.ts`
Expected: FAIL — `brain.sendStream` is `undefined` (second test fails; first skips if `claude` absent).

- [ ] **Step 8: Implement sendStream in ClaudeCodeBrain**

In `src/brain/claude-code.ts`, first extract the prompt builder so `send` and `sendStream` share it (DRY). Replace the body of `send` that builds `fullMessage` (lines 23-28) with a call to a new private method, and add both the method and `sendStream`:

```ts
import { iterateTextStream } from "./stream-utils";
// ...existing imports...

  private buildPrompt(message: string): string {
    const contextPrefix = this.contextBuffer.length > 0
      ? `Context from recent commands:\n${this.contextBuffer.join("\n")}\n\n`
      : "";
    return contextPrefix + message;
  }

  async *sendStream(message: string): AsyncGenerator<string> {
    const proc = Bun.spawn(["claude", "--print", this.buildPrompt(message)], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    let completed = false;
    try {
      yield* iterateTextStream(proc.stdout as ReadableStream<Uint8Array>);
      completed = true;
    } finally {
      if (!completed) {
        try { proc.kill(); } catch { /* already exited */ }
      }
    }

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Claude Code exited with ${exitCode}: ${stderr}`);
    }
  }
```

Then update `send` to reuse `buildPrompt`:

```ts
  async send(message: string): Promise<string> {
    const fullMessage = this.buildPrompt(message);
    try {
      const proc = Bun.spawn(["claude", "--print", fullMessage], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Claude Code exited with ${exitCode}: ${stderr}`);
      }
      return output.trim();
    } catch (err) {
      log("error", `Brain error: ${(err as Error).message}`);
      throw err;
    }
  }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `bun test tests/brain-claude-code-stream.test.ts`
Expected: PASS — interface test passes; equality test passes if `claude` is installed, otherwise skips.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/brain/stream-utils.ts src/brain/claude-code.ts tests/brain-stream-utils.test.ts tests/brain-claude-code-stream.test.ts
git commit -m "feat(brain): add streaming sendStream() with ClaudeCodeBrain support"
```

## Task A3: Wire brain streaming into the daemon

**Files:**
- Create: `src/speaker/brain-stream.ts`
- Test: `tests/brain-stream-pipeline.test.ts`
- Modify: `src/daemon.ts` (handleCommand, after the existing Step 6 local-llm branch at lines 172-184)

- [ ] **Step 1: Write the failing test for the pipeline helper**

```ts
// tests/brain-stream-pipeline.test.ts
import { test, expect } from "bun:test";
import { canStreamBrain, streamBrainToSpeaker } from "../src/speaker/brain-stream";
import type { Brain } from "../src/types";

class FakeStreamingBrain implements Partial<Brain> {
  async *sendStream(_message: string): AsyncGenerator<string> {
    yield "Refactored the auth module. ";
    yield "All tests pass.";
  }
}

class FakeNonStreamingBrain implements Partial<Brain> {
  async send(_m: string): Promise<string> { return "x"; }
}

class CapturingSpeaker {
  sentences: string[] = [];
  async speakStream(stream: AsyncIterable<string>): Promise<void> {
    for await (const s of stream) this.sentences.push(s);
  }
}

test("canStreamBrain detects sendStream support", () => {
  expect(canStreamBrain(new FakeStreamingBrain() as unknown as Brain)).toBe(true);
  expect(canStreamBrain(new FakeNonStreamingBrain() as unknown as Brain)).toBe(false);
});

test("streamBrainToSpeaker segments brain output into sentences", async () => {
  const speaker = new CapturingSpeaker();
  await streamBrainToSpeaker(
    new FakeStreamingBrain() as unknown as Brain,
    speaker as unknown as import("../src/speaker/streaming-tts").StreamingTTSSpeaker,
    "summarize the change",
  );
  expect(speaker.sentences).toEqual(["Refactored the auth module.", "All tests pass."]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-stream-pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pipeline helper**

```ts
// src/speaker/brain-stream.ts
import type { Brain } from "../types";
import type { StreamingTTSSpeaker } from "./streaming-tts";
import { segmentSentences } from "./sentence-stream";

/** True when the brain can stream its response token-by-token. */
export function canStreamBrain(brain: Brain): boolean {
  return typeof brain.sendStream === "function";
}

/**
 * Pipe a brain's streamed response through the sentence segmenter into the
 * streaming speaker, so the first sentence is spoken while later ones are still
 * being produced. Caller must have already confirmed `canStreamBrain(brain)`.
 */
export async function streamBrainToSpeaker(
  brain: Brain,
  speaker: StreamingTTSSpeaker,
  prompt: string,
): Promise<void> {
  if (!brain.sendStream) throw new Error("brain does not support streaming");
  await speaker.speakStream(segmentSentences(brain.sendStream(prompt)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-stream-pipeline.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the daemon branch**

In `src/daemon.ts`, add the import at the top with the other speaker imports:

```ts
import { canStreamBrain, streamBrainToSpeaker } from "./speaker/brain-stream";
```

Then in `handleCommand`, immediately AFTER the existing Step 6 `local-llm` block (which ends with `return;` at line 184) and BEFORE Step 7's thinking earcon (line 186), insert:

```ts
      // Step 6b: Streaming pipeline for brain queries in conversational mode.
      // Verify against ActionExecutor.execute's brain branch (src/executor/index.ts)
      // that a brain command resolves to brain.send(<text>); match that prompt here.
      if (
        result.category === "brain" &&
        this.conversational?.isActive() &&
        this.streamingSpeaker &&
        canStreamBrain(this.brain)
      ) {
        log("speak", "Streaming brain → TTS pipeline...");
        await streamBrainToSpeaker(this.brain, this.streamingSpeaker, text);
        this.contextStore.addTurn({
          text: expanded,
          intent: result.intent,
          category: result.category,
          params: result.params,
        });
        return;
      }
```

Note: the `brain.injectContext(recentContext)` enrichment at Step 5 (lines 166-170) already ran for brain category, so the streamed prompt inherits context exactly as the batch path does.

- [ ] **Step 6: Run the full suite to verify no regressions**

Run: `bun test`
Expected: all prior tests still pass (baseline was 270 pass / 2 skip / 0 fail), plus the new Part A tests.

- [ ] **Step 7: Commit**

```bash
git add src/speaker/brain-stream.ts tests/brain-stream-pipeline.test.ts src/daemon.ts
git commit -m "feat(daemon): stream brain responses through chunked TTS in conversational mode"
```

---

# Part B — Pre-warm TTS (warm decoder)

Cicero's server-based TTS providers (Kokoro, MLX-Audio) stay resident via the managed-server pattern, so they are "warm" *after* the first call. But the first real utterance pays model-load + first-inference cost. Athena keeps its decoder warm between utterances; Cicero's equivalent is a startup pre-warm: fire one throwaway generation when the daemon starts so the model is resident before the first turn.

## Task B1: Optional `warmup()` on TTSProvider, called at daemon start

**Files:**
- Modify: `src/backends/tts/provider.ts` (interface, lines 12-18)
- Modify: `src/backends/tts/kokoro.ts` (and any other server-based provider with a `start()`)
- Modify: `src/daemon.ts` (start sequence)
- Test: `tests/tts-warmup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tts-warmup.test.ts
import { test, expect } from "bun:test";
import { warmupProvider } from "../src/backends/tts/warmup";
import type { TTSProvider } from "../src/backends/tts/provider";

function fakeProvider(overrides: Partial<TTSProvider>): TTSProvider {
  return {
    name: "fake",
    async generateAudio() { return new ArrayBuffer(0); },
    async health() { return true; },
    ...overrides,
  } as TTSProvider;
}

test("warmupProvider calls provider.warmup when present", async () => {
  let called = false;
  const p = fakeProvider({ warmup: async () => { called = true; } });
  await warmupProvider(p);
  expect(called).toBe(true);
});

test("warmupProvider is a no-op when warmup is absent", async () => {
  const p = fakeProvider({});
  await warmupProvider(p); // must not throw
  expect(true).toBe(true);
});

test("warmupProvider swallows warmup errors (best-effort)", async () => {
  const p = fakeProvider({ warmup: async () => { throw new Error("cold"); } });
  await warmupProvider(p); // must not throw
  expect(true).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tts-warmup.test.ts`
Expected: FAIL — `../src/backends/tts/warmup` not found.

- [ ] **Step 3: Add `warmup?()` to the interface and the helper**

In `src/backends/tts/provider.ts`, add to the `TTSProvider` interface (after `stop?()`):

```ts
  /**
   * Optional: perform a throwaway generation so the model is resident before
   * the first real utterance. Best-effort — callers ignore failures.
   */
  warmup?(): Promise<void>;
```

Create `src/backends/tts/warmup.ts`:

```ts
import type { TTSProvider } from "./provider";
import { log } from "../../logger";

/** Best-effort pre-warm of a TTS provider; never throws. */
export async function warmupProvider(provider: TTSProvider): Promise<void> {
  if (!provider.warmup) return;
  try {
    await provider.warmup();
    log("info", `TTS provider '${provider.name}' warmed up`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("info", `TTS warmup skipped for '${provider.name}': ${msg}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tts-warmup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement `warmup()` on the server-based provider(s)**

In `src/backends/tts/kokoro.ts`, add a `warmup` method that generates a tiny utterance and discards it (the managed server must already be started; daemon ordering in Step 6 guarantees this):

```ts
  async warmup(): Promise<void> {
    // One short throwaway generation forces model load into VRAM so the first
    // real utterance is fast. Result is discarded.
    await this.generateAudio("Ready.");
  }
```

Apply the same `warmup()` to any other resident-server provider that defines `start()` (e.g. `src/backends/tts/mlx-audio.ts`, `src/backends/tts/vibevoice.ts`). Skip providers without a persistent server (nothing to warm).

- [ ] **Step 6: Call warmup during daemon start**

In `src/daemon.ts`, after the speaker/providers are constructed and the brain has started (around line 87, after `await this.brain.start()`), add a non-blocking pre-warm so it never delays startup:

```ts
import { warmupProvider } from "./backends/tts/warmup";
// ...
    // Pre-warm TTS so the first spoken response isn't cold-start slow.
    void warmupProvider(this.providers.tts);
```

Use `void` (fire-and-forget) — startup must not block on warmup, and `warmupProvider` already swallows errors.

- [ ] **Step 7: Run the full suite**

Run: `bun test`
Expected: all pass, including the 3 new warmup tests.

- [ ] **Step 8: Commit**

```bash
git add src/backends/tts/provider.ts src/backends/tts/warmup.ts src/backends/tts/kokoro.ts src/daemon.ts tests/tts-warmup.test.ts
git commit -m "feat(tts): pre-warm resident TTS providers at daemon start"
```

---

# Part C — Interruption with recovery

Barge-in already interrupts playback (`onBargeIn` → `streamingSpeaker.interrupt()`), but it throws away what the assistant was mid-saying. Goal: when the user interjects, capture what was already spoken, feed that plus the interjection to the brain as context, so the brain can address the interjection and resume the dropped thread naturally.

## Task C1: Track spoken vs. in-flight sentences in StreamingTTSSpeaker

**Files:**
- Modify: `src/speaker/streaming-tts.ts`
- Test: `tests/streaming-tts-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/streaming-tts-snapshot.test.ts
import { test, expect } from "bun:test";
import { StreamingTTSSpeaker } from "../src/speaker/streaming-tts";
import type { TTSProvider } from "../src/backends/tts/provider";
import type { Speaker } from "../src/types";

// Empty-buffer provider → playAudioInterruptible returns immediately (no audio).
const silentProvider: TTSProvider = {
  name: "silent",
  async generateAudio() { return new ArrayBuffer(0); },
  async health() { return true; },
};
const noopPlayer = { async play() {} } as unknown as import("../src/platform/audio").AudioPlayer;
const noopFallback = { async speak() {}, async health() { return true; }, async stop() {} } as unknown as Speaker;

async function* fromArray(items: string[]): AsyncGenerator<string> {
  for (const i of items) yield i;
}

test("records all sentences as spoken after a full run", async () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  await sp.speakStream(fromArray(["First sentence.", "Second sentence.", "Third."]));
  const snap = sp.getSnapshot();
  expect(snap.spoken).toEqual(["First sentence.", "Second sentence.", "Third."]);
  expect(snap.pending).toEqual([]);
});

test("speakStream resets spoken history each call", async () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  await sp.speakStream(fromArray(["A.", "B."]));
  await sp.speakStream(fromArray(["C."]));
  expect(sp.getSnapshot().spoken).toEqual(["C."]);
});

test("interrupt before any playback leaves spoken empty", () => {
  const sp = new StreamingTTSSpeaker(silentProvider, noopPlayer, noopFallback);
  sp.interrupt();
  expect(sp.getSnapshot().spoken).toEqual([]);
  expect(sp.getSnapshot().pending).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/streaming-tts-snapshot.test.ts`
Expected: FAIL — `getSnapshot` is not a function.

- [ ] **Step 3: Add tracking fields and rewrite speakStream**

In `src/speaker/streaming-tts.ts`, add fields near the existing private fields (lines 8-10):

```ts
  private spoken: string[] = [];
  private inFlight: string | null = null;
```

Replace the existing `speakStream` method (lines 16-57) with this version, which records each sentence as spoken only once its playback completes uninterrupted:

```ts
  async speakStream(sentences: AsyncIterable<string>): Promise<void> {
    this.interrupted = false;
    this.playing = true;
    this.spoken = [];
    this.inFlight = null;

    try {
      let pendingAudio: Promise<ArrayBuffer> | null = null;
      let pendingText: string | null = null;

      for await (const sentence of sentences) {
        if (this.interrupted) break;
        const trimmed = sentence.trim();
        if (!trimmed) continue;

        if (pendingAudio && pendingText) {
          const audio = await pendingAudio;
          if (this.interrupted) break;
          const nowPlaying = pendingText;
          // Start generating the next sentence while this one plays.
          pendingAudio = this.generateAudioSafe(trimmed);
          pendingText = trimmed;
          this.inFlight = nowPlaying;
          await this.playAudioInterruptible(audio);
          if (this.interrupted) break;
          this.spoken.push(nowPlaying);
          this.inFlight = null;
        } else {
          pendingAudio = this.generateAudioSafe(trimmed);
          pendingText = trimmed;
        }
      }

      if (pendingAudio && pendingText && !this.interrupted) {
        const audio = await pendingAudio;
        if (!this.interrupted) {
          this.inFlight = pendingText;
          await this.playAudioInterruptible(audio);
          if (!this.interrupted) {
            this.spoken.push(pendingText);
            this.inFlight = null;
          }
        }
      }
    } catch (err: unknown) {
      if (!this.interrupted) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `Streaming TTS error: ${msg}`);
      }
    } finally {
      this.playing = false;
      this.currentPlayer = null;
    }
  }

  /**
   * Snapshot of what has been spoken vs. the sentence that was playing when
   * interrupted. `pending` holds the in-flight sentence (if any); future
   * unspoken sentences are not known because the source is a live stream.
   */
  getSnapshot(): { spoken: string[]; pending: string[] } {
    return { spoken: [...this.spoken], pending: this.inFlight ? [this.inFlight] : [] };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/streaming-tts-snapshot.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/speaker/streaming-tts.ts tests/streaming-tts-snapshot.test.ts
git commit -m "feat(speaker): track spoken/in-flight sentences for interruption recovery"
```

## Task C2: Recovery-context builder

**Files:**
- Create: `src/speaker/recovery.ts`
- Test: `tests/recovery-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/recovery-context.test.ts
import { test, expect } from "bun:test";
import { buildRecoveryContext } from "../src/speaker/recovery";

test("includes what was said and the interjection", () => {
  const ctx = buildRecoveryContext({
    spoken: ["I refactored the auth module.", "Tests are running now."],
    interjection: "wait, use JWT instead",
  });
  expect(ctx).toContain("I refactored the auth module. Tests are running now.");
  expect(ctx).toContain("wait, use JWT instead");
});

test("uses the no-speech variant when nothing was spoken yet", () => {
  const ctx = buildRecoveryContext({ spoken: [], interjection: "actually, hold on" });
  expect(ctx).toContain("actually, hold on");
  expect(ctx).not.toContain("You had already said");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/recovery-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder**

```ts
// src/speaker/recovery.ts

/**
 * Build a context line, injected into the brain before the interjection turn,
 * so the assistant knows it was interrupted mid-response and can resume.
 */
export function buildRecoveryContext(opts: { spoken: string[]; interjection: string }): string {
  const said = opts.spoken.join(" ").trim();
  if (!said) {
    return `[The user interjected before you finished responding. They said: "${opts.interjection}". Address it, then continue naturally.]`;
  }
  return `[You were speaking and the user interrupted you. You had already said: "${said}". The user interjected: "${opts.interjection}". Respond to their interjection first. If your previous point was unfinished, briefly resume it afterward.]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/recovery-context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/speaker/recovery.ts tests/recovery-context.test.ts
git commit -m "feat(speaker): add interruption recovery-context builder"
```

## Task C3: Wire recovery into the daemon's barge-in path

**Files:**
- Modify: `src/daemon.ts` (onBargeIn wiring at line 99; handleCommand top)
- Test: `tests/recovery-injection.test.ts`

- [ ] **Step 1: Write the failing composition test**

This tests the composition of the two pure pieces (snapshot → recovery context → injected into the brain), which is exactly what the daemon wiring does, without constructing the full daemon.

```ts
// tests/recovery-injection.test.ts
import { test, expect } from "bun:test";
import { buildRecoveryContext } from "../src/speaker/recovery";
import type { Brain } from "../src/types";

class FakeBrain implements Partial<Brain> {
  lastContext = "";
  injectContext(ctx: string): void { this.lastContext = ctx; }
}

test("a snapshot interjection produces an injected recovery context", () => {
  const brain = new FakeBrain();
  const snapshot = { spoken: ["I refactored the auth module."], pending: [] as string[] };
  const interjection = "wait, use JWT";
  brain.injectContext(buildRecoveryContext({ spoken: snapshot.spoken, interjection }));
  expect(brain.lastContext).toContain("I refactored the auth module.");
  expect(brain.lastContext).toContain("wait, use JWT");
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test tests/recovery-injection.test.ts`
Expected: PASS — it exercises already-shipped functions. (This test locks the contract the daemon wiring must satisfy; it is green before the daemon edit and stays green after.)

- [ ] **Step 3: Add the recovery field and snapshot-on-barge-in**

In `src/daemon.ts`, add a field near the other private fields (around line 43):

```ts
  private pendingRecovery: { spoken: string[] } | null = null;
```

Add the import with the other speaker imports:

```ts
import { buildRecoveryContext } from "./speaker/recovery";
```

Replace the existing barge-in wiring at line 99:

```ts
      this.conversational.onBargeIn(() => this.streamingSpeaker?.interrupt());
```

with a version that snapshots before interrupting:

```ts
      this.conversational.onBargeIn(() => {
        if (this.streamingSpeaker) {
          this.pendingRecovery = { spoken: this.streamingSpeaker.getSnapshot().spoken };
          this.streamingSpeaker.interrupt();
        }
      });
```

- [ ] **Step 4: Inject recovery context at the start of the next command**

In `handleCommand`, immediately after the empty-input guard `if (!expanded.trim()) return;` (line 135), insert:

```ts
      // If this turn follows a barge-in, tell the brain what it was mid-saying
      // so it can address the interjection and resume. (When Plan 2 Task 4 ships,
      // a bare "stop" is filtered before reaching here, so this only fires for
      // genuine interjections.)
      if (this.pendingRecovery) {
        this.brain.injectContext(
          buildRecoveryContext({ spoken: this.pendingRecovery.spoken, interjection: expanded }),
        );
        this.pendingRecovery = null;
      }
```

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Manual verification (live barge-in)**

The end-to-end barge-in→interrupt→recover loop spawns real audio playback and STT, so it cannot be unit-tested deterministically. Verify by hand:

```bash
bun run src/index.ts   # or the project's daemon entrypoint
```

1. Activate conversational mode, ask a question that yields a multi-sentence brain reply.
2. While it is speaking, interject (e.g. "wait, do it with JWT instead").
3. Confirm: playback stops promptly; the next reply acknowledges the interjection AND references/resumes the interrupted thread.

If Plan 2 Task 4 (`isStopCommand`) is NOT yet implemented, also confirm a bare "stop" currently triggers a (harmless) recovery turn — document this as the known limitation that Task 4 removes.

- [ ] **Step 7: Commit**

```bash
git add src/daemon.ts tests/recovery-injection.test.ts
git commit -m "feat(daemon): recover conversation thread after barge-in interjection"
```

---

# Task D1 (optional): Converge the local-llm splitter onto the shared segmenter

`ActionExecutor.executeLocalLLMStreaming` (`src/executor/index.ts:354-367`) still has its own inline sentence splitter, now duplicated by `segmentSentences`. Rule-of-three says two copies is tolerable, so this is optional cleanup — do it only if touching that method anyway.

**Files:**
- Modify: `src/executor/index.ts`

- [ ] **Step 1: Refactor to delegate**

Restructure `executeLocalLLMStreaming` so the SSE loop yields `<think>`-stripped text tokens from an inner generator, then `yield* segmentSentences(cleanedTokens())`. Keep the `<think>` state machine inside the producer (the segmenter only handles sentence boundaries). Import `segmentSentences` from `../speaker/sentence-stream`.

- [ ] **Step 2: Verify no behavior change**

Run: `bun test`
Expected: all pass — the local-llm streaming behavior is unchanged; only the splitter source is shared.

- [ ] **Step 3: Commit**

```bash
git add src/executor/index.ts
git commit -m "refactor(executor): reuse shared sentence segmenter in local-llm streaming"
```

---

## Self-review checklist (done while writing)

- **Spec coverage:** Chunked streaming TTS → Part A (A1 segmenter, A2 Brain.sendStream, A3 daemon wiring). Warm decoder → Part B. Interruption-with-recovery → Part C (C1 snapshot, C2 context builder, C3 daemon wiring). ✓
- **No rebuild of existing infra:** `StreamingTTSSpeaker`, `speakStream`, `interrupt`, managed-server residency, and the local-llm streaming path are extended, not duplicated; the "What already exists" section calls them out. ✓
- **Type consistency:** `sendStream?(message: string): AsyncIterable<string>` declared in `Brain` (A2) and consumed in `brain-stream.ts` (A3); `getSnapshot(): { spoken: string[]; pending: string[] }` defined in C1 and consumed in C3; `buildRecoveryContext({ spoken, interjection })` defined in C2 and called identically in C3. ✓
- **Known dependency:** Part C composes with Plan 2 Task 4 (`isStopCommand`); documented, and the plan degrades gracefully without it. ✓
- **Untestable paths flagged:** live barge-in (C3 Step 6) and `claude`-dependent streaming (A2 Step 6) are explicitly manual/skip-guarded rather than faked into false confidence. ✓
