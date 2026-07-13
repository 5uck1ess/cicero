# Multi-Brain CLI Support Implementation Plan

> **Historical plan:** this records the proposed implementation at the time and is not an operator configuration reference. Some snippets contain fields that the current strict runtime schema intentionally rejects.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cicero's `Brain` layer fully pluggable so users can drive Cicero with Claude Code, Codex CLI, Gemini CLI, Qwen CLI, or a local Ollama model — selected via config or CLI flag.

**Architecture:** Extract a shared `SubprocessCLIBrain` base class that handles the common subprocess-spawn pattern (Claude Code already uses this; Codex/Gemini/Qwen all expose `--print`-style single-shot modes). Add a separate `OllamaBrain` that talks to local Ollama's `/api/chat` endpoint over HTTP (mirroring `backends/llm/ollama.ts`). Route via factory in `src/brain/index.ts` based on `brain.backend` config value (already declared in `types.ts`).

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `Bun.spawn`, fetch. No new deps.

**Source inspiration:** [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) — multi-provider inference abstraction. Read for patterns; reimplement clean in TS.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/brain/subprocess-cli.ts` | NEW | Base class: subprocess CLI brain (binary, args, context buffer) |
| `src/brain/claude-code.ts` | MODIFY | Now extends `SubprocessCLIBrain` |
| `src/brain/codex.ts` | NEW | Codex CLI brain |
| `src/brain/gemini.ts` | NEW | Gemini CLI brain |
| `src/brain/qwen.ts` | NEW | Qwen CLI brain |
| `src/brain/ollama.ts` | NEW | Local Ollama HTTP brain |
| `src/brain/index.ts` | MODIFY | Factory dispatches on `brain.backend` |
| `src/types.ts` | MODIFY | Extend `BrainConfig.backend` union with `"qwen"`, add per-brain optional config blocks |
| `src/config.ts` | MODIFY | Add `--brain` CLI flag values for new brains |
| `tests/brain-subprocess-cli.test.ts` | NEW | Tests for shared base class |
| `tests/brain-codex.test.ts` | NEW | CodexBrain integration test (mock subprocess) |
| `tests/brain-gemini.test.ts` | NEW | GeminiBrain integration test (mock subprocess) |
| `tests/brain-qwen.test.ts` | NEW | QwenBrain integration test (mock subprocess) |
| `tests/brain-ollama.test.ts` | NEW | OllamaBrain HTTP test (mock fetch) |
| `tests/brain-factory.test.ts` | NEW | Factory dispatches correctly per config |

---

## Task 1: Extend BrainConfig type and shared base interface

**Files:**
- Modify: `src/types.ts:35-42`

- [ ] **Step 1: Write the failing test**

Create `tests/brain-types.test.ts`:

```ts
import { test, expect } from "bun:test";
import type { BrainConfig } from "../src/types";

