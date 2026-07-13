# Backend Abstraction & Cross-Platform Support — Implementation Plan

> **Historical plan:** planned providers and configuration snippets here are not an operator reference. Proposed cloud STT fields were never implemented and are rejected by the current strict schema.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Cicero from MLX-only backends via provider interfaces so it can run on macOS (MLX), Windows/Linux (CUDA), and cloud APIs — without breaking existing behavior.

**Architecture:** Three provider interfaces (STT, TTS, LLM) with swappable implementations. A registry factory reads config and returns concrete providers. Platform abstraction for audio playback/recording and terminal control. Existing MLX code is extracted into the first provider implementations — zero behavior change for Mac users.

**Tech Stack:** Bun, TypeScript, bun:test. Python backends via HTTP APIs. Existing sox/afplay for audio.

**Spec:** `docs/superpowers/specs/2026-04-06-backend-abstraction-design.md`

---

## File Structure

### New files

```
src/backends/
  stt/provider.ts          — STTProvider interface + config type
  stt/mlx-whisper.ts       — extracted from ConversationalListener.transcribe()
  stt/faster-whisper.ts    — CUDA STT backend (Phase 2)
  tts/provider.ts          — TTSProvider interface + config type
  tts/mlx-audio.ts         — extracted from TTSSpeaker.generateAudio()
  tts/kokoro.ts            — CUDA TTS default (Phase 2)
  tts/vibevoice.ts         — CUDA TTS cloning option (Phase 2)
  llm/provider.ts          — LLMProvider interface + config type
  llm/mlx-lm.ts            — extracted from LLMRouter fetch calls
  llm/ollama.ts            — cross-platform LLM backend (Phase 2)
  registry.ts              — factory: config → concrete providers
  tiers.ts                 — tier preset definitions
  managed-server.ts        — extracted from ServerManager.startServer()
src/platform/
  audio.ts                 — AudioPlayer/AudioRecorder interfaces + factories
  audio-macos.ts           — afplay playback (extracted from TTSSpeaker)
  audio-linux.ts           — aplay/paplay playback
  audio-windows.ts         — ffplay playback
  recorder-sox.ts          — sox rec (extracted from ConversationalListener)
  recorder-windows.ts      — sox -d / ffmpeg on Windows
src/terminal/
  tmux.ts                  — tmux adapter
tests/
  backends/registry.test.ts
  backends/mlx-lm.test.ts
  backends/mlx-whisper.test.ts
  backends/mlx-audio.test.ts
  backends/managed-server.test.ts
  platform/audio.test.ts
  terminal/tmux.test.ts
  config-tiers.test.ts
```

### Modified files

```
src/types.ts               — add backend config types, extend terminal union
src/config.ts              — add tier expansion, backend config fields, backward compat
src/router/llm-router.ts   — take LLMProvider instead of port+model
src/router/index.ts        — createRouter() gets provider from registry
src/speaker/tts-speaker.ts — take TTSProvider + AudioPlayer
src/speaker/streaming-tts.ts — same pattern
src/speaker/index.ts       — createSpeaker() gets provider + player from registry
src/listener/conversational.ts — take STTProvider + AudioRecorder + AudioPlayer
src/listener/index.ts      — createConversationalListener() gets providers
src/servers/index.ts       — ServerManager delegates to provider lifecycle
src/daemon.ts              — create providers via registry, wire everything
```

---

## Phase 1: Foundation (extract + abstract, zero behavior change)

### Task 1: Provider Interfaces

**Files:**
- Create: `src/backends/stt/provider.ts`
- Create: `src/backends/tts/provider.ts`
- Create: `src/backends/llm/provider.ts`

- [ ] **Step 1: Create STT provider interface**

