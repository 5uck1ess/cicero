# Plan H — Sidecar / SpeakAdapter Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidecar mode to Cicero that speaks summarized agent responses regardless of which coding agent the user runs (Claude Code, Codex CLI, Gemini CLI, OpenWebUI, Ollama, any CLI in a terminal). Two adapters ship in v1: a Claude Code native-hook adapter and a universal terminal-output-scraping adapter.

**Architecture:** Symmetric with existing provider registries (`Brain`, `STTProvider`, `TTSProvider`). New `SpeakAdapter` interface captures agent response events from a specific surface; adapters call a shared `SpeakService` that summarizes the text (extracting the logic currently inlined at `daemon.ts:400 summarizeForTTS`) and pipes it through the existing TTS speaker. Daemon mode is unaffected — sidecar is purely additive.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `Bun.serve` for the hook HTTP receiver, `Bun.spawn` for managed-server bootstrap. Reuses existing `LLMProvider`, `TTSProvider`, `Speaker`, `TerminalAdapter`. No new deps.

**Scope:**
- In: SpeakAdapter interface, registry, SpeakService (shared summarize+speak core), ClaudeCodeHookAdapter (HTTP receiver), TerminalScrapeAdapter (poll-and-detect), `cicero hook` and `cicero scrape` CLI subcommands, hook installer helper for Claude Code, user-facing docs.
- Out: Codex / Gemini / OpenWebUI native adapters (terminal-scrape fallback covers them in v1; add native adapters in follow-up plans when there's demand). Drive-away/multi-device transport.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/summarizer.ts` | NEW | Extracted `summarizeForTTS(text, llm, opts)` standalone function. Pure logic, no class. |
| `src/sidecar/types.ts` | NEW | `SpeakAdapter`, `SpeakService`, `SpeakRequest` interfaces. |
| `src/sidecar/service.ts` | NEW | `SpeakService` class: wraps summarizer + TTS provider + Speaker. Single entry point for adapters. |
| `src/sidecar/registry.ts` | NEW | `createSpeakAdapter(config)` factory. |
| `src/sidecar/claude-code-hook.ts` | NEW | `ClaudeCodeHookAdapter`: runs an HTTP server on port 8084, POST `/speak` triggers `SpeakService.speak()`. |
| `src/sidecar/terminal-scrape.ts` | NEW | `TerminalScrapeAdapter`: polls `TerminalAdapter.getText()`, detects new agent responses, calls `SpeakService.speak()`. |
| `src/sidecar/install-claude-code-hook.ts` | NEW | Helper that writes/updates `~/.claude/settings.json` to register Cicero as a `Stop` hook. |
| `src/daemon.ts` | MODIFY | Replace inline `summarizeForTTS` (lines 396-440) with import from `src/summarizer.ts`. Behavior identical. |
| `src/index.ts` | MODIFY | Add `cicero hook` and `cicero scrape <tab>` subcommands. |
| `src/types.ts` | MODIFY | Add `SidecarConfig` interface; extend `RuntimeConfig` with optional `sidecar` field. |
| `src/config.ts` | MODIFY | Add sidecar defaults to `DEFAULT_CONFIG` (port 8084, polling interval 500ms). |
| `tests/summarizer.test.ts` | NEW | Standalone summarizer behavior + edge cases. |
| `tests/sidecar-service.test.ts` | NEW | `SpeakService` end-to-end with mocked LLM/TTS/Speaker. |
| `tests/sidecar-claude-code-hook.test.ts` | NEW | HTTP receiver accepts POST `/speak`, calls `SpeakService`. |
| `tests/sidecar-terminal-scrape.test.ts` | NEW | Polling + response boundary detection with mocked `TerminalAdapter`. |
| `tests/sidecar-registry.test.ts` | NEW | Factory dispatch. |
| `tests/sidecar-install-hook.test.ts` | NEW | Settings-file mutation against tmpdir. |
| `docs/superpowers/sidecar-modes.md` | NEW | User-facing docs: which adapter to pick, install instructions, config reference. |

---

## Task 1: Extract `summarizeForTTS` into a standalone function

**Files:**
- Create: `src/summarizer.ts`
- Modify: `src/daemon.ts:396-440`
- Test: `tests/summarizer.test.ts`

Sidecar mode needs the same summarization logic as daemon mode. Extract it once.

- [ ] **Step 1: Write the failing test**

Create `tests/summarizer.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { summarizeForTTS } from "../src/summarizer";
import type { LLMProvider } from "../src/backends/llm/provider";

const mockLLM = (response: string): LLMProvider => ({
  chatCompletion: mock(async () => response),
} as unknown as LLMProvider);

test("short outputs pass through unchanged", async () => {
  const result = await summarizeForTTS("Done.", mockLLM(""), { maxTokens: 100 });
  expect(result).toBe("Done.");
});

test("long outputs get summarized via LLM", async () => {
  const long = "x".repeat(500);
  const result = await summarizeForTTS(long, mockLLM("Did the thing."), { maxTokens: 100 });
  expect(result).toBe("Did the thing.");
});

test("LLM failure falls back to last non-code line", async () => {
  const failing: LLMProvider = {
    chatCompletion: mock(async () => { throw new Error("boom"); }),
  } as unknown as LLMProvider;
  const input = "```ts\ncode\n```\nFinal answer line.";
  const result = await summarizeForTTS(input + "x".repeat(200), failing, { maxTokens: 100 });
  expect(result).toContain("Final answer line.");
});

test("very long outputs are truncated before sending to LLM", async () => {
  const huge = "x".repeat(3000);
  const chatMock = mock(async (_messages: unknown, _opts: unknown) => "Summary.");
  const llm = { chatCompletion: chatMock } as unknown as LLMProvider;
  await summarizeForTTS(huge, llm, { maxTokens: 100 });
  const callArgs = chatMock.mock.calls[0][0] as Array<{ content: string }>;
  expect(callArgs[1].content.length).toBeLessThan(2500);
});

test("strips <think> tags from LLM output", async () => {
  const result = await summarizeForTTS(
    "x".repeat(500),
    mockLLM("<think>reasoning</think>The summary."),
    { maxTokens: 100 },
  );
  expect(result).toBe("The summary.");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/summarizer.test.ts`
Expected: FAIL with "Cannot find module '../src/summarizer'".

- [ ] **Step 3: Implement `src/summarizer.ts`**

```ts
import type { LLMProvider } from "./backends/llm/provider";
import { log } from "./logger";

export interface SummarizerOptions {
  maxTokens: number;
}

/**
 * Summarize agent output for TTS. Short outputs pass through unchanged.
 * Long outputs are summarized to 1-3 sentences via the local LLM.
 * Falls back to the last meaningful line if the LLM fails.
 */
export async function summarizeForTTS(
  output: string,
  llm: LLMProvider,
  opts: SummarizerOptions,
): Promise<string> {
  if (output.length < 200) return output;

  const truncated = output.length > 2000
    ? output.substring(0, 1000) + "\n...\n" + output.substring(output.length - 800)
    : output;

  try {
    const raw = await llm.chatCompletion(
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
      { temperature: 0.3, max_tokens: opts.maxTokens },
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
  return lastLine ?? output.substring(0, 200);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/summarizer.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Refactor daemon.ts to use the extracted function**

In `src/daemon.ts`:

Add import at top:

```ts
import { summarizeForTTS } from "./summarizer";
```

Delete the existing `private async summarizeForTTS(output: string)` method (lines 396-440 in the current file — line numbers may shift, find by name).

Update the one caller (around line 218) from `this.summarizeForTTS(execResult.output)` to:

```ts
summarizeForTTS(execResult.output, this.providers.llm, { maxTokens: this.config.ttsSummaryMaxTokens })
```

- [ ] **Step 6: Run full test suite to verify no regression**

Run: `bun test`
Expected: full suite passes (240+ tests).

- [ ] **Step 7: Commit**

```bash
git add src/summarizer.ts src/daemon.ts tests/summarizer.test.ts
git commit -m "refactor: extract summarizeForTTS into standalone module"
```

---

## Task 2: SpeakAdapter / SpeakService types

**Files:**
- Create: `src/sidecar/types.ts`
- Test: deferred to Task 3 (types alone don't need a separate test).

- [ ] **Step 1: Write the types**

```ts
import type { TTSProvider } from "../backends/tts/provider";
import type { LLMProvider } from "../backends/llm/provider";
import type { Speaker } from "../types";

export interface SpeakRequest {
  text: string;
  agent?: string;        // optional label, e.g. "claude-code"
  skipSummary?: boolean; // if true, speak text verbatim
}

export interface SpeakService {
  speak(req: SpeakRequest): Promise<void>;
  stop(): Promise<void>;
}

export interface SpeakAdapter {
  readonly name: string;
  attach(service: SpeakService): Promise<void>;
  detach(): Promise<void>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}

export interface SpeakServiceDeps {
  llm: LLMProvider;
  tts: TTSProvider;
  speaker: Speaker;
  summaryMaxTokens: number;
}
```

- [ ] **Step 2: Commit (types only, no test yet)**

```bash
git add src/sidecar/types.ts
git commit -m "feat: add SpeakAdapter and SpeakService type interfaces"
```

---

## Task 3: SpeakService implementation

**Files:**
- Create: `src/sidecar/service.ts`
- Test: `tests/sidecar-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sidecar-service.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { DefaultSpeakService } from "../src/sidecar/service";
import type { LLMProvider } from "../src/backends/llm/provider";
import type { TTSProvider } from "../src/backends/tts/provider";
import type { Speaker } from "../src/types";

function makeDeps() {
  const speakMock = mock(async (_text: string) => {});
  const stopMock = mock(async () => {});
  return {
    llm: { chatCompletion: mock(async () => "Summary text.") } as unknown as LLMProvider,
    tts: { name: "mock", synthesize: mock(async () => new Uint8Array()), health: mock(async () => true) } as unknown as TTSProvider,
    speaker: { speak: speakMock, stop: stopMock, health: mock(async () => true) } as Speaker,
    summaryMaxTokens: 100,
  };
}

test("speak() summarizes long text then plays via speaker", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "x".repeat(500) });
  expect(deps.speaker.speak).toHaveBeenCalledWith("Summary text.");
});

