# Cicero Computer-Use (Tier A + B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Cicero the ability to *take actions on the user's behalf* — a local, cross-platform, model-driven action layer where the LLM decides and executes steps from a tool registry (local shell/files/apps + web automation), with a confirmation gate, instead of only answering.

**Headline experience (the point):** voice-driven, conversational computer use — you talk to Cicero back-and-forth and it *performs computer actions and speaks back*, reusing the existing streaming-TTS + barge-in conversational loop. The `cicero do` CLI is the testable engine; **Task 12 wires that engine into the voice loop** (spoken confirmations + narrated results). Tasks 1–10 build the engine because voice has nothing to call until it exists; Task 12 is the capstone that delivers the experience.

**Architecture:** A new `src/compute/` layer: a `Tool` registry, a JSON **action protocol** (the LLM emits one `{thought, action}` step at a time, ReAct-style), a `runAgent` loop that prompts the LLM → parses the step → checks a safety policy → (optionally confirms) → executes the tool → feeds the observation back, until a `finish` action or step cap. Tier A tools wrap local OS actions (list/read/write files, run shell, open apps); Tier B adds a Playwright browser tool. The LLM is any existing Cicero `LLMProvider` (mlx-lm / ollama / llama-cpp), and constrained JSON output (the `responseFormat` passthrough already wired into those providers) makes the model emit valid action JSON; a tolerant parser is the real guarantee. Entry point is a new `cicero do "<goal>"` command, kept decoupled from the voice loop so it is unit-testable with a fake LLM (no GPU/model needed for tests).

**Tech Stack:** Bun + TypeScript, `bun:test`, existing `LLMProvider` abstraction (`chatCompletion` + `responseFormat`), Playwright (already used elsewhere in the user's toolchain), Bun globals (`Bun.spawn`, `confirm()`).

**What we borrow from `farzaa/clicky` (MIT, attribution kept):** Clicky perceives the screen and *points* at elements via an inline `[POINT:x,y:label:screenN]` tag at the end of Claude's response, with strict format rules and few-shot examples — but it **never actuates** (no synthetic clicks). We reuse that *inline structured-action pattern and prompting discipline* (one strict machine-readable action per turn, few-shot examples, explicit "emit nothing / finish" path) and extend it to **actually execute** actions, which Clicky deliberately leaves to the human. We do **not** copy Swift code (it is macOS-only and irrelevant to Cicero's Bun/TS cross-platform core). Screen-vision + on-screen pointing (Clicky's actual UX) is explicitly **out of scope** here (Tier C/D — see end).

**Safety stance:** Every action is classified `allow` / `confirm` / `deny`. Read-only actions run freely; mutating actions (`write_file`, `shell`, browser side-effects) require confirmation; known-dangerous shell patterns are denied outright. The agent loop is bounded by a step cap. This is the core difference from a naive "let the model run commands" approach.

---

## File Structure

- `src/compute/tool.ts` — `Tool` interface + `ToolResult` type. One responsibility: the tool contract.
- `src/compute/registry.ts` — `ToolRegistry` (register/get/list/names + prompt manifest).
- `src/compute/actions.ts` — action protocol: `AgentStep`/`AgentAction` types, `parseAgentStep` (tolerant parser), `agentStepSchema` (JSON schema for constrained decoding).
- `src/compute/policy.ts` — `ActionDisposition` + `classifyAction` (allow/confirm/deny).
- `src/compute/agent-loop.ts` — `runAgent` (the ReAct loop) + `AgentLoopDeps`/`AgentResult`.
- `src/compute/tools/files.ts` — `listDirTool`, `readFileTool`, `writeFileTool`.
- `src/compute/tools/shell.ts` — `shellTool` (gated).
- `src/compute/tools/apps.ts` — `openAppTool` (cross-platform).
- `src/compute/tools/browser.ts` — `createBrowserTool` (Playwright, injectable driver).
- `src/compute/index.ts` — `buildDefaultRegistry()` + re-exports.
- `src/index.ts` — add `cicero do "<goal>"` command (modify).
- Tests mirror each module under `tests/compute/`.
- `README.md` — "Computer use" section + Clicky attribution (modify).

---

### Task 1: Tool contract

**Files:**
- Create: `src/compute/tool.ts`
- Test: `tests/compute/tool.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { Tool, ToolResult } from "../../src/compute/tool";

test("a Tool can be implemented and run, returning a ToolResult", async () => {
  const echo: Tool = {
    name: "echo",
    description: "echoes its text arg",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async run(args) {
      return { ok: true, output: String(args.text) };
    },
  };
  const result: ToolResult = await echo.run({ text: "hi" });
  expect(result).toEqual({ ok: true, output: "hi" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/tool.test.ts`
Expected: FAIL — cannot find module `../../src/compute/tool`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/tool.ts
export interface ToolResult {
  /** True when the action succeeded; false signals an error the agent should react to. */
  ok: boolean;
  /** LLM- and human-readable result or error text (fed back as the next observation). */
  output: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for this tool's `args` object. Used in the prompt + constrained decoding. */
  readonly parameters: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/tool.ts tests/compute/tool.test.ts
git commit -m "feat(compute): add Tool contract"
```

---

### Task 2: Tool registry

**Files:**
- Create: `src/compute/registry.ts`
- Test: `tests/compute/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { ToolRegistry } from "../../src/compute/registry";
import type { Tool } from "../../src/compute/tool";

const fakeTool = (name: string): Tool => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: {} },
  async run() { return { ok: true, output: name }; },
});

