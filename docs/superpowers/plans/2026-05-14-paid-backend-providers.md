# Paid Backend Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire two paid HTTP-API backends so users can offload computation when local hardware is busy: (1) `claude-api` LLM provider for the router classification call, and (2) `elevenlabs` TTS provider with voice cloning. Both already have stub `throw new Error("not yet implemented")` cases in `src/backends/registry.ts` — this plan flips those to real implementations.

**Architecture:** Both providers implement the existing `LLMProvider` / `TTSProvider` interfaces. No `start()` method (cloud APIs, nothing to spawn), no managed-server plumbing. API keys read from env vars (`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`) — never persisted in config files. Voice cloning is a one-time pre-provisioning step: a helper script uploads a reference clip and prints a `voice_id`; the user stores that `voice_id` in `~/.cicero/config.yaml`. The TTS provider then calls `/v1/text-to-speech/{voice_id}` per turn.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `@anthropic-ai/sdk` for Claude, raw `fetch` for ElevenLabs (their endpoints are simple enough that the SDK adds bulk without value). No Python.

**Source inspiration:** [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) — multi-provider inference abstraction (conceptual ancestor; this plan extends Cicero's existing provider pattern, not borrowed code).

**Explicitly deferred:** `deepgram` STT. Local `faster-whisper-large-v3-turbo` on CUDA is fast enough (~100–300 ms) and frees no meaningful VRAM compared to offloading the LLM router. Keep the `case "deepgram":` stub in the registry — do not implement here.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/backends/llm/claude-api.ts` | NEW | `ClaudeAPIProvider` — wraps Anthropic SDK, implements `chatCompletion()` + `health()` |
| `src/backends/tts/elevenlabs.ts` | NEW | `ElevenLabsProvider` — POST to `/v1/text-to-speech/{voice_id}`, return audio bytes |
| `src/backends/registry.ts` | MODIFY | Replace `throw "claude-api not yet implemented"` and `throw "elevenlabs not yet implemented"` stubs with real provider instantiation |
| `src/backends/llm/provider.ts` | MODIFY | Extend `LLMProviderConfig` with optional `api_key_env?: string` |
| `src/backends/tts/provider.ts` | MODIFY | Extend `TTSProviderConfig` with optional `api_key_env?: string`, `voice_id?: string` |
| `src/types.ts` | MODIFY | Mirror the two config extensions if the central `BackendConfig` type needs them |
| `helpers/clone-voice-elevenlabs.ts` | NEW | One-shot helper: uploads a reference clip to ElevenLabs, prints the resulting `voice_id` to stdout |
| `package.json` | MODIFY | Add `@anthropic-ai/sdk` to dependencies |
| `tests/backends/claude-api.test.ts` | NEW | Name check, missing-key behavior, mocked happy path |
| `tests/backends/elevenlabs.test.ts` | NEW | Name check, missing-key behavior, missing-voice-id behavior, mocked happy path |
| `README.md` | MODIFY | Add a "Paid offload" section under Configuration with example YAML for hybrid + cloud tiers |

---

## Task 1: Extend provider config types with API key + voice_id

**Files:**
- Modify: `src/backends/llm/provider.ts`
- Modify: `src/backends/tts/provider.ts`
- Modify: `src/types.ts` (if `BackendConfig` is the source of truth)

- [ ] **Step 1: Add `api_key_env` to `LLMProviderConfig`**

```typescript
// src/backends/llm/provider.ts
export interface LLMProviderConfig {
  backend?: string;
  port?: number;
  model?: string;
  api_key_env?: string;  // NEW — env var name to read for cloud providers
}
```

- [ ] **Step 2: Add `api_key_env` and `voice_id` to `TTSProviderConfig`**

```typescript
// src/backends/tts/provider.ts
export interface TTSProviderConfig {
  backend?: string;
  port?: number;
  model?: string;
  voice?: string;
  refAudio?: string;
  refText?: string;
  api_key_env?: string;  // NEW
  voice_id?: string;     // NEW — for ElevenLabs cloned voices
}
```

- [ ] **Step 3: Run existing tests to confirm no regressions**

Run: `bun test tests/backends/`
Expected: ALL PASS (these are additive optional fields)

---

## Task 2: Implement `ClaudeAPIProvider`

**Files:**
- Create: `src/backends/llm/claude-api.ts`
- Create: `tests/backends/claude-api.test.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk` dependency)

- [ ] **Step 1: Install the SDK**

Run: `bun add @anthropic-ai/sdk`

- [ ] **Step 2: Write tests first**

```typescript
// tests/backends/claude-api.test.ts
import { test, expect, describe } from "bun:test";
import { ClaudeAPIProvider } from "../../src/backends/llm/claude-api";

describe("ClaudeAPIProvider", () => {
  test("has correct name", () => {
    const provider = new ClaudeAPIProvider({ api_key_env: "TEST_KEY", model: "claude-haiku-4-5" });
    expect(provider.name).toBe("claude-api");
  });

  test("chatCompletion throws when api key env is unset", async () => {
    delete process.env.MISSING_KEY_FOR_TEST;
    const provider = new ClaudeAPIProvider({ api_key_env: "MISSING_KEY_FOR_TEST", model: "claude-haiku-4-5" });
    await expect(
      provider.chatCompletion([{ role: "user", content: "test" }])
    ).rejects.toThrow(/MISSING_KEY_FOR_TEST/);
  });

  test("health returns false when api key env is unset", async () => {
    delete process.env.MISSING_KEY_FOR_TEST;
    const provider = new ClaudeAPIProvider({ api_key_env: "MISSING_KEY_FOR_TEST", model: "claude-haiku-4-5" });
    expect(await provider.health()).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `bun test tests/backends/claude-api.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 4: Implement `ClaudeAPIProvider`**

```typescript
// src/backends/llm/claude-api.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMProviderConfig, ChatMessage, LLMCompletionOpts } from "./provider";

export class ClaudeAPIProvider implements LLMProvider {
  readonly name = "claude-api";
  private apiKeyEnv: string;
  private model: string;

  constructor(config: LLMProviderConfig) {
    this.apiKeyEnv = config.api_key_env ?? "ANTHROPIC_API_KEY";
    this.model = config.model ?? "claude-haiku-4-5";
  }

  private getClient(): Anthropic {
    const key = process.env[this.apiKeyEnv];
    if (!key) {
      throw new Error(`Claude API key not found in env var '${this.apiKeyEnv}'`);
    }
    return new Anthropic({ apiKey: key });
  }

  async chatCompletion(messages: ChatMessage[], opts?: LLMCompletionOpts): Promise<string> {
    const client = this.getClient();
    // Anthropic API splits system from messages; pull it out if present
    const system = messages.find((m) => m.role === "system")?.content;
    const userAssistant = messages.filter((m) => m.role !== "system") as Array<{ role: "user" | "assistant"; content: string }>;

    const response = await client.messages.create({
      model: this.model,
      max_tokens: opts?.max_tokens ?? 100,
      temperature: opts?.temperature ?? 0.0,
      ...(system ? { system } : {}),
      messages: userAssistant,
    });

    const block = response.content[0];
    if (!block || block.type !== "text") return "";
    return block.text;
  }

  async health(): Promise<boolean> {
    return Boolean(process.env[this.apiKeyEnv]);
  }
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `bun test tests/backends/claude-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/backends/llm/claude-api.ts tests/backends/claude-api.test.ts package.json bun.lock
git commit -m "feat: add Claude API LLM provider for router offload"
```

---

## Task 3: Implement `ElevenLabsProvider` with voice cloning

**Files:**
- Create: `src/backends/tts/elevenlabs.ts`
- Create: `tests/backends/elevenlabs.test.ts`
- Create: `helpers/clone-voice-elevenlabs.ts`

- [ ] **Step 1: Write tests first**

```typescript
// tests/backends/elevenlabs.test.ts
import { test, expect, describe } from "bun:test";
import { ElevenLabsProvider } from "../../src/backends/tts/elevenlabs";

describe("ElevenLabsProvider", () => {
  test("has correct name", () => {
    const provider = new ElevenLabsProvider({
      api_key_env: "TEST_KEY",
      voice_id: "test-voice-id",
    });
    expect(provider.name).toBe("elevenlabs");
  });

  test("generateAudio throws when api key env is unset", async () => {
    delete process.env.MISSING_EL_KEY;
    const provider = new ElevenLabsProvider({
      api_key_env: "MISSING_EL_KEY",
      voice_id: "test-voice-id",
    });
    await expect(provider.generateAudio("hello")).rejects.toThrow(/MISSING_EL_KEY/);
  });

  test("generateAudio throws when voice_id is missing", async () => {
    process.env.TEST_EL_KEY = "fake-key";
    const provider = new ElevenLabsProvider({ api_key_env: "TEST_EL_KEY" });
    await expect(provider.generateAudio("hello")).rejects.toThrow(/voice_id/);
    delete process.env.TEST_EL_KEY;
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test tests/backends/elevenlabs.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `ElevenLabsProvider`**

```typescript
// src/backends/tts/elevenlabs.ts
import type { TTSProvider, TTSProviderConfig } from "./provider";

export class ElevenLabsProvider implements TTSProvider {
  readonly name = "elevenlabs";
  private apiKeyEnv: string;
  private voiceId?: string;
  private model: string;

  constructor(config: TTSProviderConfig) {
    this.apiKeyEnv = config.api_key_env ?? "ELEVENLABS_API_KEY";
    this.voiceId = config.voice_id;
    this.model = config.model ?? "eleven_turbo_v2_5";
  }

  async generateAudio(text: string): Promise<ArrayBuffer> {
    const key = process.env[this.apiKeyEnv];
    if (!key) {
      throw new Error(`ElevenLabs API key not found in env var '${this.apiKeyEnv}'`);
    }
    if (!this.voiceId) {
      throw new Error("ElevenLabs provider requires voice_id in config (run helpers/clone-voice-elevenlabs.ts to provision)");
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`ElevenLabs returned ${response.status}: ${errText}`);
    }

    return await response.arrayBuffer();
  }

  async health(): Promise<boolean> {
    const key = process.env[this.apiKeyEnv];
    if (!key) return false;
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": key },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test tests/backends/elevenlabs.test.ts`
Expected: PASS

- [ ] **Step 5: Write voice cloning helper**

```typescript
// helpers/clone-voice-elevenlabs.ts
// Usage: bun run helpers/clone-voice-elevenlabs.ts <name> <sample.mp3> [sample2.mp3 ...]
// Prints the voice_id to stdout. Store it in ~/.cicero/config.yaml under tts.voice_id.

const [name, ...samples] = process.argv.slice(2);
if (!name || samples.length === 0) {
  console.error("Usage: bun run helpers/clone-voice-elevenlabs.ts <name> <sample.mp3> [sample2.mp3 ...]");
  process.exit(1);
}

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY env var must be set");
  process.exit(1);
}

const form = new FormData();
form.append("name", name);
for (const path of samples) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`Sample not found: ${path}`);
    process.exit(1);
  }
  form.append("files", file, path.split("/").pop()!);
}

const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
  method: "POST",
  headers: { "xi-api-key": key },
  body: form,
});

if (!res.ok) {
  console.error(`Upload failed: ${res.status} ${await res.text().catch(() => "")}`);
  process.exit(1);
}

const data = await res.json() as { voice_id: string };
console.log(data.voice_id);
```

- [ ] **Step 6: Commit**

```bash
git add src/backends/tts/elevenlabs.ts tests/backends/elevenlabs.test.ts helpers/clone-voice-elevenlabs.ts
git commit -m "feat: add ElevenLabs TTS provider with voice cloning helper"
```

---

## Task 4: Wire providers into registry

**Files:**
- Modify: `src/backends/registry.ts`
- Modify: `tests/backends/registry.test.ts`

- [ ] **Step 1: Update registry to instantiate the new providers**

Replace the throw stubs in `src/backends/registry.ts`:

```typescript
// in createLLMProvider:
case "claude-api":
  return new ClaudeAPIProvider(llmConfig);

// in createTTSProvider:
case "elevenlabs":
  return new ElevenLabsProvider(ttsConfig);
```

Add the imports at the top:

```typescript
import { ClaudeAPIProvider } from "./llm/claude-api";
import { ElevenLabsProvider } from "./tts/elevenlabs";
```

Remove `"claude-api"` from the LLM "not yet implemented" throw block.
Remove `"elevenlabs"` from the TTS "not yet implemented" throw block.

- [ ] **Step 2: Add registry tests for the new providers**

```typescript
// tests/backends/registry.test.ts — add these inside the existing describe block

test("creates Claude API provider when configured", () => {
  const config = new RuntimeConfig({
    ...DEFAULT_TEST_CONFIG,
    llm: { backend: "claude-api", api_key_env: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  });
  const providers = createProviders(config);
  expect(providers.llm.name).toBe("claude-api");
});

test("creates ElevenLabs provider when configured", () => {
  const config = new RuntimeConfig({
    ...DEFAULT_TEST_CONFIG,
    tts: { backend: "elevenlabs", api_key_env: "ELEVENLABS_API_KEY", voice_id: "abc123" },
  });
  const providers = createProviders(config);
  expect(providers.tts.name).toBe("elevenlabs");
});
```

- [ ] **Step 3: Confirm the "throws for unimplemented backends" test still passes for deepgram only**

The existing test expects throws for `deepgram`, `nemotron`, `moonshine` (STT) and `omnivoice`, `pocket-tts`, `voxtral` (TTS). Update it to remove `elevenlabs` from the TTS throw-list and to remove `claude-api` from the LLM throw-list if it appears there.

- [ ] **Step 4: Run all backend tests**

Run: `bun test tests/backends/`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/backends/registry.ts tests/backends/registry.test.ts
git commit -m "feat: wire claude-api and elevenlabs into provider registry"
```

---

## Task 5: Document paid offload in README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Paid offload" section under Configuration**

Add example YAML showing the three realistic configs:

```yaml
# Pure local (unchanged default) — Mac
deployment: local-mlx

# Pure local — Linux/CUDA
deployment: local-cuda

# Hybrid: offload only the LLM router to Claude API
# (Useful when local VRAM is already committed to another model.)
deployment: local-cuda
llm:
  backend: claude-api
  api_key_env: ANTHROPIC_API_KEY
  model: claude-haiku-4-5

# Hybrid with cloned voice (ElevenLabs)
deployment: local-cuda
llm:
  backend: claude-api
  api_key_env: ANTHROPIC_API_KEY
  model: claude-haiku-4-5
tts:
  backend: elevenlabs
  api_key_env: ELEVENLABS_API_KEY
  voice_id: <run helpers/clone-voice-elevenlabs.ts to get this>
```

- [ ] **Step 2: Document the voice-clone helper**

Add a short subsection:

```markdown
### Cloning a voice for ElevenLabs

Provision a custom voice once with a 30-second clean reference clip:

\`\`\`bash
export ELEVENLABS_API_KEY=<your key>
bun run helpers/clone-voice-elevenlabs.ts "Jarvis" assets/reference-clip.wav
# Prints: <voice_id>
\`\`\`

Paste the printed `voice_id` into `~/.cicero/config.yaml` under `tts.voice_id`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add paid-offload config examples and voice-clone helper docs"
```

---

## Task 6: Final integration check

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL PASS (the two pre-existing KittyAdapter integration tests will still fail — that's an env issue, not a regression)

- [ ] **Step 2: Verify cost-sanity check**

Confirm `claude-haiku-4-5` is the documented default model (not Sonnet/Opus) — the router is a per-turn classification call and Haiku is the right cost/latency tradeoff.

- [ ] **Step 3: Manual smoke test (optional, requires real keys)**

With `ANTHROPIC_API_KEY` set:
```bash
bun run src/index.ts start --no-servers
# Verify daemon boots without errors when llm.backend = "claude-api"
```

With `ELEVENLABS_API_KEY` set and a provisioned `voice_id`:
```bash
echo "Hello from Cicero" | bun run src/index.ts speak
# Verify cloned voice plays
```

---

## Alternative paid TTS: Voxtral API

**Voxtral** is a competing cloud-TTS-with-cloning service: $0.016/1K chars, 70 ms streaming, voice cloning supported. Cheaper per-character than ElevenLabs but with a less polished SDK/tooling story as of May 2026.

**Not in this plan's scope** — but the recommended path if/when you want it is identical to the ElevenLabs work above: clone `src/backends/tts/elevenlabs.ts` to `voxtral.ts`, swap the endpoint URL and auth header pattern, register `case "voxtral":` in `src/backends/registry.ts`. The `VoiceLibrary` from Plan 6 already accepts `provider: voxtral` as a manifest type. Half-day task when needed.

See [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md#tts-voice-cloning) for the comparison row.

---

## What's deliberately NOT in this plan

- **Deepgram STT.** Local `faster-whisper-large-v3-turbo` on CUDA is already <300 ms and uses <2 GB VRAM. Offloading STT to a cloud API saves negligible resources and adds network latency. The registry stub for `"deepgram"` stays as a `throw "not yet implemented"` placeholder; revisit only if a streaming-partials use case appears.
- **OpenAI / Gemini / Mistral LLM providers.** Single paid LLM is enough for the router; the brain layer's multi-CLI coverage comes from Plan 1.
- **Voxtral TTS.** Section above — covered conceptually, not implemented here. Use when ElevenLabs pricing or quality stops fitting.
- **Streaming TTS via ElevenLabs WebSocket.** The HTTP endpoint is simpler and chunked TTS at the sentence boundary (already done by `StreamingTTS`) hides most of the latency. Add streaming only if a measurable gap appears in practice.
- **Caching of TTS audio.** Not load-bearing for personal use. Revisit if costs become noticeable (won't at expected volumes).