test("speak() skips summarizer when skipSummary is true", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "x".repeat(500), skipSummary: true });
  expect(deps.llm.chatCompletion).not.toHaveBeenCalled();
  expect(deps.speaker.speak).toHaveBeenCalledWith("x".repeat(500));
});

test("speak() passes short text through unchanged", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.speak({ text: "Done." });
  expect(deps.llm.chatCompletion).not.toHaveBeenCalled();
  expect(deps.speaker.speak).toHaveBeenCalledWith("Done.");
});

test("stop() proxies to speaker.stop", async () => {
  const deps = makeDeps();
  const svc = new DefaultSpeakService(deps);
  await svc.stop();
  expect(deps.speaker.stop).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sidecar-service.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/sidecar/service.ts`**

```ts
import { summarizeForTTS } from "../summarizer";
import type { SpeakRequest, SpeakService, SpeakServiceDeps } from "./types";

export class DefaultSpeakService implements SpeakService {
  constructor(private deps: SpeakServiceDeps) {}

  async speak(req: SpeakRequest): Promise<void> {
    const text = req.skipSummary
      ? req.text
      : await summarizeForTTS(req.text, this.deps.llm, { maxTokens: this.deps.summaryMaxTokens });
    await this.deps.speaker.speak(text);
  }

  async stop(): Promise<void> {
    await this.deps.speaker.stop();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sidecar-service.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/service.ts tests/sidecar-service.test.ts
git commit -m "feat: add DefaultSpeakService — summarize then speak"
```

---

## Task 4: ClaudeCodeHookAdapter (HTTP receiver)

**Files:**
- Create: `src/sidecar/claude-code-hook.ts`
- Test: `tests/sidecar-claude-code-hook.test.ts`

The Claude Code hook config (set up in Task 6) calls `curl -X POST http://localhost:8084/speak -d '{"text": "..."}'` on the `Stop` event. This adapter is the receiver.

- [ ] **Step 1: Write the failing test**

Create `tests/sidecar-claude-code-hook.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { ClaudeCodeHookAdapter } from "../src/sidecar/claude-code-hook";
import type { SpeakService } from "../src/sidecar/types";

const makeService = (): SpeakService => ({
  speak: mock(async () => {}),
  stop: mock(async () => {}),
});

test("POST /speak with valid JSON triggers SpeakService.speak", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18084 });
  const svc = makeService();
  await adapter.attach(svc);

  const res = await fetch("http://localhost:18084/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello world" }),
  });

  expect(res.status).toBe(202);
  expect(svc.speak).toHaveBeenCalledWith({ text: "hello world", agent: "claude-code", skipSummary: undefined });

  await adapter.detach();
});

test("POST /speak with skipSummary flag passes through", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18085 });
  const svc = makeService();
  await adapter.attach(svc);

  await fetch("http://localhost:18085/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "raw", skipSummary: true }),
  });

  expect(svc.speak).toHaveBeenCalledWith({ text: "raw", agent: "claude-code", skipSummary: true });

  await adapter.detach();
});

test("non-POST returns 405", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18086 });
  await adapter.attach(makeService());

  const res = await fetch("http://localhost:18086/speak");
  expect(res.status).toBe(405);

  await adapter.detach();
});

test("malformed JSON returns 400", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18087 });
  await adapter.attach(makeService());

  const res = await fetch("http://localhost:18087/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  expect(res.status).toBe(400);

  await adapter.detach();
});

test("health returns ok when attached", async () => {
  const adapter = new ClaudeCodeHookAdapter({ port: 18088 });
  expect((await adapter.health()).ok).toBe(false);
  await adapter.attach(makeService());
  expect((await adapter.health()).ok).toBe(true);
  await adapter.detach();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sidecar-claude-code-hook.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/sidecar/claude-code-hook.ts`**

```ts
import { log } from "../logger";
import type { SpeakAdapter, SpeakService } from "./types";

export interface ClaudeCodeHookAdapterOptions {
  port: number;
}

export class ClaudeCodeHookAdapter implements SpeakAdapter {
  readonly name = "claude-code-hook";
  private server: ReturnType<typeof Bun.serve> | null = null;
  private service: SpeakService | null = null;

  constructor(private opts: ClaudeCodeHookAdapterOptions) {}

  async attach(service: SpeakService): Promise<void> {
    this.service = service;
    this.server = Bun.serve({
      port: this.opts.port,
      hostname: "127.0.0.1",
      fetch: async (req) => this.handle(req),
    });
    log("ok", `Claude Code hook adapter listening on http://127.0.0.1:${this.opts.port}/speak`);
  }

  async detach(): Promise<void> {
    this.server?.stop();
    this.server = null;
    this.service = null;
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    return this.server === null
      ? { ok: false, reason: "adapter not attached" }
      : { ok: true };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/speak") return new Response("Not Found", { status: 404 });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    if (!this.service) return new Response("Service Unavailable", { status: 503 });

    let body: { text?: string; skipSummary?: boolean };
    try {
      body = await req.json() as { text?: string; skipSummary?: boolean };
    } catch {
      return new Response("Bad Request: invalid JSON", { status: 400 });
    }

    if (!body.text || typeof body.text !== "string") {
      return new Response("Bad Request: 'text' field required", { status: 400 });
    }

    // Fire-and-forget so the hook returns quickly to Claude Code
    this.service.speak({ text: body.text, agent: "claude-code", skipSummary: body.skipSummary }).catch(err => {
      log("warn", `speak failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return new Response("Accepted", { status: 202 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sidecar-claude-code-hook.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/claude-code-hook.ts tests/sidecar-claude-code-hook.test.ts
git commit -m "feat: add ClaudeCodeHookAdapter — HTTP receiver for hook events"
```

---

## Task 5: TerminalScrapeAdapter

**Files:**
- Create: `src/sidecar/terminal-scrape.ts`
- Test: `tests/sidecar-terminal-scrape.test.ts`

Polls the target terminal tab via `TerminalAdapter.getText()` every N milliseconds, diffs against the previous snapshot, detects "agent response complete" via a configurable boundary (prompt return, timeout-after-quiet, or marker regex), and calls `SpeakService.speak()` on each detected response.

- [ ] **Step 1: Write the failing test**

Create `tests/sidecar-terminal-scrape.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { TerminalScrapeAdapter } from "../src/sidecar/terminal-scrape";
import type { SpeakService } from "../src/sidecar/types";
import type { TerminalAdapter, Tab } from "../src/types";

function makeTerminalAdapter(textSequence: string[]): TerminalAdapter {
  let i = 0;
  return {
    listTabs: mock(async (): Promise<Tab[]> => [{ id: 1, window_id: 1, title: "test", is_focused: false }]),
    focusTab: mock(async () => {}),
    sendText: mock(async () => {}),
    sendKey: mock(async () => {}),
    getText: mock(async () => textSequence[Math.min(i++, textSequence.length - 1)]),
  } as unknown as TerminalAdapter;
}

const makeService = (): SpeakService => ({
  speak: mock(async () => {}),
  stop: mock(async () => {}),
});

test("speaks new content appearing between polls", async () => {
  const terminal = makeTerminalAdapter([
    "$ claude\n> ",
    "$ claude\n> what time is it\nIt's 3pm.\n> ",
  ]);
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 30,
    promptMarker: /^> $/m,
  });
  const svc = makeService();

  await adapter.attach(svc);
  await new Promise(r => setTimeout(r, 80));
  await adapter.detach();

  expect(svc.speak).toHaveBeenCalledTimes(1);
  const call = (svc.speak as ReturnType<typeof mock>).mock.calls[0][0];
  expect(call.text).toContain("It's 3pm.");
  expect(call.agent).toBe("terminal-scrape");
});

test("does not speak when terminal text is unchanged", async () => {
  const terminal = makeTerminalAdapter(["$ claude\n> "]);
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 30,
    promptMarker: /^> $/m,
  });
  const svc = makeService();

  await adapter.attach(svc);
  await new Promise(r => setTimeout(r, 60));
  await adapter.detach();

  expect(svc.speak).not.toHaveBeenCalled();
});

test("detach stops the polling loop", async () => {
  const getTextMock = mock(async () => "$ \n> ");
  const terminal = { getText: getTextMock, listTabs: mock(async () => []) } as unknown as TerminalAdapter;
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 20,
    promptMarker: /^> $/m,
  });
  await adapter.attach(makeService());
  await adapter.detach();

  const callCountAtDetach = getTextMock.mock.calls.length;
  await new Promise(r => setTimeout(r, 50));
  expect(getTextMock.mock.calls.length).toBe(callCountAtDetach);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sidecar-terminal-scrape.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `src/sidecar/terminal-scrape.ts`**

```ts
import type { TerminalAdapter } from "../types";
import { log } from "../logger";
import type { SpeakAdapter, SpeakService } from "./types";

export interface TerminalScrapeAdapterOptions {
  terminal: TerminalAdapter;
  targetTab: string;
  pollIntervalMs: number;
  quietWindowMs: number;
  promptMarker: RegExp;
}

export class TerminalScrapeAdapter implements SpeakAdapter {
  readonly name = "terminal-scrape";
  private timer: ReturnType<typeof setInterval> | null = null;
  private service: SpeakService | null = null;
  private lastSnapshot = "";
  private lastChangeAt = 0;
  private pendingResponseStart = -1;

  constructor(private opts: TerminalScrapeAdapterOptions) {}

  async attach(service: SpeakService): Promise<void> {
    this.service = service;
    this.lastSnapshot = await this.safeGetText();
    this.lastChangeAt = Date.now();
    this.timer = setInterval(() => this.tick().catch(err => {
      log("warn", `terminal-scrape tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }), this.opts.pollIntervalMs);
    log("ok", `Terminal-scrape adapter watching tab "${this.opts.targetTab}"`);
  }

  async detach(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.service = null;
  }

  async health(): Promise<{ ok: boolean; reason?: string }> {
    return this.timer === null
      ? { ok: false, reason: "adapter not attached" }
      : { ok: true };
  }

  private async safeGetText(): Promise<string> {
    try {
      return await this.opts.terminal.getText(this.opts.targetTab, "screen");
    } catch (err) {
      log("warn", `getText failed: ${err instanceof Error ? err.message : String(err)}`);
      return this.lastSnapshot;
    }
  }

  private async tick(): Promise<void> {
    if (!this.service) return;
    const now = Date.now();
    const current = await this.safeGetText();

    if (current !== this.lastSnapshot) {
      if (this.pendingResponseStart === -1) {
        this.pendingResponseStart = this.lastSnapshot.length;
      }
      this.lastSnapshot = current;
      this.lastChangeAt = now;
      return;
    }

    // No change since last tick. Check if we should emit a response.
    if (this.pendingResponseStart === -1) return;
    if (now - this.lastChangeAt < this.opts.quietWindowMs) return;

    const newText = current.substring(this.pendingResponseStart);
    if (!this.opts.promptMarker.test(newText)) return;

    // Strip the trailing prompt from what we speak.
    const responseText = newText.replace(this.opts.promptMarker, "").trim();
    this.pendingResponseStart = -1;

    if (responseText.length > 0) {
      this.service.speak({ text: responseText, agent: "terminal-scrape" }).catch(err => {
        log("warn", `speak failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sidecar-terminal-scrape.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sidecar/terminal-scrape.ts tests/sidecar-terminal-scrape.test.ts
git commit -m "feat: add TerminalScrapeAdapter — universal sidecar fallback"
```

---

## Task 6: Sidecar config types + registry

**Files:**
- Create: `src/sidecar/registry.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `tests/sidecar-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sidecar-registry.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createSpeakAdapter } from "../src/sidecar/registry";
import type { TerminalAdapter } from "../src/types";

test("registry returns ClaudeCodeHookAdapter for 'claude-code-hook'", () => {
  const adapter = createSpeakAdapter(
    { backend: "claude-code-hook", port: 8084 },
    {} as TerminalAdapter,
  );
  expect(adapter.name).toBe("claude-code-hook");
});

test("registry returns TerminalScrapeAdapter for 'terminal-scrape'", () => {
  const terminal = { getText: async () => "" } as unknown as TerminalAdapter;
  const adapter = createSpeakAdapter(
    { backend: "terminal-scrape", targetTab: "1", pollIntervalMs: 500, quietWindowMs: 1500 },
    terminal,
  );
  expect(adapter.name).toBe("terminal-scrape");
});

test("registry throws on unknown backend", () => {
  expect(() => createSpeakAdapter(
    { backend: "nonsense" } as never,
    {} as TerminalAdapter,
  )).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sidecar-registry.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Add `SidecarConfig` to `src/types.ts`**

Add after the existing config interfaces:

```ts
export type SidecarConfig =
  | { backend: "claude-code-hook"; port: number }
  | {
      backend: "terminal-scrape";
      targetTab: string;
      pollIntervalMs: number;
      quietWindowMs: number;
      promptMarker?: string; // regex source, compiled at runtime
    };
```

Extend `RuntimeConfig` (or whatever the runtime config interface is named in `types.ts`) with:

```ts
sidecar?: SidecarConfig;
```

- [ ] **Step 4: Implement `src/sidecar/registry.ts`**

```ts
import type { SidecarConfig, TerminalAdapter } from "../types";
import { ClaudeCodeHookAdapter } from "./claude-code-hook";
import { TerminalScrapeAdapter } from "./terminal-scrape";
import type { SpeakAdapter } from "./types";

const DEFAULT_PROMPT_MARKER = /^> $/m;

export function createSpeakAdapter(
  config: SidecarConfig,
  terminal: TerminalAdapter,
): SpeakAdapter {
  switch (config.backend) {
    case "claude-code-hook":
      return new ClaudeCodeHookAdapter({ port: config.port });
    case "terminal-scrape":
      return new TerminalScrapeAdapter({
        terminal,
        targetTab: config.targetTab,
        pollIntervalMs: config.pollIntervalMs,
        quietWindowMs: config.quietWindowMs,
        promptMarker: config.promptMarker ? new RegExp(config.promptMarker, "m") : DEFAULT_PROMPT_MARKER,
      });
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown sidecar backend: ${JSON.stringify(exhaustive)}`);
    }
  }
}
```

- [ ] **Step 5: Add defaults to `src/config.ts`**

In `DEFAULT_CONFIG` (find the existing definition), add a commented example showing how to enable sidecar:

```ts
// Optional sidecar mode (instead of, or alongside, the daemon's voice loop):
// sidecar: { backend: "claude-code-hook", port: 8084 }
// sidecar: { backend: "terminal-scrape", targetTab: "1", pollIntervalMs: 500, quietWindowMs: 1500 }
```

Don't add an actual `sidecar:` field to `DEFAULT_CONFIG` — sidecar is opt-in only.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/sidecar-registry.test.ts`
Expected: PASS (all 3 tests).

Also run full suite to catch type errors elsewhere:
Run: `bun test`
Expected: full suite passes.

- [ ] **Step 7: Commit**

```bash
git add src/sidecar/registry.ts src/types.ts src/config.ts tests/sidecar-registry.test.ts
git commit -m "feat: add SidecarConfig types and SpeakAdapter registry"
```

---

## Task 7: `cicero hook` CLI subcommand

**Files:**
- Modify: `src/index.ts`
- Test: smoke test via running the binary (see Step 5).

Adds `cicero hook` — starts the ClaudeCodeHookAdapter HTTP server. Bootstraps the same managed Python servers (LLM router, TTS) that daemon mode uses so summarization and TTS work standalone.

- [ ] **Step 1: Read the current CLI structure**

Run: `grep -n "process.argv\|case \"" src/index.ts | head -30`

Find the existing subcommand dispatch (likely a switch on `process.argv[2]` or similar).

- [ ] **Step 2: Add `hook` case**

In `src/index.ts`, near the other subcommand cases (e.g., next to `case "start":`), add:

```ts
case "hook": {
  const { runHookMode } = await import("./sidecar/run-hook");
  await runHookMode(config);
  break;
}
```

- [ ] **Step 3: Create `src/sidecar/run-hook.ts`**

```ts
import { createSpeakAdapter } from "./registry";
import { DefaultSpeakService } from "./service";
import { createBackendProviders } from "../backends/registry";
import { startManagedServers, stopManagedServers } from "../backends/managed-server";
import { createSpeaker } from "../speaker";
import { audioPlayerFromConfig } from "../speaker/player";
import type { RuntimeConfig } from "../types";
import { log } from "../logger";

export async function runHookMode(config: RuntimeConfig): Promise<void> {
  log("info", "Starting Cicero in hook mode (sidecar)");

  // Bootstrap LLM and TTS servers (skip STT — sidecar doesn't need it).
  await startManagedServers(config, { skip: ["stt"] });

  const providers = createBackendProviders(config);
  const audioPlayer = audioPlayerFromConfig(config);
  const speaker = createSpeaker(config, providers.tts, audioPlayer);

  const sidecarCfg = config.sidecar ?? { backend: "claude-code-hook" as const, port: 8084 };
  if (sidecarCfg.backend !== "claude-code-hook") {
    throw new Error("`cicero hook` requires sidecar.backend = 'claude-code-hook'. For terminal-scrape, use `cicero scrape`.");
  }

  const adapter = createSpeakAdapter(sidecarCfg, null as never); // terminal not needed
  const service = new DefaultSpeakService({
    llm: providers.llm,
    tts: providers.tts,
    speaker,
    summaryMaxTokens: config.ttsSummaryMaxTokens ?? 100,
  });

  await adapter.attach(service);

  const shutdown = async () => {
    log("info", "Shutting down hook mode");
    await adapter.detach();
    await service.stop();
    await stopManagedServers();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}
```

**Note:** `startManagedServers` may not accept a `skip` option today. If it doesn't, add one — or just start all servers; the STT one will idle. Check `src/backends/managed-server.ts` for the actual signature before writing this code.

- [ ] **Step 4: Smoke test**

Run in two terminals.

Terminal 1:
```bash
bun run src/index.ts hook
```

Wait for the log line: `Claude Code hook adapter listening on http://127.0.0.1:8084/speak`.

Terminal 2:
```bash
curl -X POST http://localhost:8084/speak \
  -H "content-type: application/json" \
  -d '{"text": "Hello from the sidecar."}'
```

Expected: `Accepted` response, and you hear "Hello from the sidecar." via TTS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/sidecar/run-hook.ts
git commit -m "feat: add 'cicero hook' subcommand — runs Claude Code hook receiver"
```

---

## Task 8: `cicero scrape <tab>` CLI subcommand

**Files:**
- Modify: `src/index.ts`
- Create: `src/sidecar/run-scrape.ts`
- Test: smoke test (see Step 4).

- [ ] **Step 1: Add `scrape` case to `src/index.ts`**

```ts
case "scrape": {
  const targetTab = process.argv[3];
  if (!targetTab) {
    console.error("Usage: cicero scrape <tab-name-or-id>");
    process.exit(1);
  }
  const { runScrapeMode } = await import("./sidecar/run-scrape");
  await runScrapeMode(config, targetTab);
  break;
}
```

- [ ] **Step 2: Create `src/sidecar/run-scrape.ts`**

```ts
import { createSpeakAdapter } from "./registry";
import { DefaultSpeakService } from "./service";
import { createBackendProviders } from "../backends/registry";
import { startManagedServers, stopManagedServers } from "../backends/managed-server";
import { createSpeaker } from "../speaker";
import { audioPlayerFromConfig } from "../speaker/player";
import { createTerminalAdapter } from "../terminal";
import type { RuntimeConfig } from "../types";
import { log } from "../logger";

export async function runScrapeMode(config: RuntimeConfig, targetTab: string): Promise<void> {
  log("info", `Starting Cicero in scrape mode (target tab: ${targetTab})`);

  await startManagedServers(config, { skip: ["stt"] });

  const providers = createBackendProviders(config);
  const audioPlayer = audioPlayerFromConfig(config);
  const speaker = createSpeaker(config, providers.tts, audioPlayer);
  const terminal = createTerminalAdapter(config);

  const sidecarCfg = config.sidecar?.backend === "terminal-scrape"
    ? config.sidecar
    : {
        backend: "terminal-scrape" as const,
        targetTab,
        pollIntervalMs: 500,
        quietWindowMs: 1500,
      };

  const adapter = createSpeakAdapter(sidecarCfg, terminal);
  const service = new DefaultSpeakService({
    llm: providers.llm,
    tts: providers.tts,
    speaker,
    summaryMaxTokens: config.ttsSummaryMaxTokens ?? 100,
  });

  await adapter.attach(service);

  const shutdown = async () => {
    log("info", "Shutting down scrape mode");
    await adapter.detach();
    await service.stop();
    await stopManagedServers();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}
```

- [ ] **Step 3: Smoke test**

Open a kitty/tmux session, find a tab name or window-id (e.g. `1`), then in another terminal:

```bash
bun run src/index.ts scrape 1
```

In the watched tab, run `claude` and ask it a short question. Within ~2 seconds of Claude's response completing, you should hear the TTS summary.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/sidecar/run-scrape.ts
git commit -m "feat: add 'cicero scrape' subcommand — terminal output scraper"
```

---

## Task 9: Claude Code hook installer helper

**Files:**
- Create: `src/sidecar/install-claude-code-hook.ts`
- Test: `tests/sidecar-install-hook.test.ts`

One-command setup that writes the appropriate hook config into Claude Code's settings file, preserving any existing config.

Claude Code reads hooks from `~/.claude/settings.json`. The Stop hook entry looks like (per the Claude Code hooks docs):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "curl -sX POST http://localhost:8084/speak -H 'content-type: application/json' -d \"$(jq -nc --arg t \"$CLAUDE_LAST_RESPONSE\" '{text: $t}')\"" }
        ]
      }
    ]
  }
}
```

(Adjust the env-var name based on what Claude Code actually exposes — verify against the Claude Code hooks documentation at install time.)

- [ ] **Step 1: Write the failing test**

Create `tests/sidecar-install-hook.test.ts`:

```ts
import { test, expect } from "bun:test";
import { installClaudeCodeHook } from "../src/sidecar/install-claude-code-hook";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("writes a new settings.json with the hook entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");

  await installClaudeCodeHook({ settingsPath, port: 8084 });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.hooks.Stop[0].hooks[0].command).toContain("localhost:8084/speak");
});

test("merges into an existing settings.json without clobbering other hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "echo pre" }] }] },
    otherKey: "preserve me",
  }));

  await installClaudeCodeHook({ settingsPath, port: 8084 });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.otherKey).toBe("preserve me");
  expect(data.hooks.PreToolUse).toHaveLength(1);
  expect(data.hooks.Stop[0].hooks[0].command).toContain("localhost:8084/speak");
});

test("is idempotent — running twice doesn't duplicate the hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");

  await installClaudeCodeHook({ settingsPath, port: 8084 });
  await installClaudeCodeHook({ settingsPath, port: 8084 });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.hooks.Stop).toHaveLength(1);
  expect(data.hooks.Stop[0].hooks).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sidecar-install-hook.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/sidecar/install-claude-code-hook.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger";

export interface InstallClaudeCodeHookOptions {
  settingsPath?: string;
  port: number;
}

const CICERO_MARKER = "# cicero-sidecar-hook";

function buildCommand(port: number): string {
  return `${CICERO_MARKER} curl -sX POST http://localhost:${port}/speak -H 'content-type: application/json' -d "$(jq -nc --arg t "$CLAUDE_LAST_RESPONSE" '{text: $t}')"`;
}

export async function installClaudeCodeHook(opts: InstallClaudeCodeHookOptions): Promise<void> {
  const settingsPath = opts.settingsPath ?? `${homedir()}/.claude/settings.json`;

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }

  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  const stopList = hooks.Stop ?? [];

  const newCommand = buildCommand(opts.port);

  // Find or create the catch-all matcher.
  let catchAll = stopList.find(entry => entry.matcher === ".*");
  if (!catchAll) {
    catchAll = { matcher: ".*", hooks: [] };
    stopList.push(catchAll);
  }

  // Remove any prior Cicero hook (identified by the marker), then add fresh.
  catchAll.hooks = catchAll.hooks.filter(h => !h.command.includes(CICERO_MARKER));
  catchAll.hooks.push({ type: "command", command: newCommand });

  hooks.Stop = stopList;
  settings.hooks = hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log("ok", `Installed Cicero hook into ${settingsPath}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sidecar-install-hook.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Wire into the CLI**

In `src/index.ts`, extend the `hook` case to support `install` and `uninstall` actions:

```ts
case "hook": {
  const action = process.argv[3];
  if (action === "install") {
    const target = process.argv[4];
    if (target !== "claude-code") {
      console.error("Usage: cicero hook install claude-code");
      process.exit(1);
    }
    const { installClaudeCodeHook } = await import("./sidecar/install-claude-code-hook");
    await installClaudeCodeHook({ port: config.sidecar?.backend === "claude-code-hook" ? config.sidecar.port : 8084 });
    console.log("Cicero hook installed. Run 'cicero hook' in another terminal to start the receiver.");
    break;
  }
  const { runHookMode } = await import("./sidecar/run-hook");
  await runHookMode(config);
  break;
}
```

- [ ] **Step 6: Smoke test the installer**

```bash
bun run src/index.ts hook install claude-code
cat ~/.claude/settings.json
```

Expected: the file exists and contains a `Stop` hook with the Cicero curl command.

- [ ] **Step 7: Commit**

```bash
git add src/sidecar/install-claude-code-hook.ts tests/sidecar-install-hook.test.ts src/index.ts
git commit -m "feat: add 'cicero hook install claude-code' helper"
```

---

## Task 10: User-facing docs

**Files:**
- Create: `docs/superpowers/sidecar-modes.md`

- [ ] **Step 1: Write the doc**

```markdown
# Cicero Sidecar Modes

Cicero has two modes:

- **Daemon mode** (`cicero start`) — full voice loop: mic in → STT → router → brain dispatch → summarized TTS.
- **Sidecar mode** — Cicero listens for responses from a coding agent you're already using, summarizes them, and speaks them. Input is whatever the agent provides (Claude Code `/voice`, Codex, etc.).

This doc covers sidecar mode. For daemon mode, see the main README.

## Pick an adapter

| Adapter | When to use | Setup |
|---|---|---|
| **`claude-code-hook`** | You use Claude Code (any surface — terminal, VS Code, Desktop, Web, Remote Control). | One-line install via `cicero hook install claude-code`. |
| **`terminal-scrape`** | You use any other agent in a terminal (Codex CLI, Gemini CLI, Ollama, etc.). | Start `cicero scrape <tab>` pointing at the agent's tab. |

## Claude Code hook

```bash
# One-time: install the Stop hook into ~/.claude/settings.json
cicero hook install claude-code

# Each time you want sidecar mode: run the receiver
cicero hook
```

Now any Claude Code session you start (terminal, VS Code, Desktop, Web via Remote Control) will speak summaries to you through Cicero's TTS.

## Terminal scrape

For agents without a native hook system.

```bash
# Start your agent in a known terminal tab/window
kitty @ launch --type=tab --tab-title=codex   # for example
codex

# In another terminal, point Cicero at it
cicero scrape codex
```

Cicero polls the target tab's content, detects when the agent finishes a response (prompt return + quiet period), summarizes, and speaks.

## Config

Override defaults in `~/.cicero/config.yaml`:

```yaml
sidecar:
  backend: claude-code-hook
  port: 8084
```

Or for terminal-scrape:

```yaml
sidecar:
  backend: terminal-scrape
  targetTab: "codex"
  pollIntervalMs: 500
  quietWindowMs: 1500
  promptMarker: "^> $"   # regex for what a fresh prompt looks like
```

## Caveats

- **Sidecar shares Cicero's LLM router and TTS servers.** Sidecar bootstraps them; STT server is skipped.
- **Terminal-scrape boundary detection is heuristic.** If responses aren't being detected, tweak `promptMarker` and `quietWindowMs`.
- **Sidecar runs on the same machine as the agent today.** "Drive away in car" use case requires a future multi-device transport.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/sidecar-modes.md
git commit -m "docs: add sidecar modes user guide"
```

---

## Self-review notes

**Spec coverage check:** Plan implements every "v1 in scope" item from `2026-05-19-positioning-design.md` — SpeakAdapter pattern + registry (Tasks 2, 6), ClaudeCodeHookAdapter (Task 4), TerminalScrapeAdapter (Task 5), existing summarization reused (Task 1 refactor), `cicero hook` and `cicero scrape` subcommands (Tasks 7, 8), Claude Code hook installer (Task 9), user docs (Task 10). Daemon mode is explicitly untouched.

**Placeholder scan:** None. Every step has executable code or a verifiable command.

**Type consistency:**
- `SpeakAdapter.name` defined in Task 2, referenced in Tasks 4, 5, 6 — consistent.
- `SpeakRequest.skipSummary` defined in Task 2, used in Tasks 3, 4 — consistent.
- `SidecarConfig.port` for `claude-code-hook`, `targetTab` for `terminal-scrape` — discriminated union, no overlap, consistent.

**Known dependencies on existing code that may need verification at execution time:**
- `startManagedServers` may need a `skip` option added. Verify the signature in `src/backends/managed-server.ts` before Task 7 and add the option if missing.
- `audioPlayerFromConfig` and the exact export shape of `src/speaker/` — verify against actual exports.
- Claude Code's `Stop` hook payload format and env-var name (`CLAUDE_LAST_RESPONSE`) — verify against current Claude Code hooks docs before Task 9; adjust the command template if the variable name differs.

These three verification points are flagged as warnings in the relevant tasks; they aren't blockers.

**Acceptance:**

- [ ] All ten task commits land cleanly
- [ ] `bun test` — full suite (240+ existing + ~18 new) passes
- [ ] `cicero hook install claude-code` writes the right settings entry
- [ ] `cicero hook` accepts curl POSTs and speaks via TTS
- [ ] `cicero scrape <tab>` watches a real terminal and speaks responses
- [ ] Daemon mode unchanged: `cicero start --tts` works identically to before
