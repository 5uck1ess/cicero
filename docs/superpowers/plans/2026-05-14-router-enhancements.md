# Router Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four additions to `src/router/`: (1) embedding-based action filter that shrinks the action catalog the LLM router sees, preventing context rot as MCPs are added later; (2) adaptive tone classifier that injects per-turn tone hints into the brain prompt; (3) documented router-model options (the existing Qwen3 baseline plus SmolLM2-1.7B / Gemma 3n E4B / Hermes 2 Pro Mistral 7B), surfaced as tier presets; (4) constrained-decoding JSON grammar support on the `LLMProvider` interface — the "biggest reliability win" called out in the original backend-abstraction spec.

**Architecture:** The embedding filter runs as a Python sentence-transformers server (port 8084, new) that returns top-K matching action names for a given transcript. The router calls it before building the LLM prompt, so the prompt only includes relevant actions. Adaptive tone is a small classifier (regex-based first, optional LLM upgrade) that adds `tone: surgical | pragmatic | warm | neutral` to the router result. Router-model choice is a config switch — the existing `LLMRouter` already supports any model the LLM provider serves. Constrained decoding is plumbed through `LLMProvider.chatCompletion(messages, { jsonSchema })` and per-provider: Ollama uses `format: { type: "json_schema", ... }`; mlx-lm uses a logits processor (or `outlines` library); Claude API uses its tool-use schema natively.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, new Python server using `sentence-transformers` (`all-MiniLM-L6-v2` default), FastAPI. No new TS deps.