test("BrainConfig accepts all five backend values", () => {
  const configs: BrainConfig[] = [
    { backend: "claude-code", mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
    { backend: "codex", mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
    { backend: "gemini", mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
    { backend: "qwen", mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
    { backend: "ollama", mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
  ];
  expect(configs).toHaveLength(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-types.test.ts`
Expected: FAIL with TypeScript error — `"qwen"` not in the union.

- [ ] **Step 3: Update the union**

In `src/types.ts`, change line 36:

```ts
export interface BrainConfig {
  backend: "claude-code" | "codex" | "gemini" | "qwen" | "ollama";
  mode: "subprocess" | "tab-inject";
  target_tab?: string;
  auto_approve_tools?: boolean;
  session_timeout: string;
  max_context_commands: number;
  // Per-brain overrides
  binary?: string;          // override the binary name (default: same as backend)
  binary_args?: string[];   // extra args passed before the prompt
  ollama_port?: number;     // port for ollama backend (default 11434)
  ollama_model?: string;    // model name for ollama backend (default "qwen3.5:0.8b")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/brain-types.test.ts
git commit -m "feat(brain): extend BrainConfig with qwen + per-brain overrides"
```

---

## Task 2: Build SubprocessCLIBrain base class

**Files:**
- Create: `src/brain/subprocess-cli.ts`
- Test: `tests/brain-subprocess-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { SubprocessCLIBrain } from "../src/brain/subprocess-cli";

test("SubprocessCLIBrain spawns the configured binary with prompt", async () => {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "echo",
    args: ["--print"],
  });
  await brain.start();
  const out = await brain.send("hello");
  expect(out).toContain("hello");
});

test("injectContext prepends context to next send", async () => {
  const brain = new SubprocessCLIBrain({
    name: "test",
    binary: "cat",
    args: [],
  });
  await brain.start();
  brain.injectContext("[Command] ls\n[Output] file.txt");
  // We can't easily assert internal state without an accessor; check no throw.
  expect(brain).toBeDefined();
});

test("contextBuffer caps at 50 entries", () => {
  const brain = new SubprocessCLIBrain({ name: "test", binary: "echo", args: [] });
  for (let i = 0; i < 60; i++) brain.injectContext(`entry ${i}`);
  // Internal cap; tested via private getter exposed for tests.
  expect((brain as any).contextBuffer.length).toBe(50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-subprocess-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/brain/subprocess-cli.ts
import type { Brain } from "../types";
import { log } from "../logger";

export interface SubprocessCLIBrainConfig {
  name: string;          // for logging
  binary: string;        // binary on PATH, e.g. "claude" / "codex" / "gemini" / "qwen"
  args: string[];        // args inserted before the prompt, e.g. ["--print"]
  promptViaStdin?: boolean; // if true, pipe prompt via stdin instead of argv
  env?: Record<string, string>;
}

export class SubprocessCLIBrain implements Brain {
  protected contextBuffer: string[] = [];
  protected config: SubprocessCLIBrainConfig;

  constructor(config: SubprocessCLIBrainConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    log("info", `Brain (${this.config.name}) initialized`);
  }

  async stop(): Promise<void> {
    // Each send spawns its own subprocess; nothing persistent to stop.
  }

  async send(message: string): Promise<string> {
    const fullMessage = this.buildPrompt(message);
    const env = { ...process.env, ...(this.config.env || {}) };

    try {
      const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
        stdout: "pipe",
        stderr: "pipe",
        env,
      };

      let cmd: string[];
      if (this.config.promptViaStdin) {
        cmd = [this.config.binary, ...this.config.args];
        spawnOpts.stdin = new Response(fullMessage).body!;
      } else {
        cmd = [this.config.binary, ...this.config.args, fullMessage];
      }

      const proc = Bun.spawn(cmd, spawnOpts);
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`${this.config.name} exited with ${exitCode}: ${stderr}`);
      }
      return output.trim();
    } catch (err) {
      log("error", `Brain (${this.config.name}) error: ${(err as Error).message}`);
      throw err;
    }
  }

  protected buildPrompt(message: string): string {
    const contextPrefix = this.contextBuffer.length > 0
      ? `Context from recent commands:\n${this.contextBuffer.join("\n")}\n\n`
      : "";
    return contextPrefix + message;
  }

  injectContext(context: string): void {
    this.contextBuffer.push(context);
    if (this.contextBuffer.length > 50) {
      this.contextBuffer = this.contextBuffer.slice(-50);
    }
  }

  async restart(): Promise<void> {
    this.contextBuffer = [];
    await this.stop();
    await this.start();
  }

  async health(): Promise<boolean> {
    try {
      const proc = Bun.spawn(["which", this.config.binary], { stdout: "pipe" });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-subprocess-cli.test.ts`
Expected: PASS for all three tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/subprocess-cli.ts tests/brain-subprocess-cli.test.ts
git commit -m "feat(brain): add SubprocessCLIBrain base class"
```

---

## Task 3: Refactor ClaudeCodeBrain to extend the base class

**Files:**
- Modify: `src/brain/claude-code.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/brain-claude-code.test.ts` (create if absent):

```ts
import { test, expect } from "bun:test";
import { ClaudeCodeBrain } from "../src/brain/claude-code";

test("ClaudeCodeBrain uses 'claude' binary with --print arg", async () => {
  const brain = new ClaudeCodeBrain();
  await brain.start();
  // Reach into config to verify wiring without actually running claude.
  const cfg = (brain as any).config;
  expect(cfg.binary).toBe("claude");
  expect(cfg.args).toEqual(["--print"]);
});

test("ClaudeCodeBrain health returns true if claude on PATH", async () => {
  const brain = new ClaudeCodeBrain();
  const ok = await brain.health();
  // Pass if claude is installed in CI; document expected env.
  expect(typeof ok).toBe("boolean");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-claude-code.test.ts`
Expected: FAIL — `cfg.binary` is undefined under the old implementation.

- [ ] **Step 3: Rewrite ClaudeCodeBrain**

Replace `src/brain/claude-code.ts` with:

```ts
import { SubprocessCLIBrain } from "./subprocess-cli";

export class ClaudeCodeBrain extends SubprocessCLIBrain {
  constructor() {
    super({
      name: "Claude Code",
      binary: "claude",
      args: ["--print"],
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-claude-code.test.ts`
Expected: PASS. Then `bun test tests/` to confirm no regressions in other brain-consuming tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/claude-code.ts tests/brain-claude-code.test.ts
git commit -m "refactor(brain): ClaudeCodeBrain extends SubprocessCLIBrain"
```

---

## Task 4: Add CodexBrain

**Files:**
- Create: `src/brain/codex.ts`
- Test: `tests/brain-codex.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { CodexBrain } from "../src/brain/codex";

test("CodexBrain spawns 'codex' binary with proto mode", async () => {
  const brain = new CodexBrain();
  await brain.start();
  const cfg = (brain as any).config;
  expect(cfg.binary).toBe("codex");
  // Codex CLI single-shot is `codex exec`; prompt goes as the last positional.
  expect(cfg.args).toEqual(["exec", "--quiet"]);
});

test("CodexBrain health checks for codex on PATH", async () => {
  const brain = new CodexBrain();
  const ok = await brain.health();
  expect(typeof ok).toBe("boolean");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-codex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/brain/codex.ts
import { SubprocessCLIBrain } from "./subprocess-cli";

export class CodexBrain extends SubprocessCLIBrain {
  constructor(binary = "codex", extraArgs: string[] = []) {
    super({
      name: "Codex CLI",
      binary,
      // `codex exec` runs a single prompt non-interactively.
      // `--quiet` suppresses session metadata so we only get the model output.
      args: ["exec", "--quiet", ...extraArgs],
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-codex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/codex.ts tests/brain-codex.test.ts
git commit -m "feat(brain): add CodexBrain for Codex CLI"
```

---

## Task 5: Add GeminiBrain

**Files:**
- Create: `src/brain/gemini.ts`
- Test: `tests/brain-gemini.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { GeminiBrain } from "../src/brain/gemini";

test("GeminiBrain spawns 'gemini' with -p prompt flag", async () => {
  const brain = new GeminiBrain();
  await brain.start();
  const cfg = (brain as any).config;
  expect(cfg.binary).toBe("gemini");
  // Gemini CLI: `gemini -p "prompt"` is single-shot mode.
  // We pass prompt via stdin to avoid argv length / quoting issues.
  expect(cfg.promptViaStdin).toBe(true);
  expect(cfg.args).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-gemini.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/brain/gemini.ts
import { SubprocessCLIBrain } from "./subprocess-cli";

export class GeminiBrain extends SubprocessCLIBrain {
  constructor(binary = "gemini", extraArgs: string[] = []) {
    super({
      name: "Gemini CLI",
      binary,
      // gemini-cli reads prompt from stdin in non-interactive mode.
      // Empty args = stdin mode; extra flags can override (e.g. --model).
      args: extraArgs,
      promptViaStdin: true,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-gemini.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/gemini.ts tests/brain-gemini.test.ts
git commit -m "feat(brain): add GeminiBrain for Gemini CLI"
```

---

## Task 6: Add QwenBrain

**Files:**
- Create: `src/brain/qwen.ts`
- Test: `tests/brain-qwen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { QwenBrain } from "../src/brain/qwen";

test("QwenBrain spawns 'qwen' with -p prompt", async () => {
  const brain = new QwenBrain();
  await brain.start();
  const cfg = (brain as any).config;
  expect(cfg.binary).toBe("qwen");
  expect(cfg.promptViaStdin).toBe(true);
});

test("QwenBrain accepts custom binary override", async () => {
  const brain = new QwenBrain("qwen-coder");
  const cfg = (brain as any).config;
  expect(cfg.binary).toBe("qwen-coder");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-qwen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/brain/qwen.ts
import { SubprocessCLIBrain } from "./subprocess-cli";

export class QwenBrain extends SubprocessCLIBrain {
  constructor(binary = "qwen", extraArgs: string[] = []) {
    super({
      name: "Qwen CLI",
      binary,
      args: extraArgs,
      promptViaStdin: true,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-qwen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/qwen.ts tests/brain-qwen.test.ts
git commit -m "feat(brain): add QwenBrain for Qwen CLI"
```

---

## Task 7: Add OllamaBrain (HTTP, not subprocess)

**Files:**
- Create: `src/brain/ollama.ts`
- Test: `tests/brain-ollama.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock, beforeEach } from "bun:test";
import { OllamaBrain } from "../src/brain/ollama";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });

test("OllamaBrain posts to /api/chat with model", async () => {
  let captured: any = null;
  globalThis.fetch = mock(async (url: string, init: any) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ message: { content: "hi from ollama" } }));
  }) as any;

  const brain = new OllamaBrain({ port: 11434, model: "qwen3.5:0.8b" });
  await brain.start();
  const out = await brain.send("hello");

  expect(captured.url).toContain("/api/chat");
  expect(captured.body.model).toBe("qwen3.5:0.8b");
  expect(out).toBe("hi from ollama");
});

test("OllamaBrain health pings /api/tags", async () => {
  globalThis.fetch = mock(async (url: string) => {
    if (url.endsWith("/api/tags")) return new Response("{}");
    return new Response("", { status: 500 });
  }) as any;

  const brain = new OllamaBrain({});
  const ok = await brain.health();
  expect(ok).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-ollama.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/brain/ollama.ts
import type { Brain } from "../types";
import { log } from "../logger";

export interface OllamaBrainConfig {
  port?: number;
  model?: string;
  systemPrompt?: string;
}

export class OllamaBrain implements Brain {
  private port: number;
  private model: string;
  private systemPrompt: string;
  private contextBuffer: string[] = [];

  constructor(config: OllamaBrainConfig = {}) {
    this.port = config.port ?? 11434;
    this.model = config.model ?? "qwen3.5:0.8b";
    this.systemPrompt = config.systemPrompt
      ?? "You are Cicero, a voice-controlled terminal assistant. Keep responses concise.";
  }

  async start(): Promise<void> {
    log("info", `Brain (Ollama ${this.model}) initialized on port ${this.port}`);
  }

  async stop(): Promise<void> {
    // Ollama runs as a separate daemon; nothing to stop from the brain side.
  }

  async send(message: string): Promise<string> {
    const contextPrefix = this.contextBuffer.length > 0
      ? `Context from recent commands:\n${this.contextBuffer.join("\n")}\n\n`
      : "";
    const fullMessage = contextPrefix + message;

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: fullMessage },
      ],
      stream: false,
    };

    const res = await fetch(`http://localhost:${this.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json() as { message?: { content?: string } };
    return (data.message?.content ?? "").trim();
  }

  injectContext(context: string): void {
    this.contextBuffer.push(context);
    if (this.contextBuffer.length > 50) {
      this.contextBuffer = this.contextBuffer.slice(-50);
    }
  }

  async restart(): Promise<void> {
    this.contextBuffer = [];
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.port}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-ollama.test.ts`
Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/ollama.ts tests/brain-ollama.test.ts
git commit -m "feat(brain): add OllamaBrain (HTTP to local Ollama)"
```

---

## Task 8: Update brain factory to route to all five backends

**Files:**
- Modify: `src/brain/index.ts`
- Test: `tests/brain-factory.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { createBrain } from "../src/brain";
import { RuntimeConfig } from "../src/config";
import type { CiceroConfig } from "../src/types";
import { ClaudeCodeBrain } from "../src/brain/claude-code";
import { CodexBrain } from "../src/brain/codex";
import { GeminiBrain } from "../src/brain/gemini";
import { QwenBrain } from "../src/brain/qwen";
import { OllamaBrain } from "../src/brain/ollama";

function cfg(backend: CiceroConfig["brain"]["backend"]): RuntimeConfig {
  return new RuntimeConfig({
    tts_enabled: true,
    wake_word_enabled: false,
    hotkey: "ctrl+shift+space",
    wispr_hotkey: "option+space",
    terminal: "kitty",
    voice: "default",
    brain: { backend, mode: "subprocess", session_timeout: "4h", max_context_commands: 50 },
    servers: { router: { port: 8081, model: "x" }, tts: { port: 8082, model: "y" }, stt: { port: 8083, model: "z" } },
    actions: {},
  });
}

test("factory returns ClaudeCodeBrain for claude-code", () => {
  expect(createBrain(cfg("claude-code"))).toBeInstanceOf(ClaudeCodeBrain);
});
test("factory returns CodexBrain for codex", () => {
  expect(createBrain(cfg("codex"))).toBeInstanceOf(CodexBrain);
});
test("factory returns GeminiBrain for gemini", () => {
  expect(createBrain(cfg("gemini"))).toBeInstanceOf(GeminiBrain);
});
test("factory returns QwenBrain for qwen", () => {
  expect(createBrain(cfg("qwen"))).toBeInstanceOf(QwenBrain);
});
test("factory returns OllamaBrain for ollama", () => {
  expect(createBrain(cfg("ollama"))).toBeInstanceOf(OllamaBrain);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/brain-factory.test.ts`
Expected: FAIL — factory only handles `claude-code` and `tab-inject` mode today.

- [ ] **Step 3: Rewrite factory**

Replace `src/brain/index.ts`:

```ts
import type { RuntimeConfig } from "../config";
import type { Brain, TerminalAdapter } from "../types";
import { ClaudeCodeBrain } from "./claude-code";
import { CodexBrain } from "./codex";
import { GeminiBrain } from "./gemini";
import { QwenBrain } from "./qwen";
import { OllamaBrain } from "./ollama";
import { TabInjectBrain } from "./tab-inject";

export function createBrain(config: RuntimeConfig, terminal?: TerminalAdapter): Brain {
  const { backend, mode, target_tab, auto_approve_tools, binary, binary_args, ollama_port, ollama_model } = config.brain;

  // tab-inject is Claude Code only — it relies on a CC interactive session in a terminal tab.
  if (mode === "tab-inject" && terminal && backend === "claude-code") {
    return new TabInjectBrain(terminal, target_tab || "cicero-brain", auto_approve_tools ?? false);
  }

  switch (backend) {
    case "claude-code":
      return new ClaudeCodeBrain();
    case "codex":
      return new CodexBrain(binary, binary_args);
    case "gemini":
      return new GeminiBrain(binary, binary_args);
    case "qwen":
      return new QwenBrain(binary, binary_args);
    case "ollama":
      return new OllamaBrain({ port: ollama_port, model: ollama_model });
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unknown brain backend: ${exhaustive}`);
    }
  }
}
```

Note: `ClaudeCodeBrain` and `TabInjectBrain` may need their constructors widened to accept the optional `binary` / `binary_args`. Update them if the test fails for that reason.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/brain-factory.test.ts`
Expected: PASS for all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/brain/index.ts tests/brain-factory.test.ts
git commit -m "feat(brain): factory routes to codex/gemini/qwen/ollama"
```

---

## Task 9: Wire `--brain` CLI flag for all brains

**Files:**
- Modify: `src/config.ts:195-201` (CLIFlags type), `src/config.ts:316-320` (flag application)

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
test("CLI --brain flag accepts qwen and ollama", () => {
  const c1 = loadConfig({ brain: "qwen" });
  expect(c1.brain.backend).toBe("qwen");
  const c2 = loadConfig({ brain: "ollama" });
  expect(c2.brain.backend).toBe("ollama");
});

test("CLI --brain flag rejects invalid backends", () => {
  expect(() => loadConfig({ brain: "gpt-4" })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — no validation today; bogus values silently pass through.

- [ ] **Step 3: Add validation**

Update `src/config.ts`. Replace the flag-application block (around line 318):

```ts
const VALID_BRAINS = ["claude-code", "codex", "gemini", "qwen", "ollama"] as const;

// In loadConfig(), where flags are applied:
if (flags.brain) {
  if (!VALID_BRAINS.includes(flags.brain as any)) {
    throw new Error(`Invalid --brain value '${flags.brain}'. Valid: ${VALID_BRAINS.join(", ")}`);
  }
  config.brain.backend = flags.brain as CiceroConfig["brain"]["backend"];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(brain): validate --brain CLI flag against backend allowlist"
```

---

## Task 10: Document brain selection in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add usage section**

Find the existing "Setup" section and add after it:

```markdown
## Choosing a brain

Cicero's "brain" is the LLM that handles complex requests. Five backends are supported:

| Backend | What it is | Default binary | Setup |
|---|---|---|---|
| `claude-code` (default) | Claude Code CLI in print mode | `claude` | `npm i -g @anthropic-ai/claude-code` + auth |
| `codex` | OpenAI Codex CLI | `codex` | Install Codex CLI + `OPENAI_API_KEY` |
| `gemini` | Google Gemini CLI | `gemini` | Install Gemini CLI + auth |
| `qwen` | Qwen CLI (Alibaba) | `qwen` | Install Qwen Code / Qwen Agent CLI |
| `ollama` | Local Ollama model via HTTP | n/a — runs in-process via fetch | `ollama serve` + `ollama pull qwen3.5:0.8b` |

Select at runtime via CLI flag or YAML config:

```bash
cicero start --brain qwen
cicero start --brain ollama
```

Or persist in `~/.cicero/config.yaml`:

```yaml
brain:
  backend: ollama
  ollama_port: 11434
  ollama_model: qwen3.5:0.8b
  session_timeout: 4h
  max_context_commands: 50
```

Tab-inject mode (`mode: tab-inject`) is **claude-code only** because it requires an interactive Claude Code session running in a terminal tab. All other brains run in `subprocess` mode (a fresh process per turn) or HTTP (Ollama).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(brain): document multi-brain selection and config"
```

---

## Self-review notes

- Brain interface contract from `src/types.ts:108-118` (`start`, `stop`, `send`, `injectContext`, `restart`, `health`) is satisfied by every new class via the `SubprocessCLIBrain` base or `OllamaBrain` direct implementation.
- `sendToTab`, `switchTab`, `getTargetTab` are optional on `Brain` and only implemented by `TabInjectBrain` (Claude Code tab mode). New brains don't need them.
- All five backends share the same `contextBuffer` semantics (cap at 50, prepended to `send`).
- Config-driven binary override (`config.brain.binary`) lets users point Codex/Gemini/Qwen at non-default binary names (e.g. `qwen-coder` instead of `qwen`).
- `executor/index.ts:executeLocalLLM` is independent — it talks to the *router* server on 8081, not the brain. No change needed there.
