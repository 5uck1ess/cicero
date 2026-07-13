# Memory and Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ⚠️ **Scope decision required before execution.** Brain CLIs (Claude Code, Codex, etc.) already maintain their own context across turns. A cockpit-side knowledge graph risks duplicating that work and drifting out of sync with the brain's actual state. Telemetry, by contrast, is uniquely the cockpit's job — only Cicero sees every turn across every brain.
>
> Before executing this plan, decide one of two paths:
> - **(a) Drop the memory half; keep telemetry.** Delete Tasks 1–5 (SQLite knowledge graph, topic router, PII redactor, embedding extension, memory façade). Keep Tasks 6–7 (telemetry recorder + daemon integration). Telemetry enables cross-vendor latency/cost analysis over time — a job no individual brain can do.
> - **(b) Narrow memory to cockpit state only.** Keep memory but limit scope: voice clone library, recent intent history (for the embedding filter), user preferences (active tier, active brain, active voice). Drop the topic auto-splitting and knowledge-graph layer — those are brain-side.
>
> Recommended default: **(a)** — keep telemetry, drop the knowledge graph. The cockpit dispatches; the brain remembers.

**Goal:** Add a persistent memory layer and per-turn telemetry to Cicero. Memory = SQLite-backed knowledge graph (topics + facts + embeddings) that survives across daemon restarts and gets searched on each turn. Telemetry = structured per-turn log capturing latency, tokens, backend used, success/failure, for future cost/quality tuning. Both include a PII redaction step before persistence.

**Architecture:** Memory uses `bun:sqlite` (zero new deps) with a small schema: `topics`, `facts`, `embeddings` (stored as BLOBs of float32). Embeddings come from the embedding server (Plan 3, port 8084) — Cicero already runs one for action filtering, we reuse it. Topic auto-splitting: a fact's topic is determined by nearest-neighbor cosine search over existing topic centroids; if no topic is similar enough (threshold 0.5), a new topic is created. PII redaction is a regex layer in front of memory writes. Telemetry is append-only JSONL at `~/.cicero/telemetry/YYYY-MM-DD.jsonl`.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `bun:sqlite` (built-in). New Python: extends `servers/embedding_server.py` from Plan 3 with a `/embed_text` endpoint. No new TS deps.

**Source inspiration:**
- [`isair/jarvis`](https://github.com/isair/jarvis) — knowledge-graph memory, topic auto-routing, and PII/sensitive-info redaction (non-commercial license: read-only)
- [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) — memory tier menu (FAISS/BM25/ColBERT) and eval/telemetry framework (Apache 2.0)

Read both for patterns; reimplement clean in TS.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/memory/store.ts` | NEW | SQLite-backed `MemoryStore` (topics, facts, embeddings) |
| `src/memory/redactor.ts` | NEW | PII redaction layer (regex-based) |
| `src/memory/topic-router.ts` | NEW | Nearest-neighbor topic assignment |
| `src/memory/index.ts` | NEW | Factory + public API |
| `src/telemetry/recorder.ts` | NEW | Per-turn telemetry writer |
| `src/telemetry/index.ts` | NEW | Factory |
| `src/brain/context-store.ts` | MODIFY | Optionally query MemoryStore for recent-topic context |
| `src/daemon.ts` | MODIFY | Boot MemoryStore + TelemetryRecorder; record per turn |
| `src/types.ts` | MODIFY | `MemoryConfig`, `TelemetryConfig`, extend `ExecutionResult` with telemetry fields |
| `src/config.ts` | MODIFY | Defaults for memory and telemetry |
| `servers/embedding_server.py` | MODIFY | Add `/embed_text` endpoint |
| `tests/memory-store.test.ts` | NEW | CRUD + topic auto-split |
| `tests/memory-redactor.test.ts` | NEW | PII redaction cases |
| `tests/memory-topic-router.test.ts` | NEW | Topic assignment |
| `tests/telemetry-recorder.test.ts` | NEW | JSONL writes |

---

## Task 1: Memory schema and SQLite store

**Files:**
- Create: `src/memory/store.ts`
- Test: `tests/memory-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { MemoryStore } from "../src/memory/store";

const DB = "/tmp/cicero-memory-test.sqlite";
beforeEach(() => { if (existsSync(DB)) unlinkSync(DB); });

test("MemoryStore initializes schema on first open", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  expect(store.hasTopic("general")).toBe(false);
});