**Source inspiration:** [`isair/jarvis`](https://github.com/isair/jarvis) — embedding-based tool router and adaptive tone classification. Non-commercial license: read for patterns; reimplement clean in TS, do not vendor.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/router/embedding-filter.ts` | NEW | Calls embedding server, returns top-K action names for a transcript |
| `src/router/tone-classifier.ts` | NEW | Classifies tone for adaptive prompting |
| `src/router/llm-router.ts` | MODIFY | Use embedding filter to shrink action list passed to `buildSystemPrompt` |
| `src/router/index.ts` | MODIFY | Compose router with filter + tone classifier |
| `src/types.ts` | MODIFY | Add `tone` field to `RouterResult`; add embedding server config |
| `src/config.ts` | MODIFY | Add embedding config; add router-model option presets |
| `src/backends/llm/provider.ts` | MODIFY | Add optional `jsonSchema` to `LLMCompletionOpts` for constrained decoding |
| `src/backends/llm/ollama.ts` | MODIFY | Plumb `jsonSchema` through to Ollama's `format` field |
| `src/backends/llm/mlx-lm.ts` | MODIFY | Plumb `jsonSchema` through (either via logits processor or `outlines` server-side) |
| `src/router/llm-router.ts` | MODIFY | Pass the routing-output schema into `chatCompletion()` |
| `servers/embedding_server.py` | NEW | sentence-transformers HTTP service |
| `tests/router-embedding-filter.test.ts` | NEW | Tests for filter logic (with mocked server) |
| `tests/router-tone-classifier.test.ts` | NEW | Tone classification tests |
| `tests/router-llm-router.test.ts` | MODIFY | Update for new tone field |

---

## Task 1: Embedding server (Python)

**Files:**
- Create: `servers/embedding_server.py`

The router will call `http://localhost:8084/topk?q=<transcript>&k=5` and receive a list of action names ranked by cosine similarity between the transcript and the action's example utterances.

- [ ] **Step 1: Write the server**

```python
# servers/embedding_server.py
"""
Embedding server for Cicero action filtering.

Endpoints:
  POST /embed_actions   — re-index the action catalog. Body: {"actions": {name: ["example", ...]}}
  GET  /topk            — return top-K action names. Query: q=<transcript>, k=<int>
  GET  /health          — readiness check
"""

from __future__ import annotations
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import numpy as np
import uvicorn
import argparse
import logging

logger = logging.getLogger("embedding_server")
app = FastAPI()

class State:
    model: SentenceTransformer | None = None
    action_names: list[str] = []
    action_embeddings: np.ndarray | None = None

state = State()

class IndexRequest(BaseModel):
    actions: dict[str, list[str]]  # name -> example utterances

@app.on_event("startup")
async def startup():
    state.model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    logger.info("loaded sentence-transformers/all-MiniLM-L6-v2")

@app.post("/embed_actions")
async def embed_actions(req: IndexRequest):
    if state.model is None:
        return {"error": "model not loaded"}
    names = list(req.actions.keys())
    # For each action, combine all examples into one passage, embed, average.
    embeddings = []
    for name in names:
        examples = req.actions[name]
        if not examples:
            embeddings.append(np.zeros(state.model.get_sentence_embedding_dimension()))
            continue
        embs = state.model.encode(examples, normalize_embeddings=True)
        embeddings.append(np.mean(embs, axis=0))
    state.action_names = names
    state.action_embeddings = np.vstack(embeddings)
    return {"indexed": len(names)}

@app.get("/topk")
async def topk(q: str, k: int = 5):
    if state.model is None or state.action_embeddings is None:
        return {"matches": []}
    qe = state.model.encode([q], normalize_embeddings=True)[0]
    scores = state.action_embeddings @ qe
    top_idx = np.argsort(scores)[::-1][:k]
    return {
        "matches": [
            {"name": state.action_names[i], "score": float(scores[i])}
            for i in top_idx
        ]
    }

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "indexed": len(state.action_names),
        "model_loaded": state.model is not None,
    }

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8084)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
```

- [ ] **Step 2: Add to uv venv setup**

In Cicero's existing `uv pip install` step in `README.md`, add `sentence-transformers`:

```bash
uv pip install --python .venv/bin/python3 \
  "mlx-audio>=0.4.0" "mlx-lm>=0.30.5" "mlx-whisper>=0.4.0" \
  fastapi uvicorn sentence-transformers \
  --prerelease=allow
```

- [ ] **Step 3: Smoke test the server**

```bash
.venv/bin/python3 servers/embedding_server.py --port 8084 &
sleep 5
curl -X POST http://localhost:8084/embed_actions \
  -H "Content-Type: application/json" \
  -d '{"actions": {"tab_switch": ["switch to {tab}", "go to {tab}"], "calendar": ["meetings today"]}}'
# Expected: {"indexed": 2}
curl 'http://localhost:8084/topk?q=show+me+my+tabs&k=2'
# Expected: tab_switch ranked first
```

- [ ] **Step 4: Commit**

```bash
git add servers/embedding_server.py README.md
git commit -m "feat(router): add sentence-transformers embedding server on port 8084"
```

---

## Task 2: TypeScript client for the embedding filter

**Files:**
- Create: `src/router/embedding-filter.ts`
- Test: `tests/router-embedding-filter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock, beforeEach } from "bun:test";
import { EmbeddingFilter } from "../src/router/embedding-filter";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });

test("EmbeddingFilter indexes actions on first use", async () => {
  let captured: any = null;
  globalThis.fetch = mock(async (url: string, init?: any) => {
    if (url.endsWith("/embed_actions")) {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ indexed: 2 }));
    }
    if (url.includes("/topk")) {
      return new Response(JSON.stringify({ matches: [{ name: "tab_switch", score: 0.9 }] }));
    }
    return new Response("", { status: 500 });
  }) as any;

  const filter = new EmbeddingFilter({ port: 8084 });
  await filter.index({
    tab_switch: { category: "terminal", command: "x", tts_mode: "silent", examples: ["switch to {tab}"] },
    calendar: { category: "cli", command: "y", tts_mode: "summary", examples: ["meetings today"] },
  });
  expect(captured.actions).toHaveProperty("tab_switch");
});

test("EmbeddingFilter returns top-K action names", async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ matches: [
      { name: "tab_switch", score: 0.9 },
      { name: "calendar", score: 0.4 },
    ] }))
  ) as any;

  const filter = new EmbeddingFilter({ port: 8084 });
  const names = await filter.topK("switch to sales", 2);
  expect(names).toEqual(["tab_switch", "calendar"]);
});

test("EmbeddingFilter falls back to all actions on server error", async () => {
  globalThis.fetch = mock(async () => new Response("", { status: 503 })) as any;
  const filter = new EmbeddingFilter({ port: 8084 });
  const names = await filter.topK("anything", 5);
  expect(names).toEqual([]); // empty signals "no filter, use all"
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/router-embedding-filter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/router/embedding-filter.ts
import type { ActionConfig } from "../types";
import { log } from "../logger";

export interface EmbeddingFilterConfig {
  port?: number;
  host?: string;
}

export class EmbeddingFilter {
  private port: number;
  private host: string;

  constructor(config: EmbeddingFilterConfig = {}) {
    this.port = config.port ?? 8084;
    this.host = config.host ?? "127.0.0.1";
  }

  async index(actions: Record<string, ActionConfig>): Promise<void> {
    const body = {
      actions: Object.fromEntries(
        Object.entries(actions).map(([name, a]) => [name, a.examples]),
      ),
    };
    try {
      const res = await fetch(`http://${this.host}:${this.port}/embed_actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`embed_actions returned ${res.status}`);
    } catch (err) {
      log("warn", `EmbeddingFilter index failed: ${(err as Error).message}`);
    }
  }

  async topK(transcript: string, k = 8): Promise<string[]> {
    try {
      const url = `http://${this.host}:${this.port}/topk?q=${encodeURIComponent(transcript)}&k=${k}`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json() as { matches: { name: string; score: number }[] };
      return data.matches.map(m => m.name);
    } catch (err) {
      log("info", `EmbeddingFilter topK failed: ${(err as Error).message}`);
      return [];
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/router-embedding-filter.test.ts`
Expected: PASS for all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/router/embedding-filter.ts tests/router-embedding-filter.test.ts
git commit -m "feat(router): add EmbeddingFilter client for action top-K"
```

---

## Task 3: Wire EmbeddingFilter into LLMRouter

**Files:**
- Modify: `src/router/llm-router.ts`
- Test: extend `tests/router-llm-router.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/router-llm-router.test.ts`:

```ts
test("LLMRouter with filter only includes top-K actions in system prompt", async () => {
  let capturedPrompt = "";
  const fakeProvider = {
    name: "fake",
    chatCompletion: async (messages: any[]) => {
      capturedPrompt = messages[0].content;
      return JSON.stringify({ intent: "tab_switch", category: "terminal", params: {}, confidence: 0.9 });
    },
    health: async () => true,
  };
  const fakeFilter = {
    topK: async () => ["tab_switch", "calendar"],  // 2 out of 10
  };
  const router = new LLMRouter(fakeProvider as any, fakeFilter as any);

  const actions: Record<string, ActionConfig> = {};
  for (let i = 0; i < 10; i++) actions[`a${i}`] = {
    category: "local", command: "", tts_mode: "silent", examples: [`example ${i}`],
  };
  actions.tab_switch = { category: "terminal", command: "", tts_mode: "silent", examples: ["switch to {tab}"] };
  actions.calendar = { category: "cli", command: "", tts_mode: "summary", examples: ["meetings"] };

  await router.classify("switch to sales", actions);

  expect(capturedPrompt).toContain("tab_switch");
  expect(capturedPrompt).toContain("calendar");
  expect(capturedPrompt).not.toContain("a0");
});

test("LLMRouter without filter falls back to full action list", async () => {
  let capturedPrompt = "";
  const fakeProvider = {
    name: "fake",
    chatCompletion: async (messages: any[]) => {
      capturedPrompt = messages[0].content;
      return JSON.stringify({ intent: "complex", category: "brain", params: {}, confidence: 0.5 });
    },
    health: async () => true,
  };
  const router = new LLMRouter(fakeProvider as any);  // no filter

  const actions: Record<string, ActionConfig> = {
    a: { category: "local", command: "", tts_mode: "silent", examples: ["a thing"] },
    b: { category: "local", command: "", tts_mode: "silent", examples: ["b thing"] },
  };
  await router.classify("hello", actions);
  expect(capturedPrompt).toContain("a (local)");
  expect(capturedPrompt).toContain("b (local)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/router-llm-router.test.ts`
Expected: FAIL — `LLMRouter` constructor takes only one arg today.

- [ ] **Step 3: Modify LLMRouter**

Replace the constructor and `classify` in `src/router/llm-router.ts`:

```ts
import type { EmbeddingFilter } from "./embedding-filter";

export class LLMRouter implements Router {
  private provider: LLMProvider;
  private filter?: EmbeddingFilter;

  constructor(provider: LLMProvider, filter?: EmbeddingFilter) {
    this.provider = provider;
    this.filter = filter;
  }

  async classify(text: string, actions: Record<string, ActionConfig>, context?: string): Promise<RouterResult> {
    // If filter available, shrink the action list to top-K relevant ones.
    let scopedActions = actions;
    if (this.filter) {
      const top = await this.filter.topK(text, 8);
      if (top.length > 0) {
        scopedActions = Object.fromEntries(
          Object.entries(actions).filter(([name]) => top.includes(name)),
        ) as Record<string, ActionConfig>;
      }
    }

    const systemPrompt = this.buildSystemPrompt(scopedActions);
    // ... rest of existing classify() body using scopedActions in place of actions
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/router-llm-router.test.ts`
Expected: PASS for both new tests; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/router/llm-router.ts tests/router-llm-router.test.ts
git commit -m "feat(router): wire EmbeddingFilter to scope LLM router prompt to top-K actions"
```

---

## Task 4: Tone classifier

**Files:**
- Create: `src/router/tone-classifier.ts`
- Test: `tests/router-tone-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { classifyTone } from "../src/router/tone-classifier";

test("classifyTone returns 'surgical' for code-related text", () => {
  expect(classifyTone("fix the bug in auth.ts")).toBe("surgical");
  expect(classifyTone("refactor the database connection")).toBe("surgical");
  expect(classifyTone("what does this stack trace mean")).toBe("surgical");
});

test("classifyTone returns 'pragmatic' for business/work text", () => {
  expect(classifyTone("check my email")).toBe("pragmatic");
  expect(classifyTone("what's on my calendar")).toBe("pragmatic");
  expect(classifyTone("send a slack to the team")).toBe("pragmatic");
});

test("classifyTone returns 'warm' for wellbeing/personal text", () => {
  expect(classifyTone("I'm tired")).toBe("warm");
  expect(classifyTone("how are you")).toBe("warm");
  expect(classifyTone("tell me a joke")).toBe("warm");
});

test("classifyTone returns 'neutral' for everything else", () => {
  expect(classifyTone("what time is it")).toBe("neutral");
  expect(classifyTone("switch to the sales tab")).toBe("neutral");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/router-tone-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/router/tone-classifier.ts

export type Tone = "surgical" | "pragmatic" | "warm" | "neutral";

const SURGICAL_KEYWORDS = [
  "bug", "fix", "refactor", "debug", "stack trace", "compile", "build",
  "lint", "test", "merge conflict", "git", "diff", "commit", "branch",
  "function", "class", "method", "variable", "type", "interface",
  "api", "endpoint", "schema", "migration", "deploy",
];

const PRAGMATIC_KEYWORDS = [
  "email", "calendar", "meeting", "schedule", "slack", "message",
  "team", "project", "deadline", "client", "invoice", "report",
  "agenda", "task", "todo", "priority", "pipeline",
];

const WARM_KEYWORDS = [
  "tired", "stressed", "happy", "sad", "feel", "feeling",
  "how are you", "good morning", "thank you", "thanks",
  "joke", "story", "fun", "tell me about yourself",
];

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

export function classifyTone(text: string): Tone {
  if (containsAny(text, SURGICAL_KEYWORDS)) return "surgical";
  if (containsAny(text, PRAGMATIC_KEYWORDS)) return "pragmatic";
  if (containsAny(text, WARM_KEYWORDS)) return "warm";
  return "neutral";
}

export function tonePromptModifier(tone: Tone): string {
  switch (tone) {
    case "surgical": return "Be precise and technical. Skip pleasantries.";
    case "pragmatic": return "Be brief and action-oriented.";
    case "warm": return "Be friendly and conversational.";
    case "neutral": return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/router-tone-classifier.test.ts`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/router/tone-classifier.ts tests/router-tone-classifier.test.ts
git commit -m "feat(router): add keyword-based tone classifier"
```

---

## Task 5: Surface tone in RouterResult and inject into brain prompt

**Files:**
- Modify: `src/types.ts`
- Modify: `src/router/llm-router.ts`
- Modify: `src/executor/index.ts:executeBrain`

- [ ] **Step 1: Write the failing test**

Add to `tests/router-llm-router.test.ts`:

```ts
test("LLMRouter result includes tone classification", async () => {
  const fakeProvider = {
    name: "fake",
    chatCompletion: async () => JSON.stringify({ intent: "complex", category: "brain", params: {}, confidence: 0.9 }),
    health: async () => true,
  };
  const router = new LLMRouter(fakeProvider as any);
  const result = await router.classify("fix the bug in auth.ts", {});
  expect(result.tone).toBe("surgical");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/router-llm-router.test.ts`
Expected: FAIL — `tone` not on `RouterResult`.

- [ ] **Step 3: Add tone to RouterResult and wire**

In `src/types.ts`:

```ts
export interface RouterResult {
  intent: string;
  category: "terminal" | "cli" | "brain" | "local" | "local-llm";
  params: Record<string, string>;
  confidence: number;
  tone?: "surgical" | "pragmatic" | "warm" | "neutral";
}
```

In `src/router/llm-router.ts:classify`, at the end (after parsing the response):

```ts
import { classifyTone } from "./tone-classifier";

// inside classify():
const result = this.parseResponse(content);
result.tone = classifyTone(text);
return result;
```

In `src/executor/index.ts:executeBrain`, prepend the tone modifier:

```ts
import { tonePromptModifier } from "../router/tone-classifier";

private async executeBrain(route: RouterResult, originalText: string): Promise<ExecutionResult> {
  // ... existing message building ...
  const toneHint = route.tone ? tonePromptModifier(route.tone) : "";
  const finalMessage = toneHint ? `${toneHint}\n\n${message}` : message;
  const output = await this.brain.send(finalMessage);
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/router-llm-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/router/llm-router.ts src/executor/index.ts
git commit -m "feat(router): inject tone hint into brain prompt"
```

---

## Task 6: Document router model options

**Files:**
- Modify: `README.md`
- Modify: `src/backends/tiers.ts` (no new tier presets — add comment block linking to model recommendations)

Reference: [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md#llm-router). Every model below is a config swap, not a code change.

- [ ] **Step 1: Add a comment block to `tiers.ts` listing the supported router models**

```ts
// src/backends/tiers.ts — at the top of TIER_PRESETS
// Router model options (set via llm.model or per-tier override):
//   - Qwen3.5-0.8B-MLX-4bit (Mac default, ~0.5 GB)
//   - qwen3:1.7b / qwen3.5:4b via Ollama (CUDA default, ~1.1 / ~2.4 GB)
//   - smollm2:1.7b via Ollama — lower latency than Qwen3
//   - gemma3n:e4b via Ollama — best sub-10B LMArena Elo, ~3 GB
//   - hermes2-pro-mistral:7b — best dedicated tool-calling small model, ~7 GB
// See docs/superpowers/model-recommendations-may-2026.md (LLM router section) for tradeoffs.
```

(Verify the exact Ollama tag names before merging — the registry on ollama.com is the source of truth for what's pullable today. Model strings update; the role doesn't.)

- [ ] **Step 2: Document in README**

Add a "Tuning the router model" subsection under Configuration:

```markdown
### Tuning the router model

The router classifies each voice command into a JSON intent. Pick a model based on your hardware and accuracy budget — all of them are config swaps, no code changes.

| Model | VRAM | When to use |
|---|---|---|
| Qwen3.5-0.8B (MLX) | ~0.5 GB | Mac default; solid baseline |
| qwen3:1.7b / qwen3.5:4b | 1.1 / 2.4 GB | CUDA default |
| smollm2:1.7b | ~1.0 GB | Lower latency than Qwen3 for pure classification |
| gemma3n:e4b | ~3 GB | Higher accuracy if VRAM allows |
| hermes2-pro-mistral:7b | ~7 GB | Heavy tool-calling load (Plan 4 MCP tools) |
| claude-haiku-4-5 (API) | 0 GB local | Offload when local GPU is busy — see Plan 0 |

Example config:

\`\`\`yaml
llm:
  backend: ollama
  port: 11434
  model: smollm2:1.7b
\`\`\`

See [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md) for the full rationale.
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/tiers.ts README.md
git commit -m "docs(router): document model options and link to recommendations doc"
```

---

## Task 7: Constrained-decoding JSON grammar in `LLMProvider`

The original backend-abstraction spec calls XGrammar / grammar-based constrained decoding "the biggest reliability win" — 100% JSON compliance at <40 µs/token regardless of model size. This task plumbs that through the existing provider interface so every router call returns valid JSON without any retry logic.

**Files:**
- Modify: `src/backends/llm/provider.ts` (extend `LLMCompletionOpts`)
- Modify: `src/backends/llm/ollama.ts` (plumb to Ollama's `format` field)
- Modify: `src/backends/llm/mlx-lm.ts` (plumb to mlx-lm logits processor OR add `outlines` server-side wrapper)
- Modify: `src/backends/llm/claude-api.ts` (if Plan 0 is done — map to tool-use schema)
- Modify: `src/router/llm-router.ts` (build the routing-output schema and pass it to `chatCompletion()`)
- Modify: `tests/router.test.ts` (verify JSON-shape contract on mocked provider)

- [ ] **Step 1: Extend `LLMCompletionOpts`**

```typescript
// src/backends/llm/provider.ts
export interface LLMCompletionOpts {
  temperature?: number;
  max_tokens?: number;
  jsonSchema?: object;  // NEW — JSON Schema object describing required output shape
}
```

- [ ] **Step 2: Plumb through `OllamaProvider`**

Ollama supports JSON-schema-constrained output via `format` (since v0.5). Map `opts.jsonSchema` directly:

```typescript
// src/backends/llm/ollama.ts — inside chatCompletion
const body: Record<string, unknown> = {
  model: this.model,
  messages,
  options: {
    temperature: opts?.temperature ?? 0.0,
    num_predict: opts?.max_tokens ?? 100,
  },
  stream: false,
};
if (opts?.jsonSchema) {
  body.format = opts.jsonSchema;
}
```

- [ ] **Step 3: Plumb through `MlxLmProvider`**

mlx-lm's `mlx_lm.server` exposes `response_format: { type: "json_schema", json_schema: { schema: ... } }` (OpenAI-compatible). Same mapping:

```typescript
// src/backends/llm/mlx-lm.ts — inside chatCompletion
const body: Record<string, unknown> = {
  model: this.model,
  messages,
  temperature: opts?.temperature ?? 0.0,
  max_tokens: opts?.max_tokens ?? 100,
};
if (opts?.jsonSchema) {
  body.response_format = { type: "json_schema", json_schema: { schema: opts.jsonSchema } };
}
```

(Confirm against the mlx-lm version pinned at execution time — the structured-output flag has moved between versions.)

- [ ] **Step 4: Build the routing schema in `LLMRouter`**

```typescript
// src/router/llm-router.ts — top of the file
const ROUTING_SCHEMA = {
  type: "object",
  required: ["intent", "category", "params", "confidence"],
  properties: {
    intent: { type: "string" },
    category: { type: "string", enum: ["terminal", "cli", "brain", "local", "local-llm", "mcp"] },
    params: { type: "object", additionalProperties: true },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

// in classify():
const content = await this.provider.chatCompletion(messages, {
  temperature: 0.0,
  max_tokens: 100,
  jsonSchema: ROUTING_SCHEMA,
});
```

- [ ] **Step 5: Update tests**

Add a test asserting the provider receives `jsonSchema` in `opts`:

```typescript
// tests/router.test.ts — new test
test("classify passes routing schema to provider", async () => {
  const calls: LLMCompletionOpts[] = [];
  const mockProvider: LLMProvider = {
    name: "mock",
    health: async () => true,
    chatCompletion: async (_messages, opts) => {
      calls.push(opts ?? {});
      return JSON.stringify({ intent: "test", category: "local", params: {}, confidence: 0.9 });
    },
  };
  const router = new LLMRouter(mockProvider, /* actions */ {});
  await router.classify("test transcript");
  expect(calls[0].jsonSchema).toBeDefined();
  expect((calls[0].jsonSchema as any).required).toContain("intent");
});
```

- [ ] **Step 6: Run all router tests**

Run: `bun test tests/router.test.ts tests/backends/`
Expected: ALL PASS

- [ ] **Step 7: Manual verification**

With a live Ollama:
```bash
ollama serve &
ollama pull qwen3:1.7b
bun run src/index.ts start
# Issue a deliberately ambiguous voice command
# Verify the log shows valid JSON output from every call — no parse retries
```

- [ ] **Step 8: Commit**

```bash
git add src/backends/llm/provider.ts src/backends/llm/ollama.ts src/backends/llm/mlx-lm.ts src/router/llm-router.ts tests/router.test.ts
git commit -m "feat(router): add JSON-schema constrained decoding to LLMProvider — 100% JSON compliance"
```

---

## Self-review notes

- The embedding filter is OPTIONAL — if the server is down, `topK` returns `[]` and the router falls back to using the full action list. Cicero degrades gracefully.
- Tone classification is regex-based (fast, deterministic). Upgrade path: a 50M-param classifier model would beat keyword matching, but it's overkill for now.
- Router-model choice is config-driven. Don't hard-code new model names in provider defaults; let users pick via `llm.model`. See [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md) for current options.
- Constrained decoding's flag name varies by mlx-lm version. Pin and verify at execution time. Ollama's `format` is stable as of v0.5.
- `RouterResult.tone` is OPTIONAL (`tone?`) so existing tests that build `RouterResult` literals without it still typecheck.
- This plan doesn't touch the fallback router (`src/router/fallback-router.ts`) — its existing keyword-based logic is unchanged.