```typescript
// src/backends/stt/provider.ts
export interface STTProviderConfig {
  backend?: string;
  port?: number;
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface STTProvider {
  readonly name: string;
  transcribe(audioFile: string): Promise<string | null>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

- [ ] **Step 2: Create TTS provider interface**

```typescript
// src/backends/tts/provider.ts
export interface TTSProviderConfig {
  backend?: string;
  port?: number;
  model?: string;
  voice?: string;
  refAudio?: string;
  refText?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface TTSProvider {
  readonly name: string;
  generateAudio(text: string): Promise<ArrayBuffer>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

- [ ] **Step 3: Create LLM provider interface**

```typescript
// src/backends/llm/provider.ts
export interface LLMProviderConfig {
  backend?: string;
  port?: number;
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOpts {
  temperature?: number;
  max_tokens?: number;
  responseFormat?: {
    type: "json_schema";
    json_schema: Record<string, unknown>;
  };
}

export interface LLMProvider {
  readonly name: string;
  chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string>;
  health(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/backends/
git commit -m "feat: add STT, TTS, LLM provider interfaces"
```

---

### Task 2: Managed Server Utility

**Files:**
- Create: `src/backends/managed-server.ts`
- Create: `tests/backends/managed-server.test.ts`
- Read: `src/servers/index.ts` (extracting from `ServerManager.startServer()`)
- Read: `src/servers/health.ts` (reusing `HealthChecker`)

- [ ] **Step 1: Write test for managed server (port already in use)**

```typescript
// tests/backends/managed-server.test.ts
import { test, expect, describe } from "bun:test";
import { startManagedServer, stopManagedServer } from "../src/backends/managed-server";

describe("startManagedServer", () => {
  test("returns unmanaged process if port is already healthy", async () => {
    // Start a simple HTTP server on a random port
    const server = Bun.serve({
      port: 0, // random port
      fetch: () => new Response("ok"),
    });
    const port = server.port;

    const result = await startManagedServer({
      name: "test",
      port,
      command: ["echo", "should not run"],
      healthUrl: `http://localhost:${port}/`,
      timeoutMs: 5000,
    });

    expect(result).not.toBeNull();
    expect(result!.managed).toBe(false);
    expect(result!.proc).toBeNull();
    expect(result!.port).toBe(port);

    server.stop();
  });

  test("returns null if command binary does not exist", async () => {
    const result = await startManagedServer({
      name: "test",
      port: 19999,
      command: ["/nonexistent/binary", "--start"],
      healthUrl: "http://localhost:19999/",
      timeoutMs: 3000,
    });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backends/managed-server.test.ts`
Expected: FAIL — module `../src/backends/managed-server` does not exist

- [ ] **Step 3: Implement managed server utility**

Extract logic from `src/servers/index.ts:startServer()` and `src/servers/health.ts`:

```typescript
// src/backends/managed-server.ts
import { log } from "../logger";

export interface ManagedProcess {
  proc: ReturnType<typeof Bun.spawn> | null;
  containerId?: string;
  port: number;
  managed: boolean;
  mode: "process" | "docker";
}

interface StartOpts {
  name: string;
  port: number;
  command: string[];
  healthUrl: string;
  timeoutMs?: number;
  intervalMs?: number;
  mode?: "process" | "docker";
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(url)) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

export async function startManagedServer(opts: StartOpts): Promise<ManagedProcess | null> {
  const { name, port, command, healthUrl, timeoutMs = 60000, intervalMs = 1000, mode = "process" } = opts;

  // Already running?
  if (await checkHealth(healthUrl)) {
    log("ok", `${name} server already running on :${port}`);
    return { proc: null, port, managed: false, mode };
  }

  // Check binary exists
  const binary = command[0];
  const which = Bun.spawn(["which", binary], { stdout: "ignore", stderr: "ignore" });
  const whichExit = await which.exited;

  // Also check if it's a direct path that exists
  const fileExists = whichExit === 0 || await Bun.file(binary).exists();
  if (!fileExists) {
    log("warn", `${name}: binary '${binary}' not found — running in degraded mode`);
    return null;
  }

  log("info", `Starting ${name} server on :${port}...`);

  if (mode === "docker") {
    const proc = Bun.spawn(["docker", "run", "-d", "-p", `${port}:${port}`, ...command.slice(1)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const containerId = output.trim();
    await proc.exited;

    const healthy = await waitForHealth(healthUrl, timeoutMs, intervalMs);
    if (healthy) {
      log("ok", `${name} server ready on :${port} (docker: ${containerId.substring(0, 12)})`);
      return { proc: null, containerId, port, managed: true, mode };
    }

    log("warn", `${name} server did not become healthy in ${timeoutMs / 1000}s — continuing in degraded mode`);
    Bun.spawn(["docker", "stop", containerId], { stdout: "ignore", stderr: "ignore" });
    return null;
  }

  // Process mode (default)
  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env },
  });

  const healthy = await waitForHealth(healthUrl, timeoutMs, intervalMs);
  if (healthy) {
    log("ok", `${name} server ready on :${port}`);
    return { proc, port, managed: true, mode };
  }

  log("warn", `${name} server did not become healthy in ${timeoutMs / 1000}s — continuing in degraded mode`);
  return { proc, port, managed: true, mode };
}

export async function stopManagedServer(mp: ManagedProcess): Promise<void> {
  if (!mp.managed) return;

  if (mp.mode === "docker" && mp.containerId) {
    try {
      const proc = Bun.spawn(["docker", "stop", mp.containerId], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
    } catch { /* already stopped */ }
  } else if (mp.proc) {
    try {
      mp.proc.kill();
    } catch { /* already dead */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backends/managed-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/backends/managed-server.ts tests/backends/managed-server.test.ts
git commit -m "feat: extract managed server utility from ServerManager"
```

---

### Task 3: Platform Audio Abstraction

**Files:**
- Create: `src/platform/audio.ts`
- Create: `src/platform/audio-macos.ts`
- Create: `src/platform/audio-linux.ts`
- Create: `src/platform/audio-windows.ts`
- Create: `src/platform/recorder-sox.ts`
- Create: `src/platform/recorder-windows.ts`
- Create: `tests/platform/audio.test.ts`

- [ ] **Step 1: Write test for platform audio factory**

```typescript
// tests/platform/audio.test.ts
import { test, expect, describe } from "bun:test";
import { createAudioPlayer, createAudioRecorder } from "../src/platform/audio";
import type { AudioPlayer, AudioRecorder } from "../src/platform/audio";

describe("createAudioPlayer", () => {
  test("returns a player with play and stopAll methods", () => {
    const player = createAudioPlayer();
    expect(typeof player.play).toBe("function");
    expect(typeof player.stopAll).toBe("function");
  });
});

describe("createAudioRecorder", () => {
  test("returns a recorder with record method", () => {
    const recorder = createAudioRecorder();
    expect(typeof recorder.record).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/platform/audio.test.ts`
Expected: FAIL — module `../src/platform/audio` does not exist

- [ ] **Step 3: Create audio interfaces and factory**

```typescript
// src/platform/audio.ts
export interface AudioPlayer {
  play(filePath: string): Promise<void>;
  stopAll(): void;
}

export interface RecordOpts {
  sampleRate?: number;
  silenceDuration?: string;
  silenceThreshold?: string;
  maxDuration?: number;
}

export interface AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn>;
}

export function createAudioPlayer(): AudioPlayer {
  switch (process.platform) {
    case "darwin":
      return new (require("./audio-macos").MacAudioPlayer)();
    case "linux":
      return new (require("./audio-linux").LinuxAudioPlayer)();
    case "win32":
      return new (require("./audio-windows").WindowsAudioPlayer)();
    default:
      return new (require("./audio-linux").LinuxAudioPlayer)();
  }
}

export function createAudioRecorder(): AudioRecorder {
  switch (process.platform) {
    case "win32":
      return new (require("./recorder-windows").WindowsAudioRecorder)();
    default:
      return new (require("./recorder-sox").SoxAudioRecorder)();
  }
}
```

- [ ] **Step 4: Create macOS audio player** (extracted from `TTSSpeaker.playAudio()` and `TTSSpeaker.stop()`)

```typescript
// src/platform/audio-macos.ts
import type { AudioPlayer } from "./audio";

export class MacAudioPlayer implements AudioPlayer {
  async play(filePath: string): Promise<void> {
    const player = Bun.spawn(["afplay", filePath], { stdout: "ignore", stderr: "ignore" });
    await player.exited;
  }

  stopAll(): void {
    try {
      Bun.spawn(["pkill", "-f", "afplay.*cicero"], { stdout: "ignore", stderr: "ignore" });
    } catch { /* nothing playing */ }
  }
}
```

- [ ] **Step 5: Create Linux audio player**

```typescript
// src/platform/audio-linux.ts
import type { AudioPlayer } from "./audio";

export class LinuxAudioPlayer implements AudioPlayer {
  async play(filePath: string): Promise<void> {
    // aplay for lowest latency (~45ms), fallback to paplay
    const binary = await this.findPlayer();
    const player = Bun.spawn([binary, filePath], { stdout: "ignore", stderr: "ignore" });
    await player.exited;
  }

  stopAll(): void {
    try {
      Bun.spawn(["pkill", "-f", "aplay.*cicero|paplay.*cicero"], { stdout: "ignore", stderr: "ignore" });
    } catch { /* nothing playing */ }
  }

  private async findPlayer(): Promise<string> {
    const aplay = Bun.spawn(["which", "aplay"], { stdout: "ignore", stderr: "ignore" });
    if ((await aplay.exited) === 0) return "aplay";
    return "paplay";
  }
}
```

- [ ] **Step 6: Create Windows audio player**

```typescript
// src/platform/audio-windows.ts
import type { AudioPlayer } from "./audio";

export class WindowsAudioPlayer implements AudioPlayer {
  async play(filePath: string): Promise<void> {
    const player = Bun.spawn(
      ["ffplay", "-nodisp", "-autoexit", "-audio_buffer_size", "64", filePath],
      { stdout: "ignore", stderr: "ignore" },
    );
    await player.exited;
  }

  stopAll(): void {
    try {
      Bun.spawn(["taskkill", "/F", "/IM", "ffplay.exe"], { stdout: "ignore", stderr: "ignore" });
    } catch { /* nothing playing */ }
  }
}
```

- [ ] **Step 7: Create sox recorder** (extracted from `ConversationalListener.recordUntilSilence()`)

```typescript
// src/platform/recorder-sox.ts
import type { AudioRecorder, RecordOpts } from "./audio";

export class SoxAudioRecorder implements AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn> {
    const sampleRate = opts.sampleRate ?? 16000;
    const silenceDuration = opts.silenceDuration ?? "1.5";
    const silenceThreshold = opts.silenceThreshold ?? "3%";
    const maxDuration = opts.maxDuration ?? 30;

    return Bun.spawn([
      "rec", "-q",
      "-r", "48000",
      "-c", "1",
      "-b", "16",
      outPath,
      "highpass", "80",
      "compand", "0.3,1", "6:-70,-60,-20", "-5", "-90", "0.2",
      "rate", "-v", sampleRate.toString(),
      "silence",
      "1", "0.1", silenceThreshold,
      "1", silenceDuration, silenceThreshold,
      "trim", "0", maxDuration.toString(),
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
```

- [ ] **Step 8: Create Windows recorder**

```typescript
// src/platform/recorder-windows.ts
import type { AudioRecorder, RecordOpts } from "./audio";

export class WindowsAudioRecorder implements AudioRecorder {
  record(outPath: string, opts: RecordOpts): ReturnType<typeof Bun.spawn> {
    const sampleRate = opts.sampleRate ?? 16000;
    const silenceDuration = opts.silenceDuration ?? "1.5";
    const silenceThreshold = opts.silenceThreshold ?? "3%";
    const maxDuration = opts.maxDuration ?? 30;

    // Windows has no `rec` symlink — use `sox -d` (default input device)
    return Bun.spawn([
      "sox", "-d", "-q",
      "-r", "48000",
      "-c", "1",
      "-b", "16",
      outPath,
      "highpass", "80",
      "compand", "0.3,1", "6:-70,-60,-20", "-5", "-90", "0.2",
      "rate", "-v", sampleRate.toString(),
      "silence",
      "1", "0.1", silenceThreshold,
      "1", silenceDuration, silenceThreshold,
      "trim", "0", maxDuration.toString(),
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `bun test tests/platform/audio.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/platform/ tests/platform/
git commit -m "feat: add cross-platform audio player and recorder abstraction"
```

---

### Task 4: MLX LLM Provider (extract from LLMRouter)

**Files:**
- Create: `src/backends/llm/mlx-lm.ts`
- Create: `tests/backends/mlx-lm.test.ts`
- Modify: `src/router/llm-router.ts`
- Modify: `src/router/index.ts`

- [ ] **Step 1: Write test for MlxLmProvider**

```typescript
// tests/backends/mlx-lm.test.ts
import { test, expect, describe, mock } from "bun:test";
import { MlxLmProvider } from "../src/backends/llm/mlx-lm";

describe("MlxLmProvider", () => {
  test("has correct name", () => {
    const provider = new MlxLmProvider({ port: 8081, model: "test-model" });
    expect(provider.name).toBe("mlx-lm");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxLmProvider({ port: 19998, model: "test-model" });
    const healthy = await provider.health();
    expect(healthy).toBe(false);
  });

  test("chatCompletion throws when server is down", async () => {
    const provider = new MlxLmProvider({ port: 19998, model: "test-model" });
    await expect(
      provider.chatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backends/mlx-lm.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement MlxLmProvider**

Extract the fetch logic from `src/router/llm-router.ts:30-48`:

```typescript
// src/backends/llm/mlx-lm.ts
import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";

export class MlxLmProvider implements LLMProvider {
  readonly name = "mlx-lm";
  private port: number;
  private model: string;

  constructor(config: LLMProviderConfig) {
    this.port = config.port ?? 8081;
    this.model = config.model ?? "mlx-community/Qwen3.5-0.8B-MLX-4bit";
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const response = await fetch(`http://localhost:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.0,
        max_tokens: opts?.max_tokens ?? 100,
      }),
    });

    if (!response.ok) throw new Error(`MLX LLM server returned ${response.status}`);

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backends/mlx-lm.test.ts`
Expected: PASS

- [ ] **Step 5: Update LLMRouter to use LLMProvider**

Modify `src/router/llm-router.ts` — change constructor to accept `LLMProvider`, replace direct fetch with `this.provider.chatCompletion()`:

```typescript
// src/router/llm-router.ts
import type { Router, RouterResult, ActionConfig } from "../types";
import type { LLMProvider, LLMCompletionOpts } from "../backends/llm/provider";

export class LLMRouter implements Router {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async classify(text: string, actions: Record<string, ActionConfig>, context?: string): Promise<RouterResult> {
    const systemPrompt = this.buildSystemPrompt(actions);

    const messages: Array<{role: "system" | "user" | "assistant", content: string}> = [
      { role: "system", content: systemPrompt },
    ];

    if (context) {
      messages.push({
        role: "system",
        content: `Recent conversation:\n${context}\n\nNow classify the next command:`,
      });
    }

    messages.push({ role: "user", content: text });

    try {
      const content = await this.provider.chatCompletion(messages, {
        temperature: 0.0,
        max_tokens: 100,
      });
      return this.parseResponse(content);
    } catch {
      throw new Error("LLM router unavailable");
    }
  }

  async health(): Promise<boolean> {
    return this.provider.health();
  }

  // buildSystemPrompt and parseResponse remain UNCHANGED from current code
  private buildSystemPrompt(actions: Record<string, ActionConfig>): string {
    const actionList = Object.entries(actions)
      .map(([name, action]) => `- ${name} (${action.category}): ${action.examples.slice(0, 2).join(", ")}`)
      .join("\n");

    return `/no_think
Classify the voice command into JSON: {"intent":"<name>","category":"<cat>","params":{...},"confidence":<0-1>}

Actions:
${actionList}

Special intents:
- simple_question (category: local-llm): factual questions, jokes, definitions, conversational chat
- complex (category: brain): code tasks, file editing, multi-step reasoning, project work

Examples:
User: switch to the sales tab
{"intent":"tab_switch","category":"terminal","params":{"tab":"sales"},"confidence":0.95}

User: type ls into the prompt
{"intent":"text_inject","category":"brain","params":{"payload":"ls"},"confidence":0.95}

User: mute
{"intent":"runtime_mute","category":"local","params":{},"confidence":0.95}

User: what is the capital of France
{"intent":"simple_question","category":"local-llm","params":{"query":"what is the capital of France"},"confidence":0.9}

User: refactor the auth module to use JWT tokens
{"intent":"complex","category":"brain","params":{"query":"refactor the auth module to use JWT tokens"},"confidence":0.9}

Classify:`;
  }

  private parseResponse(content: string): RouterResult {
    try {
      const cleaned = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          intent: parsed.intent || "complex",
          category: parsed.category || "brain",
          params: parsed.params || {},
          confidence: parsed.confidence || 0.5,
        };
      }
    } catch { /* fallback below */ }

    return {
      intent: "complex",
      category: "brain",
      params: { query: content },
      confidence: 0.0,
    };
  }
}
```

- [ ] **Step 6: Update router factory**

```typescript
// src/router/index.ts
import type { RuntimeConfig } from "../config";
import type { Router } from "../types";
import type { LLMProvider } from "../backends/llm/provider";
import { LLMRouter } from "./llm-router";
import { FallbackRouter } from "./fallback-router";

export function createRouter(config: RuntimeConfig, llmProvider: LLMProvider): Router {
  return new FallbackRouter(
    new LLMRouter(llmProvider),
    config.phoneticAliases,
  );
}
```

- [ ] **Step 7: Update existing router tests**

In `tests/router.test.ts`, change `new LLMRouter(9999, "mock-model")` to use the provider:

```typescript
// At top of tests/router.test.ts, replace:
//   const mockLLM = new LLMRouter(9999, "mock-model");
// with:
import { MlxLmProvider } from "../src/backends/llm/mlx-lm";
const mockLLM = new LLMRouter(new MlxLmProvider({ port: 9999, model: "mock-model" }));
```

- [ ] **Step 8: Run all router tests to verify nothing broke**

Run: `bun test tests/router.test.ts tests/backends/mlx-lm.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/backends/llm/ src/router/ tests/backends/mlx-lm.test.ts tests/router.test.ts
git commit -m "feat: extract MlxLmProvider, wire into LLMRouter"
```

---

### Task 5: MLX TTS Provider (extract from TTSSpeaker)

**Files:**
- Create: `src/backends/tts/mlx-audio.ts`
- Create: `tests/backends/mlx-audio.test.ts`
- Modify: `src/speaker/tts-speaker.ts`
- Modify: `src/speaker/streaming-tts.ts`
- Modify: `src/speaker/index.ts`

- [ ] **Step 1: Write test for MlxAudioProvider**

```typescript
// tests/backends/mlx-audio.test.ts
import { test, expect, describe } from "bun:test";
import { MlxAudioProvider } from "../src/backends/tts/mlx-audio";

describe("MlxAudioProvider", () => {
  test("has correct name", () => {
    const provider = new MlxAudioProvider({
      port: 8082,
      model: "test-model",
      voice: "Ryan",
    });
    expect(provider.name).toBe("mlx-audio");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxAudioProvider({ port: 19997, model: "test-model" });
    const healthy = await provider.health();
    expect(healthy).toBe(false);
  });

  test("generateAudio throws when server is down", async () => {
    const provider = new MlxAudioProvider({ port: 19997, model: "test-model" });
    await expect(provider.generateAudio("hello")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backends/mlx-audio.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement MlxAudioProvider**

Extract from `src/speaker/tts-speaker.ts:70-99`:

```typescript
// src/backends/tts/mlx-audio.ts
import type { TTSProvider, TTSProviderConfig } from "./provider";

export class MlxAudioProvider implements TTSProvider {
  readonly name = "mlx-audio";
  private port: number;
  private model: string;
  private voice: string;
  private refAudio?: string;
  private refText?: string;

  constructor(config: TTSProviderConfig) {
    this.port = config.port ?? 8082;
    this.model = config.model ?? "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16";
    this.voice = config.voice ?? "Ryan";
    this.refAudio = config.refAudio;
    this.refText = config.refText;
  }

  async generateAudio(text: string): Promise<ArrayBuffer> {
    const payload: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: this.voice,
      response_format: "wav",
      speed: 1.0,
      lang_code: "en",
    };

    if (this.refAudio) {
      payload.ref_audio = this.refAudio;
      if (this.refText) {
        payload.ref_text = this.refText;
      }
    }

    const response = await fetch(`http://localhost:${this.port}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`TTS server returned ${response.status}: ${errText.substring(0, 200)}`);
    }

    return response.arrayBuffer();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backends/mlx-audio.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor TTSSpeaker to use TTSProvider + AudioPlayer**

Replace `src/speaker/tts-speaker.ts` — the constructor now takes a `TTSProvider` and `AudioPlayer` instead of port/model/voiceConfig. The `generateAudio` method delegates to the provider, `playAudio` delegates to the player:

```typescript
// src/speaker/tts-speaker.ts
import type { Speaker } from "../types";
import type { TTSProvider } from "../backends/tts/provider";
import type { AudioPlayer } from "../platform/audio";
import { log } from "../logger";

export class TTSSpeaker implements Speaker {
  private provider: TTSProvider;
  private audioPlayer: AudioPlayer;
  private fallback: Speaker;

  constructor(provider: TTSProvider, audioPlayer: AudioPlayer, fallback: Speaker) {
    this.provider = provider;
    this.audioPlayer = audioPlayer;
    this.fallback = fallback;
  }

  async speak(text: string): Promise<void> {
    try {
      if (!(await this.provider.health())) {
        log("warn", `${this.provider.name} unavailable, falling back`);
        return this.fallback.speak(text);
      }

      const sentences = this.splitSentences(text);
      if (sentences.length > 2 && text.length > 300) {
        await this.speakChunked(sentences);
      } else {
        await this.speakSingle(text);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `TTS failed, using fallback: ${msg}`);
      return this.fallback.speak(text);
    }
  }

  private async speakSingle(text: string): Promise<void> {
    const audioData = await this.generateAudio(text);
    log("info", `${this.provider.name}: ${audioData.byteLength} bytes`);
    await this.playAudio(audioData);
  }

  private async speakChunked(sentences: string[]): Promise<void> {
    log("info", `${this.provider.name}: chunked mode (${sentences.length} sentences)`);

    const firstAudio = await this.generateAudio(sentences[0]);
    const remaining = sentences.slice(1).join(" ");
    const [, restAudio] = await Promise.all([
      this.playAudio(firstAudio),
      remaining ? this.generateAudio(remaining) : Promise.resolve(null),
    ]);

    if (restAudio) {
      await this.playAudio(restAudio);
    }
  }

  async generateAudio(text: string): Promise<ArrayBuffer> {
    return this.provider.generateAudio(text);
  }

  async playAudio(audioData: ArrayBuffer): Promise<void> {
    const tmpFile = `/tmp/cicero-tts-${Date.now()}.wav`;
    await Bun.write(tmpFile, audioData);
    await this.audioPlayer.play(tmpFile);
    try { await Bun.spawn(["rm", tmpFile]).exited; } catch { /* cleanup */ }
  }

  private splitSentences(text: string): string[] {
    const parts = text.match(/[^.!?]+[.!?]+\s*/g);
    if (!parts || parts.length === 0) return [text];
    return parts.map(s => s.trim()).filter(s => s.length > 0);
  }

  async stop(): Promise<void> {
    this.audioPlayer.stopAll();
  }

  async health(): Promise<boolean> {
    return this.provider.health();
  }
}
```

- [ ] **Step 6: Refactor StreamingTTSSpeaker**

Update `src/speaker/streaming-tts.ts` to extend the new TTSSpeaker and use AudioPlayer for playback:

```typescript
// src/speaker/streaming-tts.ts
import { TTSSpeaker } from "./tts-speaker";
import type { TTSProvider } from "../backends/tts/provider";
import type { AudioPlayer } from "../platform/audio";
import type { Speaker } from "../types";
import { log } from "../logger";

export class StreamingTTSSpeaker extends TTSSpeaker {
  private interrupted = false;
  private currentPlayer: ReturnType<typeof Bun.spawn> | null = null;
  private playing = false;
  private _audioPlayer: AudioPlayer;

  constructor(provider: TTSProvider, audioPlayer: AudioPlayer, fallback: Speaker) {
    super(provider, audioPlayer, fallback);
    this._audioPlayer = audioPlayer;
  }

  async speakStream(sentences: AsyncIterable<string>): Promise<void> {
    this.interrupted = false;
    this.playing = true;

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

          pendingAudio = this.generateAudioSafe(trimmed);
          pendingText = trimmed;

          await this.playAudioInterruptible(audio);
          if (this.interrupted) break;
        } else {
          pendingAudio = this.generateAudioSafe(trimmed);
          pendingText = trimmed;
        }
      }

      if (pendingAudio && !this.interrupted) {
        const audio = await pendingAudio;
        if (!this.interrupted) {
          await this.playAudioInterruptible(audio);
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

  interrupt(): void {
    this.interrupted = true;
    if (this.currentPlayer) {
      try { this.currentPlayer.kill(); } catch { /* already dead */ }
      this.currentPlayer = null;
    }
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private async generateAudioSafe(text: string): Promise<ArrayBuffer> {
    try {
      return await this.generateAudio(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `TTS generation failed for "${text.substring(0, 30)}...": ${msg}`);
      return new ArrayBuffer(0);
    }
  }

  private async playAudioInterruptible(audioData: ArrayBuffer): Promise<void> {
    if (audioData.byteLength === 0) return;

    const tmpFile = `/tmp/cicero-stream-${Date.now()}.wav`;
    await Bun.write(tmpFile, audioData);

    // Use platform player but keep reference for interrupt
    const player = Bun.spawn(
      process.platform === "darwin" ? ["afplay", tmpFile] :
      process.platform === "win32" ? ["ffplay", "-nodisp", "-autoexit", "-audio_buffer_size", "64", tmpFile] :
      ["aplay", tmpFile],
      { stdout: "ignore", stderr: "ignore" },
    );
    this.currentPlayer = player;
    await player.exited;
    this.currentPlayer = null;

    try { await Bun.spawn(["rm", tmpFile]).exited; } catch { /* cleanup */ }
  }
}
```

- [ ] **Step 7: Update speaker factory**

```typescript
// src/speaker/index.ts
import type { RuntimeConfig } from "../config";
import type { Speaker } from "../types";
import type { TTSProvider } from "../backends/tts/provider";
import type { AudioPlayer } from "../platform/audio";
import { TTSSpeaker } from "./tts-speaker";
import { StreamingTTSSpeaker } from "./streaming-tts";
import { SaySpeaker } from "./say-speaker";
import { SilentSpeaker } from "./silent-speaker";

export function createSpeaker(config: RuntimeConfig, ttsProvider: TTSProvider, audioPlayer: AudioPlayer): Speaker {
  if (!config.ttsEnabled) return new SilentSpeaker();
  return new TTSSpeaker(ttsProvider, audioPlayer, new SaySpeaker());
}

export function createStreamingSpeaker(
  config: RuntimeConfig,
  ttsProvider: TTSProvider,
  audioPlayer: AudioPlayer,
): StreamingTTSSpeaker | null {
  if (!config.ttsEnabled) return null;
  return new StreamingTTSSpeaker(ttsProvider, audioPlayer, new SaySpeaker());
}
```

- [ ] **Step 8: Run existing speaker tests**

Run: `bun test tests/speaker.test.ts`
Expected: PASS (adjust test if it instantiates TTSSpeaker directly)

- [ ] **Step 9: Commit**

```bash
git add src/backends/tts/ src/speaker/ src/platform/ tests/backends/mlx-audio.test.ts
git commit -m "feat: extract MlxAudioProvider, refactor TTSSpeaker to use provider + player"
```

---

### Task 6: MLX STT Provider (extract from ConversationalListener)

**Files:**
- Create: `src/backends/stt/mlx-whisper.ts`
- Create: `tests/backends/mlx-whisper.test.ts`
- Modify: `src/listener/conversational.ts`
- Modify: `src/listener/index.ts`

- [ ] **Step 1: Write test for MlxWhisperProvider**

```typescript
// tests/backends/mlx-whisper.test.ts
import { test, expect, describe } from "bun:test";
import { MlxWhisperProvider } from "../src/backends/stt/mlx-whisper";

describe("MlxWhisperProvider", () => {
  test("has correct name", () => {
    const provider = new MlxWhisperProvider({ port: 8083 });
    expect(provider.name).toBe("mlx-whisper");
  });

  test("health returns false when server is down", async () => {
    const provider = new MlxWhisperProvider({ port: 19996 });
    const healthy = await provider.health();
    expect(healthy).toBe(false);
  });

  test("transcribe returns null when server is down", async () => {
    const provider = new MlxWhisperProvider({ port: 19996 });
    const result = await provider.transcribe("/tmp/nonexistent.wav");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/backends/mlx-whisper.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement MlxWhisperProvider**

Extract from `src/listener/conversational.ts:252-284`:

```typescript
// src/backends/stt/mlx-whisper.ts
import type { STTProvider, STTProviderConfig } from "./provider";
import { log } from "../../logger";

export class MlxWhisperProvider implements STTProvider {
  readonly name = "mlx-whisper";
  private port: number;

  constructor(config: STTProviderConfig) {
    this.port = config.port ?? 8083;
  }

  async transcribe(audioFile: string): Promise<string | null> {
    try {
      const file = Bun.file(audioFile);
      const formData = new FormData();
      formData.append("file", file, "audio.wav");
      formData.append("response_format", "json");

      const res = await fetch(`http://localhost:${this.port}/inference`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        log("warn", `Whisper server returned ${res.status}`);
        return null;
      }

      const data = await res.json() as { text?: string };
      const raw = data.text ?? "";

      const text = raw
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .trim();

      if (!text || text.length < 2) return null;

      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `Transcription failed: ${msg}`);
      return null;
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/backends/mlx-whisper.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor ConversationalListener to use STTProvider + AudioRecorder + AudioPlayer**

Update `src/listener/conversational.ts` constructor to accept providers. Replace inline `transcribe()` with `this.sttProvider.transcribe()`, inline `recordUntilSilence()` sox command with `this.recorder.record()`, and inline `afplay` with `this.audioPlayer.play()`:

The key changes (showing the constructor and changed methods only — listen loop logic is unchanged):

```typescript
// In src/listener/conversational.ts, update the constructor and injection:
import type { STTProvider } from "../backends/stt/provider";
import type { AudioPlayer, AudioRecorder, RecordOpts } from "../platform/audio";

export class ConversationalListener implements Listener {
  private callback?: (text: string) => void;
  private bargeInCallback?: () => void;
  private active = false;
  private listening = false;
  private sttProvider: STTProvider;
  private recorder: AudioRecorder;
  private audioPlayer: AudioPlayer;
  private audioDir: string;
  private currentRecording: ReturnType<typeof Bun.spawn> | null = null;
  private assetsDir: string;
  private processing = false;
  private bargeInEnabled = false;
  private silenceDuration: string;
  private silenceThreshold: string;

  constructor(
    sttProvider: STTProvider,
    recorder: AudioRecorder,
    audioPlayer: AudioPlayer,
    bargeInEnabled = false,
    silenceDuration = "1.5",
    silenceThreshold = "3%",
  ) {
    const home = process.env.HOME || "~";
    this.sttProvider = sttProvider;
    this.recorder = recorder;
    this.audioPlayer = audioPlayer;
    this.audioDir = join(home, ".cicero", "tmp");
    this.bargeInEnabled = bargeInEnabled;
    this.silenceDuration = silenceDuration;
    this.silenceThreshold = silenceThreshold;
    this.assetsDir = join(dirname(dirname(import.meta.dir)), "assets");
  }
  // ... rest of class unchanged, except:
  // - transcribe() calls this.sttProvider.transcribe(audioFile) instead of inline fetch
  // - recordUntilSilence() uses this.recorder.record() instead of inline Bun.spawn
  // - playSound() uses this.audioPlayer.play() instead of Bun.spawn(["afplay",...])
```

Replace the `transcribe` method body with:
```typescript
  private async transcribe(audioFile: string): Promise<string | null> {
    return this.sttProvider.transcribe(audioFile);
  }
```

Replace the `recordUntilSilence` sox spawn with:
```typescript
    const proc = this.recorder.record(audioFile, {
      sampleRate: 16000,
      silenceDuration: this.silenceDuration,
      silenceThreshold: this.silenceThreshold,
      maxDuration: 30,
    });
```

Replace `playSound` body with:
```typescript
  playSound(name: "activate" | "deactivate" | "ready" | "error" | "success" | "thinking"): void {
    const file = join(this.assetsDir, `${name}.wav`);
    // Fire-and-forget
    this.audioPlayer.play(file).catch(() => {});
  }
```

Replace `detectBargeIn` sox spawn similarly, using `this.recorder.record()` with barge-in specific opts (`silenceThreshold: "5%"`, `silenceDuration: "0.8"`, `maxDuration: 10`).

- [ ] **Step 6: Update listener factory**

```typescript
// src/listener/index.ts
import type { RuntimeConfig } from "../config";
import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioPlayer, AudioRecorder } from "../platform/audio";
import { StdinListener } from "./stdin";
import { WisprFlowListener } from "./wispr-flow";
import { ConversationalListener } from "./conversational";

export function createListener(config: RuntimeConfig): Listener {
  if (config.wakeWordEnabled) {
    return new WisprFlowListener(config.wisprHotkey);
  }
  return new StdinListener();
}

export function createConversationalListener(
  config: RuntimeConfig,
  sttProvider: STTProvider,
  recorder: AudioRecorder,
  audioPlayer: AudioPlayer,
): ConversationalListener {
  return new ConversationalListener(
    sttProvider,
    recorder,
    audioPlayer,
    config.bargeInEnabled,
    config.silenceDuration,
    config.silenceThreshold,
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/backends/stt/ src/listener/ tests/backends/mlx-whisper.test.ts
git commit -m "feat: extract MlxWhisperProvider, refactor ConversationalListener"
```

---

### Task 7: Config, Tiers, and Registry

**Files:**
- Create: `src/backends/tiers.ts`
- Create: `src/backends/registry.ts`
- Create: `tests/backends/registry.test.ts`
- Create: `tests/config-tiers.test.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Add backend config types to types.ts**

Add to `src/types.ts` after existing types:

```typescript
// Backend config types
export interface BackendConfig {
  backend?: string;
  port?: number;
  model?: string;
  [key: string]: unknown;
}

// Extend CiceroConfig
// Add these optional fields to the CiceroConfig interface:
//   deployment?: string;
//   stt?: BackendConfig;
//   tts?: BackendConfig & { voice?: string; refAudio?: string; refText?: string };
//   llm?: BackendConfig;
```

Extend the terminal type union in `CiceroConfig`:
```typescript
  terminal: "kitty" | "iterm2" | "wezterm" | "tmux";
```

- [ ] **Step 2: Create tier presets**

```typescript
// src/backends/tiers.ts
export interface TierConfig {
  stt?: Record<string, unknown>;
  tts?: Record<string, unknown>;
  llm?: Record<string, unknown>;
  terminal?: string;
}

export const TIER_PRESETS: Record<string, TierConfig> = {
  "local-mlx": {
    stt:      { backend: "mlx-whisper" },
    tts:      { backend: "mlx-audio" },
    llm:      { backend: "mlx-lm" },
    terminal: "kitty",
  },
  "local-cuda": {
    stt:      { backend: "faster-whisper", port: 8083, model: "Systran/faster-whisper-large-v3-turbo" },
    tts:      { backend: "kokoro", port: 8082 },
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "local-cpu": {
    stt:      { backend: "moonshine", model: "moonshine-v2-medium" },
    tts:      { backend: "kokoro" },
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "hybrid": {
    stt:      { backend: "deepgram" },
    tts:      { backend: "luxtts", port: 8082 },
    llm:      { backend: "ollama", port: 11434, model: "qwen3:1.7b" },
    terminal: "tmux",
  },
  "cloud": {
    stt:      { backend: "deepgram" },
    tts:      { backend: "elevenlabs" },
    llm:      { backend: "claude-api" },
    terminal: "tmux",
  },
};
```

- [ ] **Step 3: Write test for tier expansion in config**

```typescript
// tests/config-tiers.test.ts
import { test, expect, describe } from "bun:test";
import { TIER_PRESETS } from "../src/backends/tiers";

describe("tier presets", () => {
  test("local-mlx preset has all three backends", () => {
    const tier = TIER_PRESETS["local-mlx"];
    expect(tier.stt).toBeDefined();
    expect(tier.tts).toBeDefined();
    expect(tier.llm).toBeDefined();
    expect((tier.stt as Record<string, unknown>).backend).toBe("mlx-whisper");
    expect((tier.tts as Record<string, unknown>).backend).toBe("mlx-audio");
    expect((tier.llm as Record<string, unknown>).backend).toBe("mlx-lm");
  });

  test("local-cuda preset uses CUDA backends", () => {
    const tier = TIER_PRESETS["local-cuda"];
    expect((tier.stt as Record<string, unknown>).backend).toBe("faster-whisper");
    expect((tier.tts as Record<string, unknown>).backend).toBe("luxtts");
    expect((tier.llm as Record<string, unknown>).backend).toBe("ollama");
    expect(tier.terminal).toBe("tmux");
  });
});
```

- [ ] **Step 4: Write test for registry**

```typescript
// tests/backends/registry.test.ts
import { test, expect, describe } from "bun:test";
import { createProviders } from "../src/backends/registry";
import { loadConfig } from "../src/config";

describe("createProviders", () => {
  test("returns MLX providers by default (no config changes)", () => {
    const config = loadConfig();
    const providers = createProviders(config);
    expect(providers.stt.name).toBe("mlx-whisper");
    expect(providers.tts.name).toBe("mlx-audio");
    expect(providers.llm.name).toBe("mlx-lm");
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `bun test tests/config-tiers.test.ts tests/backends/registry.test.ts`
Expected: FAIL — modules don't exist yet

- [ ] **Step 6: Create registry**

```typescript
// src/backends/registry.ts
import type { RuntimeConfig } from "../config";
import type { STTProvider } from "./stt/provider";
import type { TTSProvider } from "./tts/provider";
import type { LLMProvider } from "./llm/provider";
import { MlxWhisperProvider } from "./stt/mlx-whisper";
import { MlxAudioProvider } from "./tts/mlx-audio";
import { MlxLmProvider } from "./llm/mlx-lm";

export interface BackendProviders {
  stt: STTProvider;
  tts: TTSProvider;
  llm: LLMProvider;
}

export function createProviders(config: RuntimeConfig): BackendProviders {
  return {
    stt: createSTTProvider(config),
    tts: createTTSProvider(config),
    llm: createLLMProvider(config),
  };
}

function createSTTProvider(config: RuntimeConfig): STTProvider {
  const sttConfig = config.sttBackend;
  switch (sttConfig.backend) {
    case "mlx-whisper":
      return new MlxWhisperProvider(sttConfig);
    case "faster-whisper":
    case "nemotron":
    case "moonshine":
    case "deepgram":
      throw new Error(`STT backend '${sttConfig.backend}' not yet implemented`);
    default:
      return new MlxWhisperProvider(sttConfig);
  }
}

function createTTSProvider(config: RuntimeConfig): TTSProvider {
  const ttsConfig = config.ttsBackend;
  switch (ttsConfig.backend) {
    case "mlx-audio":
      return new MlxAudioProvider(ttsConfig);
    case "kokoro":
    case "vibevoice":
    case "omnivoice":
    case "pocket-tts":
    case "elevenlabs":
    case "voxtral":
      throw new Error(`TTS backend '${ttsConfig.backend}' not yet implemented`);
    default:
      return new MlxAudioProvider(ttsConfig);
  }
}

function createLLMProvider(config: RuntimeConfig): LLMProvider {
  const llmConfig = config.llmBackend;
  switch (llmConfig.backend) {
    case "mlx-lm":
      return new MlxLmProvider(llmConfig);
    case "ollama":
    case "claude-api":
      throw new Error(`LLM backend '${llmConfig.backend}' not yet implemented`);
    default:
      return new MlxLmProvider(llmConfig);
  }
}
```

- [ ] **Step 7: Add backend config accessors to RuntimeConfig**

In `src/config.ts`, add these getters to the `RuntimeConfig` class:

```typescript
  get sttBackend(): STTProviderConfig {
    const raw = this.config as Record<string, unknown>;
    if (raw.stt && typeof raw.stt === "object") {
      return raw.stt as STTProviderConfig;
    }
    // Backward compat: derive from legacy servers config
    return {
      backend: "mlx-whisper",
      port: this.config.servers.stt.port,
      model: this.config.servers.stt.model,
    };
  }

  get ttsBackend(): TTSProviderConfig {
    const raw = this.config as Record<string, unknown>;
    if (raw.tts && typeof raw.tts === "object") {
      return raw.tts as TTSProviderConfig;
    }
    return {
      backend: "mlx-audio",
      port: this.config.servers.tts.port,
      model: this.config.servers.tts.model,
      voice: this.config.voice === "default" ? "Ryan" : this.config.voice,
      refAudio: this.config.voice_ref_audio,
      refText: this.config.voice_ref_text,
    };
  }

  get llmBackend(): LLMProviderConfig {
    const raw = this.config as Record<string, unknown>;
    if (raw.llm && typeof raw.llm === "object") {
      return raw.llm as LLMProviderConfig;
    }
    return {
      backend: "mlx-lm",
      port: this.config.servers.router.port,
      model: this.config.servers.router.model,
    };
  }
```

Add tier expansion at the top of `loadConfig()`, after parsing the YAML but before CLI flag overrides:

```typescript
  // Tier expansion: if deployment key exists, expand preset
  if (config.deployment) {
    const { TIER_PRESETS } = require("./backends/tiers");
    const tier = TIER_PRESETS[config.deployment as string];
    if (tier) {
      if (tier.stt && !(config as any).stt) (config as any).stt = tier.stt;
      if (tier.tts && !(config as any).tts) (config as any).tts = tier.tts;
      if (tier.llm && !(config as any).llm) (config as any).llm = tier.llm;
      if (tier.terminal && !config.terminal) config.terminal = tier.terminal;
    }
  }
```

Import types at top of `src/config.ts`:
```typescript
import type { STTProviderConfig } from "./backends/stt/provider";
import type { TTSProviderConfig } from "./backends/tts/provider";
import type { LLMProviderConfig } from "./backends/llm/provider";
```

- [ ] **Step 8: Run tests**

Run: `bun test tests/config-tiers.test.ts tests/backends/registry.test.ts tests/config.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/backends/tiers.ts src/backends/registry.ts src/types.ts src/config.ts tests/
git commit -m "feat: add registry, tier presets, backward-compatible config"
```

---

### Task 8: Wire Everything Into Daemon + Refactor ServerManager

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/servers/index.ts`

- [ ] **Step 1: Refactor ServerManager to use providers**

```typescript
// src/servers/index.ts
import type { BackendProviders } from "../backends/registry";
import { log } from "../logger";

export class ServerManager {
  async start(providers: BackendProviders): Promise<void> {
    // Start in order: LLM first (router depends on it), then TTS, then STT
    for (const [name, provider] of [
      ["llm", providers.llm],
      ["tts", providers.tts],
      ["stt", providers.stt],
    ] as const) {
      if (provider.start) {
        try {
          await provider.start();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log("warn", `${name} provider failed to start: ${msg}`);
        }
      }
    }
  }

  async stop(providers: BackendProviders): Promise<void> {
    for (const provider of [providers.stt, providers.tts, providers.llm]) {
      if (provider.stop) {
        try {
          await provider.stop();
        } catch { /* best effort */ }
      }
    }
  }

  getStatus(providers: BackendProviders): { name: string; healthy: boolean }[] {
    return [
      { name: providers.llm.name, healthy: false },
      { name: providers.tts.name, healthy: false },
      { name: providers.stt.name, healthy: false },
    ];
  }
}
```

- [ ] **Step 2: Wire providers into daemon.ts**

Key changes to `src/daemon.ts` (showing the modified `start()` and `summarizeForTTS()` methods):

Add imports at top:
```typescript
import { createProviders, type BackendProviders } from "./backends/registry";
import { createAudioPlayer, createAudioRecorder } from "./platform/audio";
```

Add field to class:
```typescript
  private providers!: BackendProviders;
```

In `start()`, replace component initialization (Step 2 area):

```typescript
    // Step 1: Create providers from config
    this.providers = createProviders(this.config);
    const audioPlayer = createAudioPlayer();
    const audioRecorder = createAudioRecorder();

    // Step 2: Start model servers via providers
    if (this.options.skipServers) {
      logStep(1, totalSteps, "Skipping model servers (--no-servers)");
    } else {
      logStep(1, totalSteps, "Starting model servers...");
      this.servers = new ServerManager();
      await this.servers.start(this.providers);
    }

    // Step 3: Initialize components (using providers)
    logStep(2, totalSteps, "Initializing components...");
    this.terminal = createTerminalAdapter(this.config);
    this.router = createRouter(this.config, this.providers.llm);
    this.brain = createBrain(this.config, this.terminal);
    this.speaker = createSpeaker(this.config, this.providers.tts, audioPlayer);
    this.executor = new ActionExecutor(this.config, this.terminal, this.brain, this.speaker, this.contextStore);
    this.streamingSpeaker = createStreamingSpeaker(this.config, this.providers.tts, audioPlayer);

    // ... rest of start() unchanged except:
    // Step 4: conversational listener uses providers
    this.conversational = createConversationalListener(this.config, this.providers.stt, audioRecorder, audioPlayer);
```

Update `stop()` to use providers:
```typescript
    if (this.servers) await this.servers.stop(this.providers);
```

Update `summarizeForTTS()` to use LLM provider instead of direct fetch:

```typescript
  private async summarizeForTTS(output: string): Promise<string> {
    if (output.length < 200) return output;

    const truncated = output.length > 2000
      ? output.substring(0, 1000) + "\n...\n" + output.substring(output.length - 800)
      : output;

    try {
      const raw = await this.providers.llm.chatCompletion(
        [
          {
            role: "system",
            content: "/no_think\nYou summarize AI assistant outputs for text-to-speech. Give a 1-3 sentence TLDR of what was done or answered. Be conversational and natural. No markdown, no code, no file paths.",
          },
          {
            role: "user",
            content: `Summarize this response for a voice assistant to read aloud:\n\n${truncated}`,
          },
        ],
        { temperature: 0.3, max_tokens: this.config.ttsSummaryMaxTokens },
      );

      const summary = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (summary) return summary;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `TTS summary failed: ${msg}`);
    }

    const lastLine = output.split("\n")
      .filter(l => l.trim() && !l.startsWith("```") && !l.startsWith("  "))
      .pop();
    return lastLine?.substring(0, 300) ?? "Done.";
  }
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: ALL PASS — no behavior change for Mac users with default config

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts src/servers/index.ts
git commit -m "feat: wire providers into daemon, simplify ServerManager"
```

---

### Task 9: tmux Terminal Adapter

**Files:**
- Create: `src/terminal/tmux.ts`
- Create: `tests/terminal/tmux.test.ts`
- Modify: `src/terminal/index.ts`

- [ ] **Step 1: Write test for tmux adapter**

```typescript
// tests/terminal/tmux.test.ts
import { test, expect, describe } from "bun:test";
import { TmuxAdapter } from "../src/terminal/tmux";
import type { Tab } from "../src/types";

describe("TmuxAdapter", () => {
  test("parseTmuxOutput parses tab list correctly", () => {
    const adapter = new TmuxAdapter();
    // Test the parser with mock tmux output
    const raw = "1\tcode\t1\t/home/user/project\n2\tbrain\t0\t/home/user\n";
    const tabs = adapter.parseTmuxOutput(raw);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].title).toBe("code");
    expect(tabs[0].is_focused).toBe(true);
    expect(tabs[1].title).toBe("brain");
    expect(tabs[1].is_focused).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/terminal/tmux.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tmux adapter**

```typescript
// src/terminal/tmux.ts
import type { TerminalAdapter, Tab } from "../types";

export class TmuxAdapter implements TerminalAdapter {
  async listTabs(): Promise<Tab[]> {
    const proc = Bun.spawn(
      ["tmux", "list-windows", "-F", "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return this.parseTmuxOutput(output);
  }

  parseTmuxOutput(raw: string): Tab[] {
    return raw.trim().split("\n").filter(Boolean).map((line, idx) => {
      const [id, name, active, cwd] = line.split("\t");
      return {
        id: parseInt(id?.replace("@", "") ?? String(idx), 10),
        window_id: parseInt(id?.replace("@", "") ?? String(idx), 10),
        title: name ?? "",
        is_focused: active === "1",
        cwd: cwd ?? undefined,
      };
    });
  }

  async focusTab(nameOrId: string): Promise<void> {
    const proc = Bun.spawn(
      ["tmux", "select-window", "-t", `:${nameOrId}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
  }

  async sendText(tab: string, text: string): Promise<void> {
    const proc = Bun.spawn(
      ["tmux", "send-keys", "-t", `:${tab}`, text, "Enter"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
  }

  async sendKey(tab: string, key: string): Promise<void> {
    const proc = Bun.spawn(
      ["tmux", "send-keys", "-t", `:${tab}`, key],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
  }

  async getText(tab: string, extent?: "screen" | "all" | "last_cmd_output"): Promise<string> {
    const args = ["tmux", "capture-pane", "-t", `:${tab}`, "-p"];
    if (extent === "all") {
      args.push("-S", "-");
    }
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/terminal/tmux.test.ts`
Expected: PASS

- [ ] **Step 5: Update terminal factory**

```typescript
// src/terminal/index.ts
import type { RuntimeConfig } from "../config";
import type { TerminalAdapter } from "../types";
import { KittyAdapter } from "./kitty";
import { TmuxAdapter } from "./tmux";

export function createTerminalAdapter(config: RuntimeConfig): TerminalAdapter {
  switch (config.terminal) {
    case "kitty":
      return new KittyAdapter();
    case "tmux":
      return new TmuxAdapter();
    case "wezterm":
      throw new Error("WezTerm adapter not yet implemented");
    default:
      // Platform-aware default
      if (process.platform === "win32") return new TmuxAdapter();
      return new KittyAdapter();
  }
}
```

- [ ] **Step 6: Run existing terminal tests**

Run: `bun test tests/terminal.test.ts tests/terminal/tmux.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/terminal/ tests/terminal/
git commit -m "feat: add tmux terminal adapter for cross-platform support"
```

---

## Phase 2: CUDA Backends (new implementations)

### Task 10: Ollama LLM Provider

**Files:**
- Create: `src/backends/llm/ollama.ts`
- Modify: `src/backends/registry.ts`

- [ ] **Step 1: Implement Ollama provider**

```typescript
// src/backends/llm/ollama.ts
import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private port: number;
  private model: string;
  private managed: ManagedProcess | null = null;

  constructor(config: LLMProviderConfig) {
    this.port = config.port ?? 11434;
    this.model = config.model ?? "qwen3:1.7b";
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: opts?.temperature ?? 0.0,
        num_predict: opts?.max_tokens ?? 100,
      },
    };

    // JSON schema constraint — Ollama's XGrammar ensures 100% compliance
    if (opts?.responseFormat) {
      body.format = opts.responseFormat.json_schema;
    }

    const response = await fetch(`http://localhost:${this.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.managed = await startManagedServer({
      name: "ollama",
      port: this.port,
      command: ["ollama", "serve"],
      healthUrl: `http://localhost:${this.port}/api/tags`,
      timeoutMs: 30000,
    });
  }

  async stop(): Promise<void> {
    if (this.managed) {
      await stopManagedServer(this.managed);
      this.managed = null;
    }
  }
}
```

- [ ] **Step 2: Register in registry**

In `src/backends/registry.ts`, add import and case:

```typescript
import { OllamaProvider } from "./llm/ollama";

// In createLLMProvider, replace the throw:
    case "ollama":
      return new OllamaProvider(llmConfig);
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/llm/ollama.ts src/backends/registry.ts
git commit -m "feat: add Ollama LLM provider with JSON schema support"
```

---

### Task 11: faster-whisper STT Provider

**Files:**
- Create: `src/backends/stt/faster-whisper.ts`
- Modify: `src/backends/registry.ts`

- [ ] **Step 1: Implement faster-whisper provider**

```typescript
// src/backends/stt/faster-whisper.ts
import type { STTProvider, STTProviderConfig } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { log } from "../../logger";

export class FasterWhisperProvider implements STTProvider {
  readonly name = "faster-whisper";
  private port: number;
  private model: string;
  private managed: ManagedProcess | null = null;

  constructor(config: STTProviderConfig) {
    this.port = config.port ?? 8083;
    this.model = config.model ?? "Systran/faster-whisper-large-v3-turbo";
  }

  async transcribe(audioFile: string): Promise<string | null> {
    try {
      const file = Bun.file(audioFile);
      const formData = new FormData();
      formData.append("file", file, "audio.wav");
      formData.append("model", this.model);
      formData.append("response_format", "json");

      const res = await fetch(`http://localhost:${this.port}/v1/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        log("warn", `faster-whisper returned ${res.status}`);
        return null;
      }

      const data = await res.json() as { text?: string };
      const text = (data.text ?? "").trim();
      if (!text || text.length < 2) return null;

      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `faster-whisper transcription failed: ${msg}`);
      return null;
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.managed = await startManagedServer({
      name: "faster-whisper",
      port: this.port,
      command: ["faster-whisper-server", "--model", this.model, "--port", this.port.toString()],
      healthUrl: `http://localhost:${this.port}/health`,
      timeoutMs: 120000, // model download can be slow
    });
  }

  async stop(): Promise<void> {
    if (this.managed) {
      await stopManagedServer(this.managed);
      this.managed = null;
    }
  }
}
```

- [ ] **Step 2: Register in registry**

In `src/backends/registry.ts`, add import and case:

```typescript
import { FasterWhisperProvider } from "./stt/faster-whisper";

// In createSTTProvider, replace the throw:
    case "faster-whisper":
      return new FasterWhisperProvider(sttConfig);
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/stt/faster-whisper.ts src/backends/registry.ts
git commit -m "feat: add faster-whisper STT provider for CUDA"
```

---

### Task 12: Kokoro TTS Provider

**Files:**
- Create: `src/backends/tts/kokoro.ts`
- Modify: `src/backends/registry.ts`

- [ ] **Step 1: Implement Kokoro provider**

Kokoro-FastAPI exposes an OpenAI-compatible `/v1/audio/speech` endpoint:

```typescript
// src/backends/tts/kokoro.ts
import type { TTSProvider, TTSProviderConfig } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";

export class KokoroProvider implements TTSProvider {
  readonly name = "kokoro";
  private port: number;
  private voice: string;
  private managed: ManagedProcess | null = null;

  constructor(config: TTSProviderConfig) {
    this.port = config.port ?? 8082;
    this.voice = config.voice ?? "am_onyx"; // deep/authoritative Jarvis-like default
  }

  async generateAudio(text: string): Promise<ArrayBuffer> {
    const response = await fetch(`http://localhost:${this.port}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        voice: this.voice,
        response_format: "wav",
        speed: 1.0,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Kokoro returned ${response.status}: ${errText.substring(0, 200)}`);
    }

    return response.arrayBuffer();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/v1/audio/speech`, { method: "OPTIONS" }).catch(() => null);
      if (res?.ok) return true;
      // Fallback: try a lightweight endpoint
      const res2 = await fetch(`http://localhost:${this.port}/v1/models`);
      return res2.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.managed = await startManagedServer({
      name: "kokoro",
      port: this.port,
      command: ["python3", "-m", "kokoro_fastapi", "--port", this.port.toString()],
      healthUrl: `http://localhost:${this.port}/v1/models`,
      timeoutMs: 60000,
    });
  }

  async stop(): Promise<void> {
    if (this.managed) {
      await stopManagedServer(this.managed);
      this.managed = null;
    }
  }
}
```

- [ ] **Step 2: Register in registry**

In `src/backends/registry.ts`, add import and case:

```typescript
import { KokoroProvider } from "./tts/kokoro";

// In createTTSProvider, replace the throw for kokoro:
    case "kokoro":
      return new KokoroProvider(ttsConfig);
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/tts/kokoro.ts src/backends/registry.ts
git commit -m "feat: add Kokoro TTS provider — #1 TTS Arena, OpenAI-compat"
```

---

### Task 12b: VibeVoice-Realtime TTS Provider (cloning option)

**Files:**
- Create: `src/backends/tts/vibevoice.ts`
- Modify: `src/backends/registry.ts`

- [ ] **Step 1: Implement VibeVoice-Realtime provider**

Uses the marhensa/vibevoice-realtime-openai-api server which exposes OpenAI-compat `/v1/audio/speech`:

```typescript
// src/backends/tts/vibevoice.ts
import type { TTSProvider, TTSProviderConfig } from "./provider";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";

export class VibeVoiceProvider implements TTSProvider {
  readonly name = "vibevoice";
  private port: number;
  private voice: string;
  private refAudio?: string;
  private managed: ManagedProcess | null = null;

  constructor(config: TTSProviderConfig) {
    this.port = config.port ?? 8082;
    this.voice = config.voice ?? "default";
    this.refAudio = config.refAudio;
  }

  async generateAudio(text: string): Promise<ArrayBuffer> {
    const payload: Record<string, unknown> = {
      input: text,
      voice: this.voice,
      response_format: "wav",
    };

    if (this.refAudio) {
      payload.ref_audio = this.refAudio;
    }

    const response = await fetch(`http://localhost:${this.port}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`VibeVoice returned ${response.status}: ${errText.substring(0, 200)}`);
    }

    return response.arrayBuffer();
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.managed = await startManagedServer({
      name: "vibevoice",
      port: this.port,
      command: ["python3", "-m", "vibevoice_api", "--port", this.port.toString()],
      healthUrl: `http://localhost:${this.port}/v1/models`,
      timeoutMs: 60000,
    });
  }

  async stop(): Promise<void> {
    if (this.managed) {
      await stopManagedServer(this.managed);
      this.managed = null;
    }
  }
}
```

- [ ] **Step 2: Register in registry**

In `src/backends/registry.ts`, add import and case:

```typescript
import { VibeVoiceProvider } from "./tts/vibevoice";

// In createTTSProvider:
    case "vibevoice":
      return new VibeVoiceProvider(ttsConfig);
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/tts/vibevoice.ts src/backends/registry.ts
git commit -m "feat: add VibeVoice-Realtime TTS provider with zero-shot cloning"
```

---

### Task 13: Final Integration Test

**Files:**
- Run all tests

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 2: Verify backward compatibility manually**

Ensure no `stt`/`tts`/`llm` fields in `~/.cicero/config.yaml` → should resolve to MLX providers via the legacy `servers.*` fallback path.

Run: `bun run src/index.ts start --no-servers` (dry run — verifies providers are created without starting servers)

- [ ] **Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "feat: backend abstraction complete — Phase 1 + 2"
```