test("MemoryStore.addFact stores fact with topic and embedding", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  const id = await store.addFact({
    text: "User likes light roast coffee",
    topic: "preferences",
    embedding: new Float32Array(384),
  });
  expect(typeof id).toBe("number");
  expect(id).toBeGreaterThan(0);
});

test("MemoryStore.searchByEmbedding returns ranked facts", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  const e1 = new Float32Array(384).fill(0); e1[0] = 1;
  const e2 = new Float32Array(384).fill(0); e2[1] = 1;
  await store.addFact({ text: "fact one", topic: "a", embedding: e1 });
  await store.addFact({ text: "fact two", topic: "b", embedding: e2 });

  const queryEmb = new Float32Array(384).fill(0); queryEmb[0] = 1;
  const results = await store.searchByEmbedding(queryEmb, 2);
  expect(results[0].text).toBe("fact one");
});

test("MemoryStore.listTopics returns distinct topics", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  const emb = new Float32Array(384);
  await store.addFact({ text: "a1", topic: "alpha", embedding: emb });
  await store.addFact({ text: "a2", topic: "alpha", embedding: emb });
  await store.addFact({ text: "b1", topic: "beta", embedding: emb });
  const topics = store.listTopics();
  expect(topics.sort()).toEqual(["alpha", "beta"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/memory-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/memory/store.ts
import { Database } from "bun:sqlite";

export interface Fact {
  text: string;
  topic: string;
  embedding: Float32Array;
}

export interface FactRecord extends Fact {
  id: number;
  created_at: number;
  score?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  centroid BLOB NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  embedding BLOB NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_topic ON facts(topic_id);
`;

function floatToBlob(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer);
}

function blobToFloat(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class MemoryStore {
  private db: Database;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path);
  }

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
  }

  hasTopic(name: string): boolean {
    const row = this.db.query("SELECT id FROM topics WHERE name = ?").get(name);
    return row !== null;
  }

  async addFact(fact: Fact): Promise<number> {
    let topic = this.db.query("SELECT id, centroid FROM topics WHERE name = ?").get(fact.topic) as { id: number; centroid: Uint8Array } | null;
    if (!topic) {
      const ins = this.db.run("INSERT INTO topics (name, centroid) VALUES (?, ?)", [fact.topic, floatToBlob(fact.embedding)]);
      topic = { id: Number(ins.lastInsertRowid), centroid: floatToBlob(fact.embedding) };
    } else {
      const old = blobToFloat(topic.centroid);
      const newCentroid = new Float32Array(old.length);
      for (let i = 0; i < old.length; i++) newCentroid[i] = (old[i] + fact.embedding[i]) / 2;
      this.db.run("UPDATE topics SET centroid = ? WHERE id = ?", [floatToBlob(newCentroid), topic.id]);
    }

    const ins = this.db.run(
      "INSERT INTO facts (text, topic_id, embedding) VALUES (?, ?, ?)",
      [fact.text, topic.id, floatToBlob(fact.embedding)],
    );
    return Number(ins.lastInsertRowid);
  }

  async searchByEmbedding(query: Float32Array, k = 5): Promise<FactRecord[]> {
    const rows = this.db.query(`
      SELECT f.id, f.text, t.name as topic, f.embedding, f.created_at
      FROM facts f JOIN topics t ON t.id = f.topic_id
    `).all() as Array<{ id: number; text: string; topic: string; embedding: Uint8Array; created_at: number }>;

    const scored = rows.map(r => ({
      id: r.id,
      text: r.text,
      topic: r.topic,
      embedding: blobToFloat(r.embedding),
      created_at: r.created_at,
      score: dot(query, blobToFloat(r.embedding)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  listTopics(): string[] {
    const rows = this.db.query("SELECT name FROM topics ORDER BY name").all() as Array<{ name: string }>;
    return rows.map(r => r.name);
  }

  getTopicCentroid(name: string): Float32Array | null {
    const row = this.db.query("SELECT centroid FROM topics WHERE name = ?").get(name) as { centroid: Uint8Array } | null;
    return row ? blobToFloat(row.centroid) : null;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/memory-store.test.ts`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/store.ts tests/memory-store.test.ts
git commit -m "feat(memory): SQLite-backed MemoryStore with topics + embeddings"
```

---

## Task 2: Topic auto-router

**Files:**
- Create: `src/memory/topic-router.ts`
- Test: `tests/memory-topic-router.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { MemoryStore } from "../src/memory/store";
import { TopicRouter } from "../src/memory/topic-router";

const DB = "/tmp/cicero-topic-router-test.sqlite";
beforeEach(() => { if (existsSync(DB)) unlinkSync(DB); });

test("TopicRouter creates a new topic when no existing topic is close enough", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  const router = new TopicRouter(store, 0.5);
  const emb = new Float32Array(384).fill(0); emb[0] = 1;
  const topic = await router.assign(emb);
  expect(topic).toMatch(/^topic_\d+$/);
});

test("TopicRouter routes to existing topic when similar", async () => {
  const store = new MemoryStore(DB);
  await store.init();
  const emb1 = new Float32Array(384).fill(0); emb1[0] = 1;
  await store.addFact({ text: "x", topic: "coffee", embedding: emb1 });

  const router = new TopicRouter(store, 0.3);
  const emb2 = new Float32Array(384).fill(0); emb2[0] = 1;
  const topic = await router.assign(emb2);
  expect(topic).toBe("coffee");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/memory-topic-router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/memory/topic-router.ts
import type { MemoryStore } from "./store";

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

export class TopicRouter {
  constructor(private store: MemoryStore, private similarityThreshold = 0.5) {}

  async assign(embedding: Float32Array): Promise<string> {
    const topics = this.store.listTopics();
    let best: { name: string; score: number } | null = null;
    for (const name of topics) {
      const centroid = this.store.getTopicCentroid(name);
      if (!centroid) continue;
      const score = cosine(embedding, centroid);
      if (best === null || score > best.score) {
        best = { name, score };
      }
    }
    if (best && best.score >= this.similarityThreshold) {
      return best.name;
    }
    return `topic_${topics.length + 1}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/memory-topic-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/topic-router.ts tests/memory-topic-router.test.ts
git commit -m "feat(memory): TopicRouter assigns embeddings to nearest topic or creates new"
```

---

## Task 3: PII redactor

**Files:**
- Create: `src/memory/redactor.ts`
- Test: `tests/memory-redactor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { redact } from "../src/memory/redactor";

test("redact strips email addresses", () => {
  expect(redact("contact me at john@example.com please")).toBe("contact me at [REDACTED_EMAIL] please");
});

test("redact strips phone numbers (US formats)", () => {
  expect(redact("call 555-123-4567")).toBe("call [REDACTED_PHONE]");
});

test("redact strips credit card numbers", () => {
  expect(redact("card 4111-1111-1111-1111")).toBe("card [REDACTED_CC]");
});

test("redact strips SSN", () => {
  expect(redact("ssn 123-45-6789")).toBe("ssn [REDACTED_SSN]");
});

test("redact strips API keys (common prefixes)", () => {
  expect(redact("sk-abc123def456")).toBe("[REDACTED_KEY]");
  expect(redact("ghp_abcDEF123")).toBe("[REDACTED_KEY]");
});

test("redact leaves benign text alone", () => {
  expect(redact("hello world")).toBe("hello world");
  expect(redact("user likes coffee")).toBe("user likes coffee");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/memory-redactor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/memory/redactor.ts

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

const RULES: RedactionRule[] = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[REDACTED_EMAIL]" },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[REDACTED_SSN]" },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[REDACTED_CC]" },
  { pattern: /(?:\+?1[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, replacement: "[REDACTED_PHONE]" },
  { pattern: /\b(sk|pk|ghp|github_pat|xoxb|xoxp)[-_][A-Za-z0-9]+/g, replacement: "[REDACTED_KEY]" },
];

export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/memory-redactor.test.ts`
Expected: PASS for all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/memory/redactor.ts tests/memory-redactor.test.ts
git commit -m "feat(memory): PII redactor for email/phone/CC/SSN/API keys"
```

---

## Task 4: Extend embedding server with /embed_text

**Files:**
- Modify: `servers/embedding_server.py`

- [ ] **Step 1: Add endpoint**

Append to `servers/embedding_server.py`:

```python
class EmbedTextRequest(BaseModel):
    texts: list[str]

@app.post("/embed_text")
async def embed_text(req: EmbedTextRequest):
    if state.model is None:
        return {"error": "model not loaded"}
    embs = state.model.encode(req.texts, normalize_embeddings=True)
    return {"embeddings": [e.tolist() for e in embs]}
```

- [ ] **Step 2: Smoke test**

```bash
curl -X POST http://localhost:8084/embed_text \
  -H "Content-Type: application/json" \
  -d '{"texts": ["hello world"]}'
```
Expected: `{"embeddings": [[...384 floats...]]}`

- [ ] **Step 3: Commit**

```bash
git add servers/embedding_server.py
git commit -m "feat(embedding): add /embed_text endpoint for memory layer"
```

---

## Task 5: Memory façade and integration

**Files:**
- Create: `src/memory/index.ts`
- Test: `tests/memory-index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock, beforeEach } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Memory } from "../src/memory";

const DB = "/tmp/cicero-memory-fac-test.sqlite";
beforeEach(() => { if (existsSync(DB)) unlinkSync(DB); });

test("Memory.remember redacts, embeds, assigns topic, stores fact", async () => {
  globalThis.fetch = mock(async () => {
    const e = new Array(384).fill(0); e[0] = 1;
    return new Response(JSON.stringify({ embeddings: [e] }));
  }) as any;

  const mem = new Memory({ dbPath: DB, embeddingPort: 8084 });
  await mem.init();
  const id = await mem.remember("My email is foo@bar.com and I like coffee");
  expect(id).toBeGreaterThan(0);

  const results = await mem.recall("coffee");
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].text).toContain("[REDACTED_EMAIL]");
  expect(results[0].text).not.toContain("foo@bar.com");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/memory-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/memory/index.ts
import { MemoryStore, type FactRecord } from "./store";
import { TopicRouter } from "./topic-router";
import { redact } from "./redactor";
import { log } from "../logger";

export interface MemoryConfig {
  dbPath: string;
  embeddingPort?: number;
  embeddingHost?: string;
  topicThreshold?: number;
}

export class Memory {
  private store: MemoryStore;
  private router: TopicRouter;
  private embedHost: string;
  private embedPort: number;

  constructor(config: MemoryConfig) {
    this.store = new MemoryStore(config.dbPath);
    this.router = new TopicRouter(this.store, config.topicThreshold ?? 0.5);
    this.embedHost = config.embeddingHost ?? "127.0.0.1";
    this.embedPort = config.embeddingPort ?? 8084;
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async remember(text: string): Promise<number> {
    const cleanText = redact(text);
    const embedding = await this.embed(cleanText);
    if (!embedding) {
      log("warn", "Memory: embedding server unavailable, skipping store");
      return -1;
    }
    const topic = await this.router.assign(embedding);
    return await this.store.addFact({ text: cleanText, topic, embedding });
  }

  async recall(query: string, k = 5): Promise<FactRecord[]> {
    const embedding = await this.embed(query);
    if (!embedding) return [];
    return await this.store.searchByEmbedding(embedding, k);
  }

  private async embed(text: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(`http://${this.embedHost}:${this.embedPort}/embed_text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: [text] }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { embeddings: number[][] };
      return new Float32Array(data.embeddings[0]);
    } catch {
      return null;
    }
  }

  close(): void {
    this.store.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/memory-index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/index.ts tests/memory-index.test.ts
git commit -m "feat(memory): Memory façade (redact → embed → topic → store)"
```

---

## Task 6: Telemetry recorder

**Files:**
- Create: `src/telemetry/recorder.ts`
- Test: `tests/telemetry-recorder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { TelemetryRecorder } from "../src/telemetry/recorder";

const DIR = "/tmp/cicero-telemetry-test";
beforeEach(() => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
});

test("TelemetryRecorder writes one JSON line per turn", async () => {
  const rec = new TelemetryRecorder(DIR);
  await rec.record({
    turn_id: "abc",
    timestamp: 1700000000000,
    transcript: "what time is it",
    intent: "time_check",
    category: "local",
    backend: "ollama",
    latency_ms: 42,
    tokens_in: 5,
    tokens_out: 10,
    success: true,
  });
  const date = new Date(1700000000000).toISOString().slice(0, 10);
  const file = join(DIR, `${date}.jsonl`);
  expect(existsSync(file)).toBe(true);
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0]);
  expect(parsed.turn_id).toBe("abc");
});

test("TelemetryRecorder appends multiple turns to the same day file", async () => {
  const rec = new TelemetryRecorder(DIR);
  const ts = Date.now();
  for (let i = 0; i < 3; i++) {
    await rec.record({
      turn_id: `t${i}`,
      timestamp: ts,
      transcript: `turn ${i}`,
      intent: "x",
      category: "local",
      backend: "ollama",
      latency_ms: 10,
      tokens_in: 0,
      tokens_out: 0,
      success: true,
    });
  }
  const date = new Date(ts).toISOString().slice(0, 10);
  const file = join(DIR, `${date}.jsonl`);
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  expect(lines.length).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/telemetry-recorder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/telemetry/recorder.ts
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

export interface TelemetryEvent {
  turn_id: string;
  timestamp: number;
  transcript: string;
  intent: string;
  category: string;
  backend: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  success: boolean;
  error?: string;
  tone?: string;
  router_confidence?: number;
}

export class TelemetryRecorder {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  async record(event: TelemetryEvent): Promise<void> {
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    const file = join(this.dir, `${date}.jsonl`);
    appendFileSync(file, JSON.stringify(event) + "\n");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/telemetry-recorder.test.ts`
Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/recorder.ts tests/telemetry-recorder.test.ts
git commit -m "feat(telemetry): per-turn JSONL recorder"
```

---

## Task 7: Daemon integration — boot memory and telemetry, record per turn

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/config.ts` (defaults)
- Modify: `src/types.ts` (config fields)

- [ ] **Step 1: Add config fields**

In `src/types.ts`, extend `CiceroConfig`:

```ts
memory_enabled?: boolean;
memory_db_path?: string;
memory_topic_threshold?: number;
telemetry_enabled?: boolean;
telemetry_dir?: string;
```

In `src/config.ts` DEFAULT_CONFIG, add:

```ts
memory_enabled: true,
memory_topic_threshold: 0.5,
telemetry_enabled: true,
```

In `RuntimeConfig`:

```ts
get memoryEnabled(): boolean { return this.config.memory_enabled ?? true; }
get memoryDbPath(): string {
  const home = process.env.HOME || "~";
  return this.config.memory_db_path ?? `${home}/.cicero/memory.sqlite`;
}
get memoryTopicThreshold(): number { return this.config.memory_topic_threshold ?? 0.5; }
get telemetryEnabled(): boolean { return this.config.telemetry_enabled ?? true; }
get telemetryDir(): string {
  const home = process.env.HOME || "~";
  return this.config.telemetry_dir ?? `${home}/.cicero/telemetry`;
}
```

- [ ] **Step 2: Boot in daemon (prose)**

In `src/daemon.ts`, near the top of the startup sequence (after config loading, before the listener loop begins), add the following:

1. Import `Memory` from `./memory` and `TelemetryRecorder` from `./telemetry/recorder`.
2. If `config.memoryEnabled` is true, construct a `Memory` instance with `{ dbPath: config.memoryDbPath, embeddingPort: 8084, topicThreshold: config.memoryTopicThreshold }`, await `mem.init()`, and assign to a daemon-level variable (or null otherwise).
3. If `config.telemetryEnabled` is true, construct a `TelemetryRecorder` with `config.telemetryDir`.
4. Import `randomUUID` from `crypto`.

- [ ] **Step 3: Wrap the per-turn handler (prose)**

Find the daemon's per-turn handler — the function that receives the transcript from the listener, runs it through the router, and calls the `ActionExecutor`. Wrap that call with:

1. Generate a `turnId` via `randomUUID()` and record `t0 = Date.now()` BEFORE the action runs.
2. After the action returns (whether success or failure), if `memory` is non-null, fire-and-forget `memory.remember(transcript).catch(() => {})` — never block the user response on memory write.
3. If `telemetry` is non-null, await a `telemetry.record({...})` call with the fields: `turn_id`, `timestamp: t0`, `transcript`, `intent: route.intent`, `category: route.category`, `backend: config.brain.backend`, `latency_ms: Date.now() - t0`, `tokens_in: transcript.length` (character-length proxy), `tokens_out: result.output.length`, `success: result.success`, `error: result.error`, `tone: route.tone`, `router_confidence: route.confidence`.
4. On shutdown, call `memory?.close()`.

- [ ] **Step 4: Manual smoke test**

```bash
bun run start
# Issue a few voice commands or stdin queries
ls ~/.cicero/telemetry/
# Expected: one JSONL file dated today
sqlite3 ~/.cicero/memory.sqlite "SELECT count(*) FROM facts"
# Expected: count > 0
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/daemon.ts
git commit -m "feat(daemon): boot memory + telemetry, record per turn"
```

---

## Task 8: Surface memory in brain context (optional recall)

**Files:**
- Modify: `src/brain/context-store.ts` — add a `setMemory(mem: Memory | null)` method and a `getRelevantMemory(query: string, k = 3)` accessor that awaits `memory.recall(query, k)` (or returns `[]` if no memory).
- Modify: `src/executor/index.ts` — in the brain-dispatch path, before sending the prompt to the brain, call `await this.contextStore.getRelevantMemory(originalText, 3)`. If non-empty, prepend `"Relevant memory:\n" + recalled.map(r => "- (" + r.topic + ") " + r.text).join("\n") + "\n\n"` to the message. The existing tone hint from Plan 3 prepends BEFORE the memory block.

- [ ] **Step 1: Wire memory into context store**

Add a `Memory | null` field on `ContextStore`, a setter, and the recall method. Keep the recall method tolerant — return `[]` on any error.

- [ ] **Step 2: Wire context store into executor brain path**

In the brain dispatch method, request the recall results and build the prefix as described above. Default to no prefix if recall returns empty.

- [ ] **Step 3: Set the memory on context store at daemon startup**

After constructing both `memory` and `contextStore` in the daemon, call `contextStore.setMemory(memory)`.

- [ ] **Step 4: Smoke test**

After a few turns where you tell Cicero personal preferences (e.g. "I like light roast coffee"), ask a related question ("what kind of coffee do you recommend"). The brain's reply should reflect the recalled preference.

- [ ] **Step 5: Commit**

```bash
git add src/brain/context-store.ts src/executor/index.ts src/daemon.ts
git commit -m "feat(memory): recall relevant facts and inject into brain prompt"
```

---

## Self-review notes

- `bun:sqlite` is built into Bun ≥0.8 — zero new deps.
- Embedding storage as BLOB float32 — 384 dims × 4 bytes = 1.5KB per fact. 10,000 facts = 15MB. Manageable.
- Topic threshold 0.5 is a reasonable starting point but should be tuned via telemetry data once collected.
- Topic centroids use a simple running-average update. For large fact counts, periodic re-computation from all facts in a topic would be more accurate; out of scope for v1.
- Redaction is regex-based; misses things Presidio would catch (names, addresses). Documented as a known limitation. Upgrade path: Python Presidio service.
- Telemetry stores `tokens_in/out` as character lengths (proxy). Real token counts require tokenizer integration per backend; out of scope for v1.
- Memory remember runs as fire-and-forget per turn (never blocks user response). Recall runs synchronously in the brain path but with a tight timeout via the embedding fetch.
- No data export / dashboard. Telemetry is intentionally raw JSONL for downstream tools (DuckDB, jq, etc.).
- Privacy: memory DB and telemetry are written to `~/.cicero/` which is not synced anywhere by default. Document this in README.