test("registers, looks up, and lists tools", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  reg.register(fakeTool("beta"));
  expect(reg.get("alpha")?.name).toBe("alpha");
  expect(reg.get("missing")).toBeUndefined();
  expect(reg.names().sort()).toEqual(["alpha", "beta"]);
});

test("manifest lists each tool name and description on its own line", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  const manifest = reg.manifest();
  expect(manifest).toContain("alpha");
  expect(manifest).toContain("does alpha");
});

test("registering a duplicate name throws", () => {
  const reg = new ToolRegistry();
  reg.register(fakeTool("alpha"));
  expect(() => reg.register(fakeTool("alpha"))).toThrow("alpha");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/registry.test.ts`
Expected: FAIL — cannot find module `../../src/compute/registry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/registry.ts
import type { Tool } from "./tool";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** One line per tool: `name(arg1, arg2) — description`, for the system prompt. */
  manifest(): string {
    return this.list()
      .map((tool) => {
        const props = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
        const argList = Object.keys(props).join(", ");
        return `- ${tool.name}(${argList}) — ${tool.description}`;
      })
      .join("\n");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/registry.ts tests/compute/registry.test.ts
git commit -m "feat(compute): add ToolRegistry with prompt manifest"
```

---

### Task 3: Action protocol (parse + schema)

**Files:**
- Create: `src/compute/actions.ts`
- Test: `tests/compute/actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { parseAgentStep, agentStepSchema } from "../../src/compute/actions";

test("parses a bare JSON object", () => {
  const step = parseAgentStep('{"thought":"look","action":{"tool":"list_dir","args":{"path":"."}}}');
  expect(step.thought).toBe("look");
  expect(step.action.tool).toBe("list_dir");
  expect(step.action.args).toEqual({ path: "." });
});

test("parses JSON wrapped in a ```json fence", () => {
  const text = "Sure!\n```json\n{\"thought\":\"go\",\"action\":{\"tool\":\"finish\",\"args\":{\"summary\":\"done\"}}}\n```";
  const step = parseAgentStep(text);
  expect(step.action.tool).toBe("finish");
});

test("defaults missing args to an empty object", () => {
  const step = parseAgentStep('{"thought":"t","action":{"tool":"finish"}}');
  expect(step.action.args).toEqual({});
});

test("throws on text with no JSON object", () => {
  expect(() => parseAgentStep("I cannot help with that.")).toThrow("no JSON");
});

test("throws when action.tool is missing", () => {
  expect(() => parseAgentStep('{"thought":"t","action":{}}')).toThrow("tool");
});

test("agentStepSchema constrains tool to the given names", () => {
  const schema = agentStepSchema(["list_dir", "finish"]);
  const toolEnum = (((schema.properties as any).action.properties.tool) as any).enum;
  expect(toolEnum).toEqual(["list_dir", "finish"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/actions.test.ts`
Expected: FAIL — cannot find module `../../src/compute/actions`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/actions.ts
export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentStep {
  thought: string;
  action: AgentAction;
}

/** Extract the first balanced {...} JSON object from arbitrary model text. */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;
  const start = haystack.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");
  let depth = 0;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  throw new Error("no JSON object found in model output (unbalanced braces)");
}

export function parseAgentStep(text: string): AgentStep {
  const raw = extractJsonObject(text);
  const parsed = JSON.parse(raw) as { thought?: unknown; action?: unknown };
  const action = parsed.action as { tool?: unknown; args?: unknown } | undefined;
  if (!action || typeof action.tool !== "string") {
    throw new Error("agent step is missing action.tool");
  }
  return {
    thought: typeof parsed.thought === "string" ? parsed.thought : "",
    action: {
      tool: action.tool,
      args: (action.args && typeof action.args === "object")
        ? (action.args as Record<string, unknown>)
        : {},
    },
  };
}

/** JSON Schema for the {thought, action} step, passed to responseFormat for constrained decoding. */
export function agentStepSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      action: {
        type: "object",
        properties: {
          tool: { type: "string", enum: toolNames },
          args: { type: "object" },
        },
        required: ["tool"],
      },
    },
    required: ["thought", "action"],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/actions.ts tests/compute/actions.test.ts
git commit -m "feat(compute): add action protocol parser + JSON schema"
```

---

### Task 4: Safety policy

**Files:**
- Create: `src/compute/policy.ts`
- Test: `tests/compute/policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { classifyAction } from "../../src/compute/policy";

test("read-only tools are allowed without confirmation", () => {
  expect(classifyAction({ tool: "list_dir", args: { path: "." } })).toBe("allow");
  expect(classifyAction({ tool: "read_file", args: { path: "a.txt" } })).toBe("allow");
  expect(classifyAction({ tool: "finish", args: {} })).toBe("allow");
});

test("mutating tools require confirmation", () => {
  expect(classifyAction({ tool: "write_file", args: { path: "a", content: "b" } })).toBe("confirm");
  expect(classifyAction({ tool: "shell", args: { command: "echo hi" } })).toBe("confirm");
  expect(classifyAction({ tool: "open_app", args: { name: "Safari" } })).toBe("confirm");
});

test("known-dangerous shell commands are denied outright", () => {
  expect(classifyAction({ tool: "shell", args: { command: "rm -rf /" } })).toBe("deny");
  expect(classifyAction({ tool: "shell", args: { command: "sudo reboot" } })).toBe("deny");
  expect(classifyAction({ tool: "shell", args: { command: ":(){ :|:& };:" } })).toBe("deny");
});

test("unknown tools are denied", () => {
  expect(classifyAction({ tool: "mystery", args: {} })).toBe("deny");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/policy.test.ts`
Expected: FAIL — cannot find module `../../src/compute/policy`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/policy.ts
import type { AgentAction } from "./actions";

export type ActionDisposition = "allow" | "confirm" | "deny";

const READ_ONLY_TOOLS = new Set(["list_dir", "read_file", "finish"]);
const MUTATING_TOOLS = new Set(["write_file", "shell", "open_app", "browser"]);

// Patterns we refuse regardless of confirmation — destructive, privilege-escalating, or fork-bomb.
const DANGEROUS_SHELL = [
  /\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{.*\};:/, // fork bomb
  />\s*\/dev\/sd[a-z]/i,
];

export function classifyAction(action: AgentAction): ActionDisposition {
  if (READ_ONLY_TOOLS.has(action.tool)) return "allow";
  if (!MUTATING_TOOLS.has(action.tool)) return "deny";

  if (action.tool === "shell") {
    const command = String(action.args.command ?? "");
    if (DANGEROUS_SHELL.some((pattern) => pattern.test(command))) return "deny";
  }
  return "confirm";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/policy.ts tests/compute/policy.test.ts
git commit -m "feat(compute): add action safety policy (allow/confirm/deny)"
```

---

### Task 5: Agent loop

**Files:**
- Create: `src/compute/agent-loop.ts`
- Test: `tests/compute/agent-loop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { runAgent } from "../../src/compute/agent-loop";
import { ToolRegistry } from "../../src/compute/registry";
import type { Tool } from "../../src/compute/tool";
import { classifyAction } from "../../src/compute/policy";

// A fake LLM that returns a scripted sequence of JSON steps — no model needed.
function scriptedLLM(steps: string[]) {
  let i = 0;
  return { async chatCompletion() { return steps[Math.min(i++, steps.length - 1)]; } };
}

const listDir: Tool = {
  name: "list_dir",
  description: "list a directory",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  async run(args) { return { ok: true, output: `entries of ${args.path}: a.txt` }; },
};

function registryWith(tool: Tool) {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg;
}

test("runs a tool then finishes, returning the summary", async () => {
  const llm = scriptedLLM([
    '{"thought":"look","action":{"tool":"list_dir","args":{"path":"."}}}',
    '{"thought":"done","action":{"tool":"finish","args":{"summary":"listed it"}}}',
  ]);
  const result = await runAgent("list the dir", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("listed it");
  expect(result.steps).toHaveLength(2);
});

test("a denied action does not call the tool and is reported back", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"nuke","action":{"tool":"shell","args":{"command":"rm -rf /"}}}',
    '{"thought":"ok","action":{"tool":"finish","args":{"summary":"stopped"}}}',
  ]);
  const result = await runAgent("destroy", {
    llm, registry: registryWith(shell), classify: classifyAction,
    confirm: async () => true, maxSteps: 5,
  });
  expect(ran).toBe(false);
  expect(result.summary).toBe("stopped");
});

test("declining a confirm skips the tool", async () => {
  let ran = false;
  const shell: Tool = {
    name: "shell", description: "run shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async run() { ran = true; return { ok: true, output: "ran" }; },
  };
  const llm = scriptedLLM([
    '{"thought":"x","action":{"tool":"shell","args":{"command":"echo hi"}}}',
    '{"thought":"x","action":{"tool":"finish","args":{"summary":"skipped"}}}',
  ]);
  await runAgent("do it", {
    llm, registry: registryWith(shell), classify: classifyAction,
    confirm: async () => false, maxSteps: 5,
  });
  expect(ran).toBe(false);
});

test("stops at maxSteps without finishing and returns ok=false", async () => {
  const llm = scriptedLLM(['{"thought":"loop","action":{"tool":"list_dir","args":{"path":"."}}}']);
  const result = await runAgent("loop forever", {
    llm, registry: registryWith(listDir), classify: classifyAction,
    confirm: async () => true, maxSteps: 3,
  });
  expect(result.ok).toBe(false);
  expect(result.steps).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/agent-loop.test.ts`
Expected: FAIL — cannot find module `../../src/compute/agent-loop`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/agent-loop.ts
import type { ToolRegistry } from "./registry";
import type { AgentAction, AgentStep } from "./actions";
import { parseAgentStep, agentStepSchema } from "./actions";
import type { ActionDisposition } from "./policy";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }

export interface AgentLoopDeps {
  llm: {
    chatCompletion(
      messages: ChatMessage[],
      opts?: { responseFormat?: { type: "json_schema"; json_schema: Record<string, unknown> } },
    ): Promise<string>;
  };
  registry: ToolRegistry;
  classify: (action: AgentAction) => ActionDisposition;
  confirm: (action: AgentAction) => Promise<boolean>;
  maxSteps?: number;
  log?: (message: string) => void;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  steps: AgentStep[];
}

function systemPrompt(registry: ToolRegistry): string {
  return [
    "You are Cicero's action agent. You accomplish the user's goal by taking ONE action at a time.",
    "",
    "Available tools:",
    registry.manifest(),
    "- finish(summary) — call when the goal is complete or impossible; summary is spoken to the user.",
    "",
    "Respond with ONLY a JSON object, no prose, in this exact shape:",
    '{"thought": "<one short sentence>", "action": {"tool": "<tool name>", "args": {<args>}}}',
    "",
    "Rules:",
    "- Exactly one action per response.",
    "- After each action you receive an OBSERVATION; use it to decide the next action.",
    "- When done (or if you cannot proceed), use the finish tool with a summary.",
    "",
    "Examples:",
    '{"thought":"check what is in Downloads","action":{"tool":"list_dir","args":{"path":"~/Downloads"}}}',
    '{"thought":"the goal is met","action":{"tool":"finish","args":{"summary":"opened the report"}}}',
  ].join("\n");
}

export async function runAgent(goal: string, deps: AgentLoopDeps): Promise<AgentResult> {
  const { llm, registry, classify, confirm, log } = deps;
  const maxSteps = deps.maxSteps ?? 12;
  const schema = agentStepSchema([...registry.names(), "finish"]);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(registry) },
    { role: "user", content: `GOAL: ${goal}` },
  ];
  const steps: AgentStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    const raw = await llm.chatCompletion(messages, {
      responseFormat: { type: "json_schema", json_schema: schema },
    });
    let step: AgentStep;
    try {
      step = parseAgentStep(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      messages.push({ role: "user", content: `OBSERVATION: your output was not valid (${msg}). Respond with ONLY the JSON object.` });
      continue;
    }
    steps.push(step);
    messages.push({ role: "assistant", content: raw });
    log?.(`step ${i + 1}: ${step.action.tool} — ${step.thought}`);

    if (step.action.tool === "finish") {
      return { ok: true, summary: String(step.action.args.summary ?? ""), steps };
    }

    const disposition = classify(step.action);
    if (disposition === "deny") {
      messages.push({ role: "user", content: "OBSERVATION: that action is not permitted. Choose a different action or finish." });
      continue;
    }
    if (disposition === "confirm" && !(await confirm(step.action))) {
      messages.push({ role: "user", content: "OBSERVATION: the user declined that action. Choose a different action or finish." });
      continue;
    }

    const tool = registry.get(step.action.tool);
    if (!tool) {
      messages.push({ role: "user", content: `OBSERVATION: no such tool '${step.action.tool}'.` });
      continue;
    }
    const result = await tool.run(step.action.args);
    messages.push({ role: "user", content: `OBSERVATION: ${result.ok ? "" : "(error) "}${result.output}` });
  }

  return { ok: false, summary: "reached step limit without finishing", steps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/agent-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/agent-loop.ts tests/compute/agent-loop.test.ts
git commit -m "feat(compute): add ReAct agent loop with policy + confirmation gating"
```

---

### Task 6: Tier A file tools (read-only first)

**Files:**
- Create: `src/compute/tools/files.ts`
- Test: `tests/compute/tools/files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { listDirTool, readFileTool, writeFileTool } from "../../../src/compute/tools/files";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cicero-files-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("write_file then read_file round-trips", async () => {
  const path = join(dir, "note.txt");
  const w = await writeFileTool.run({ path, content: "hello" });
  expect(w.ok).toBe(true);
  const r = await readFileTool.run({ path });
  expect(r.ok).toBe(true);
  expect(r.output).toBe("hello");
});

test("list_dir reports entries", async () => {
  await writeFileTool.run({ path: join(dir, "a.txt"), content: "x" });
  const result = await listDirTool.run({ path: dir });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("a.txt");
});

test("read_file on a missing path returns ok=false", async () => {
  const result = await readFileTool.run({ path: join(dir, "nope.txt") });
  expect(result.ok).toBe(false);
  expect(result.output.toLowerCase()).toContain("no such");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/tools/files.test.ts`
Expected: FAIL — cannot find module `files`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/tools/files.ts
import type { Tool } from "../tool";
import { readdirSync } from "node:fs";

export const listDirTool: Tool = {
  name: "list_dir",
  description: "list the entries in a directory",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run(args) {
    try {
      const entries = readdirSync(String(args.path));
      return { ok: true, output: entries.join("\n") || "(empty)" };
    } catch (err: unknown) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const readFileTool: Tool = {
  name: "read_file",
  description: "read a UTF-8 text file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async run(args) {
    try {
      const text = await Bun.file(String(args.path)).text();
      return { ok: true, output: text };
    } catch (err: unknown) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "write text to a file (overwrites)",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  async run(args) {
    try {
      await Bun.write(String(args.path), String(args.content ?? ""));
      return { ok: true, output: `wrote ${String(args.path)}` };
    } catch (err: unknown) {
      return { ok: false, output: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

Note: `Bun.file(...).text()` on a missing path rejects with a message containing "No such file" — the test lowercases and matches "no such".

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/tools/files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/tools/files.ts tests/compute/tools/files.test.ts
git commit -m "feat(compute): add file tools (list_dir/read_file/write_file)"
```

---

### Task 7: Tier A shell + open-app tools

**Files:**
- Create: `src/compute/tools/shell.ts`
- Create: `src/compute/tools/apps.ts`
- Test: `tests/compute/tools/shell.test.ts`
- Test: `tests/compute/tools/apps.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compute/tools/shell.test.ts
import { test, expect } from "bun:test";
import { shellTool } from "../../../src/compute/tools/shell";

test("shell runs a command and captures stdout", async () => {
  const result = await shellTool.run({ command: "echo cicero" });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("cicero");
});

test("shell reports a non-zero exit as ok=false with stderr", async () => {
  const result = await shellTool.run({ command: "ls /definitely/not/here/cicero" });
  expect(result.ok).toBe(false);
});
```

```ts
// tests/compute/tools/apps.test.ts
import { test, expect } from "bun:test";
import { openAppCommand } from "../../../src/compute/tools/apps";

test("open command is platform-correct", () => {
  expect(openAppCommand("Safari", "darwin")).toEqual(["open", "-a", "Safari"]);
  expect(openAppCommand("notepad", "win32")).toEqual(["cmd", "/c", "start", "", "notepad"]);
  expect(openAppCommand("gedit", "linux")).toEqual(["xdg-open", "gedit"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/compute/tools/shell.test.ts tests/compute/tools/apps.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

```ts
// src/compute/tools/shell.ts
import type { Tool } from "../tool";

export const shellTool: Tool = {
  name: "shell",
  description: "run a shell command and return its output",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  async run(args) {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, output: "empty command" };
    const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const output = (stdout + stderr).trim().slice(0, 4000);
    return { ok: exitCode === 0, output: output || `(exit ${exitCode})` };
  },
};
```

```ts
// src/compute/tools/apps.ts
import type { Tool } from "../tool";

export function openAppCommand(name: string, platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "darwin": return ["open", "-a", name];
    case "win32": return ["cmd", "/c", "start", "", name];
    default: return ["xdg-open", name];
  }
}

export const openAppTool: Tool = {
  name: "open_app",
  description: "open an application or document by name",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  async run(args) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, output: "empty app name" };
    const proc = Bun.spawn(openAppCommand(name), { stdout: "ignore", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode === 0) return { ok: true, output: `opened ${name}` };
    const stderr = (await new Response(proc.stderr).text()).trim();
    return { ok: false, output: stderr || `failed to open ${name} (exit ${exitCode})` };
  },
};
```

Note on Windows: `/bin/sh` in `shellTool` is POSIX-only; on Windows the shell tool would need `cmd /c`. That platform branch is deferred to the Windows-portability follow-up (see Out of Scope); the test runs on the dev machine (macOS/Linux).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/compute/tools/shell.test.ts tests/compute/tools/apps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/tools/shell.ts src/compute/tools/apps.ts tests/compute/tools/shell.test.ts tests/compute/tools/apps.test.ts
git commit -m "feat(compute): add shell + cross-platform open_app tools"
```

---

### Task 8: Default registry + compute index

**Files:**
- Create: `src/compute/index.ts`
- Test: `tests/compute/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { buildDefaultRegistry } from "../../src/compute";

test("default registry contains the Tier A tools", () => {
  const reg = buildDefaultRegistry();
  expect(reg.names().sort()).toEqual(["list_dir", "open_app", "read_file", "shell", "write_file"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/index.test.ts`
Expected: FAIL — cannot find module `../../src/compute`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/index.ts
import { ToolRegistry } from "./registry";
import { listDirTool, readFileTool, writeFileTool } from "./tools/files";
import { shellTool } from "./tools/shell";
import { openAppTool } from "./tools/apps";

export { ToolRegistry } from "./registry";
export { runAgent } from "./agent-loop";
export type { AgentResult, AgentLoopDeps } from "./agent-loop";
export { classifyAction } from "./policy";
export type { Tool, ToolResult } from "./tool";

/** Tier A: local OS tools. Tier B (browser) is added separately by callers that want it. */
export function buildDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [listDirTool, readFileTool, writeFileTool, shellTool, openAppTool]) {
    registry.register(tool);
  }
  return registry;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/compute/index.ts tests/compute/index.test.ts
git commit -m "feat(compute): add buildDefaultRegistry + barrel exports"
```

---

### Task 9: `cicero do` command

**Files:**
- Modify: `src/index.ts` (add command near `registerVoiceCommand(program)`)
- Test: `tests/compute/do-command.test.ts` (e2e against a fake-LLM-injected entry point)

Because the real command needs a model server, expose a testable entry function and have the CLI call it. Add the entry function to `src/compute/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { runDo } from "../../src/compute";

test("runDo drives the agent with an injected llm + auto-confirm and returns the summary", async () => {
  const llm = (() => {
    const steps = [
      '{"thought":"finish","action":{"tool":"finish","args":{"summary":"nothing to do"}}}',
    ];
    let i = 0;
    return { async chatCompletion() { return steps[Math.min(i++, steps.length - 1)]; } };
  })();

  const result = await runDo("say hi", { llm, confirm: async () => true });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("nothing to do");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/do-command.test.ts`
Expected: FAIL — `runDo` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/compute/index.ts`:

```ts
import { runAgent, type AgentResult, type AgentLoopDeps } from "./agent-loop";
import { classifyAction } from "./policy";
import type { AgentAction } from "./actions";

interface RunDoDeps {
  llm: AgentLoopDeps["llm"];
  confirm?: (action: AgentAction) => Promise<boolean>;
  maxSteps?: number;
  log?: (message: string) => void;
}

export async function runDo(goal: string, deps: RunDoDeps): Promise<AgentResult> {
  return runAgent(goal, {
    llm: deps.llm,
    registry: buildDefaultRegistry(),
    classify: classifyAction,
    confirm: deps.confirm ?? (async () => true),
    maxSteps: deps.maxSteps,
    log: deps.log,
  });
}
```

Add to `src/index.ts` (after the existing imports and near `registerVoiceCommand(program)`):

```ts
import { runDo } from "./compute";
import { createProviders } from "./backends/registry";
```

```ts
program
  .command("do <goal...>")
  .description("Let Cicero take actions to accomplish a goal (asks before anything destructive)")
  .option("--yes", "auto-confirm all actions (skip prompts)")
  .option("--max-steps <n>", "max agent steps", "12")
  .action(async (goalParts: string[], opts: { yes?: boolean; maxSteps?: string }) => {
    const goal = goalParts.join(" ");
    const config = loadConfig();
    const llm = createProviders(config).llm;
    await llm.start?.();
    const result = await runDo(goal, {
      llm,
      maxSteps: Number(opts.maxSteps ?? "12"),
      confirm: opts.yes
        ? async () => true
        : async (action) => confirm(`Cicero wants to run ${action.tool}: ${JSON.stringify(action.args)}\nAllow?`),
      log: (message) => console.error(`[cicero] ${message}`),
    });
    console.log(result.summary);
    await llm.stop?.();
    process.exit(result.ok ? 0 : 1);
  });
```

Note: `confirm()` is a Bun global that prompts on the terminal and returns a boolean.

- [ ] **Step 4: Run test + smoke-check the command parses**

Run: `bun test tests/compute/do-command.test.ts`
Expected: PASS.

Run: `bun src/index.ts do --help`
Expected: prints the `do` command help with `--yes` and `--max-steps`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/compute/index.ts tests/compute/do-command.test.ts
git commit -m "feat(cli): add 'cicero do' command driving the compute agent"
```

---

### Task 10: Tier B — Playwright browser tool

**Files:**
- Create: `src/compute/tools/browser.ts`
- Test: `tests/compute/tools/browser.test.ts`

The Playwright dependency is injected so unit tests use a fake page (no browser download required). A real-browser smoke test is documented at the end of the task, not run in CI.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { createBrowserTool, type BrowserDriver } from "../../../src/compute/tools/browser";

function fakeDriver(): { driver: BrowserDriver; calls: string[] } {
  const calls: string[] = [];
  const driver: BrowserDriver = {
    async navigate(url) { calls.push(`navigate:${url}`); },
    async click(selector) { calls.push(`click:${selector}`); },
    async type(selector, text) { calls.push(`type:${selector}:${text}`); },
    async readText() { calls.push("readText"); return "page body text"; },
    async close() { calls.push("close"); },
  };
  return { driver, calls };
}

test("browser navigate dispatches to the driver", async () => {
  const { driver, calls } = fakeDriver();
  const tool = createBrowserTool(async () => driver);
  const result = await tool.run({ action: "navigate", url: "https://example.com" });
  expect(result.ok).toBe(true);
  expect(calls).toContain("navigate:https://example.com");
});

test("browser read returns the page text", async () => {
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async () => driver);
  const result = await tool.run({ action: "read" });
  expect(result.output).toContain("page body text");
});

test("an unknown browser action returns ok=false", async () => {
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async () => driver);
  const result = await tool.run({ action: "teleport" });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/tools/browser.test.ts`
Expected: FAIL — cannot find module `browser`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/compute/tools/browser.ts
import type { Tool } from "../tool";

export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  readText(): Promise<string>;
  close(): Promise<void>;
}

/** Default driver factory: launches Chromium via Playwright. Lazy-imported so the
 *  dependency is only required when the browser tool actually runs. */
async function launchPlaywrightDriver(): Promise<BrowserDriver> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  return {
    async navigate(url) { await page.goto(url); },
    async click(selector) { await page.click(selector); },
    async type(selector, text) { await page.fill(selector, text); },
    async readText() { return (await page.innerText("body")).slice(0, 4000); },
    async close() { await browser.close(); },
  };
}

export function createBrowserTool(makeDriver: () => Promise<BrowserDriver> = launchPlaywrightDriver): Tool {
  let driver: BrowserDriver | null = null;
  const ensure = async () => (driver ??= await makeDriver());

  return {
    name: "browser",
    description: "control a web browser: navigate|click|type|read",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "read"] },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    },
    async run(args) {
      try {
        const action = String(args.action);
        const d = await ensure();
        switch (action) {
          case "navigate": await d.navigate(String(args.url)); return { ok: true, output: `navigated to ${String(args.url)}` };
          case "click": await d.click(String(args.selector)); return { ok: true, output: `clicked ${String(args.selector)}` };
          case "type": await d.type(String(args.selector), String(args.text ?? "")); return { ok: true, output: `typed into ${String(args.selector)}` };
          case "read": return { ok: true, output: await d.readText() };
          default: return { ok: false, output: `unknown browser action '${action}'` };
        }
      } catch (err: unknown) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/compute/tools/browser.test.ts`
Expected: PASS.

Real-browser smoke test (manual, requires `bunx playwright install chromium`):

```bash
bun -e "import('./src/compute/tools/browser').then(async ({createBrowserTool})=>{const t=createBrowserTool();console.log(await t.run({action:'navigate',url:'https://example.com'}));console.log(await t.run({action:'read'}));})"
```
Expected: navigates and prints "Example Domain" body text.

- [ ] **Step 5: Commit**

```bash
git add src/compute/tools/browser.ts tests/compute/tools/browser.test.ts
git commit -m "feat(compute): add Playwright browser tool (injectable driver)"
```

---

### Task 11: Wire browser into a `--web` flag + docs

**Files:**
- Modify: `src/compute/index.ts` (let `buildDefaultRegistry` optionally include the browser tool)
- Modify: `src/index.ts` (`do` command gets `--web`)
- Modify: `README.md` (Computer use section + Clicky attribution)
- Test: `tests/compute/index.test.ts` (extend)

- [ ] **Step 1: Write the failing test (extend index.test.ts)**

```ts
test("registry includes browser when web is enabled", () => {
  const reg = buildDefaultRegistry({ web: true });
  expect(reg.names()).toContain("browser");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/compute/index.test.ts`
Expected: FAIL — `buildDefaultRegistry` takes no args / no `browser`.

- [ ] **Step 3: Implement**

In `src/compute/index.ts`, update `buildDefaultRegistry`:

```ts
import { createBrowserTool } from "./tools/browser";

export function buildDefaultRegistry(opts: { web?: boolean } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [listDirTool, readFileTool, writeFileTool, shellTool, openAppTool]) {
    registry.register(tool);
  }
  if (opts.web) registry.register(createBrowserTool());
  return registry;
}
```

Update `runDo` to pass through the option:

```ts
export async function runDo(goal: string, deps: RunDoDeps & { web?: boolean }): Promise<AgentResult> {
  return runAgent(goal, {
    llm: deps.llm,
    registry: buildDefaultRegistry({ web: deps.web }),
    classify: classifyAction,
    confirm: deps.confirm ?? (async () => true),
    maxSteps: deps.maxSteps,
    log: deps.log,
  });
}
```

In `src/index.ts`, add `.option("--web", "enable the browser tool (Playwright)")` to the `do` command and pass `web: opts.web` into `runDo`.

Add a `## Computer use` section to `README.md`:

```markdown
## Computer use (experimental)

`cicero do "<goal>"` lets Cicero take actions, not just answer — it picks tools
(list/read/write files, run shell, open apps, and optionally a Playwright browser
with `--web`) one step at a time using your configured local LLM. Mutating actions
prompt for confirmation; destructive shell patterns are refused outright.

```bash
cicero do "summarize the README files in this folder"
cicero do --web "find the current Bun version on bun.sh"
cicero do --yes "open my notes app"   # skip confirmation prompts
```

Runs fully local on your configured `llm` backend (mlx-lm / ollama / llama-cpp);
constrained JSON decoding keeps the model's actions well-formed.

The inline-action pattern is inspired by [Clicky](https://github.com/farzaa/clicky)
(MIT) — which points at on-screen elements but leaves the clicking to you. Cicero
extends the idea to actually execute actions, behind a confirmation gate.
```

- [ ] **Step 4: Run tests + suite**

Run: `bun test tests/compute/ && bun test`
Expected: all PASS; full suite green.

Run: `bun run tsc --noEmit | grep -c "error TS"`
Expected: baseline count unchanged (no new errors in `src/compute/` or `src/index.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/compute/index.ts src/index.ts README.md tests/compute/index.test.ts
git commit -m "feat(compute): --web browser flag + docs/attribution"
```

---

### Task 12: Voice-driven computer use (the headline / capstone)

**Goal of this task:** when the user *speaks* an action request in conversational mode, run the compute agent, **confirm risky steps out loud**, and **narrate progress + the result through the existing streaming TTS** — full back-and-forth.

**Files:**
- Create: `src/compute/voice.ts` — `parseAffirmative`, `makeVoiceConfirm`, `makeVoiceNarrator` (the voice adapters for the agent loop's injected `confirm`/`log`).
- Modify: `src/listener/conversational.ts` — route action-intent utterances into `runAgent` (detail step-by-step against the file's actual interfaces when reached).
- Test: `tests/compute/voice.test.ts`.

**Design:** `runAgent` already accepts injected `confirm(action) => Promise<boolean>` and `log(message)`. This task supplies *voice* implementations and gates entry on action-intent:
- `parseAffirmative(transcript)` — pure function: true for "yes/yeah/yep/sure/do it/go ahead/confirm", false otherwise. This is the unit-testable core (no audio).
- `makeVoiceConfirm({ speak, listenOnce })` — returns a `confirm(action)` that `speak`s "About to {tool}: {args}. Say yes to continue." then `listenOnce()` (one STT turn) and returns `parseAffirmative(transcript)`.
- `makeVoiceNarrator({ speak })` — returns a `log(message)` that speaks each step's thought via the existing `Speaker`/streaming TTS.
- Conversational wiring: when an utterance is an action request (v1 heuristic: leading action verb — do/open/run/find/create/delete/summarize — or router classification), call `runAgent(goal, { llm, registry: buildDefaultRegistry(), classify: classifyAction, confirm: voiceConfirm, log: narrator })` and speak `result.summary`; otherwise normal chat. Barge-in stays intact (interrupting cancels the agent like any TTS).

- [ ] **Step 1: Write the failing test** — `tests/compute/voice.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseAffirmative, makeVoiceConfirm } from "../../src/compute/voice";

test("parseAffirmative recognizes common yes/no phrasings", () => {
  for (const yes of ["yes", "Yeah", "do it", "go ahead", "sure", "confirm"]) {
    expect(parseAffirmative(yes)).toBe(true);
  }
  for (const no of ["no", "stop", "cancel", "nah", ""]) {
    expect(parseAffirmative(no)).toBe(false);
  }
});

test("makeVoiceConfirm speaks a prompt then resolves from the spoken reply", async () => {
  const spoken: string[] = [];
  const confirm = makeVoiceConfirm({
    speak: async (text) => { spoken.push(text); },
    listenOnce: async () => "yes do it",
  });
  const allowed = await confirm({ tool: "open_app", args: { name: "Safari" } });
  expect(allowed).toBe(true);
  expect(spoken.join(" ")).toContain("open_app");
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test tests/compute/voice.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/compute/voice.ts`:

```ts
import type { AgentAction } from "./actions";

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm|go ahead|do it)\b/i;

export function parseAffirmative(transcript: string): boolean {
  return AFFIRMATIVE.test(transcript.trim());
}

export interface VoiceConfirmDeps {
  speak: (text: string) => Promise<void>;
  listenOnce: () => Promise<string>;
}

export function makeVoiceConfirm(deps: VoiceConfirmDeps): (action: AgentAction) => Promise<boolean> {
  return async (action) => {
    await deps.speak(`About to ${action.tool}: ${JSON.stringify(action.args)}. Say yes to continue.`);
    const reply = await deps.listenOnce();
    return parseAffirmative(reply);
  };
}

export function makeVoiceNarrator(deps: { speak: (text: string) => Promise<void> }): (message: string) => void {
  return (message) => { void deps.speak(message); };
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun test tests/compute/voice.test.ts` → PASS.

- [ ] **Step 5: Wire into the conversational listener.** Read `src/listener/conversational.ts`, identify where a finalized transcript is dispatched, add an action-intent branch that builds the voice `confirm`/`log` from the existing `Speaker` + a one-shot STT turn and calls `runAgent`, speaking the summary. Add a focused test for the intent gate. **This step touches the load-bearing conversational loop — checkpoint with the user before/after per the verify-before-stacking norm.**

- [ ] **Step 6: Commit**

```bash
git add src/compute/voice.ts tests/compute/voice.test.ts src/listener/conversational.ts
git commit -m "feat(compute): voice-driven computer use in conversational mode"
```

---

## Out of Scope (future tiers)

- **Tier C — native GUI control (no vision):** read the focused app's accessibility tree (macOS `AXUIElement`, Windows UI Automation) and actuate via synthesized events. More reliable than pixels; needs native bindings per OS. Would slot in as another `Tool`.
- **Tier D — screen-vision + on-screen pointing (true Clicky parity):** screen capture → vision model → coordinates → actuate, plus an animated-pointer overlay. Reuse Clicky's `[POINT:x,y:label:screenN]` *prompt pattern* (documented in `CompanionManager.swift`) and its multi-monitor coordinate mapping, but Cicero needs (a) a native app shell for capture + transparent overlay (Cicero is a CLI/daemon today) and (b) either a local vision model to stay on-thesis or an optional cloud computer-use backend. This is the expensive, genuinely-new surface — plan separately.
- **Windows shell tool:** `shellTool` currently shells via `/bin/sh`; add a `cmd /c` branch under the Windows-portability work.

## Self-Review

**Spec coverage:** Tool contract (T1), registry (T2), action protocol + constrained-decoding schema (T3), safety policy with deny/confirm (T4), agent loop with gating + step cap (T5), Tier A tools — files/shell/open_app (T6–T7), default registry (T8), `cicero do` entry + CLI (T9), Tier B Playwright browser (T10), browser wiring + docs + Clicky attribution (T11). The "actually does stuff" goal, local-first (fake-LLM tests, configured local `llm`), cross-platform `open_app`, and the safety stance are all covered.

**Placeholder scan:** No TBD/"handle errors"/"similar to" — every code step is complete. Error handling is concrete (try/catch returning `ok:false` with the message).

**Type consistency:** `Tool`/`ToolResult` (T1) reused everywhere; `AgentAction`/`AgentStep` (T3) used by policy (T4) and loop (T5); `ToolRegistry` methods (`register/get/names/manifest`) consistent T2→T5/T8; `runAgent`/`AgentLoopDeps`/`AgentResult` consistent T5→T9; `buildDefaultRegistry` signature evolves T8→T11 (the extension is the explicit subject of T11). `responseFormat` shape matches the existing `LLMCompletionOpts` and the mlx-lm/ollama/llama-cpp providers' passthrough.
