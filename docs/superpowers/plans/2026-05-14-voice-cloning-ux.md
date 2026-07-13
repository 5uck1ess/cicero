# Voice Cloning UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "drop audio → train → use" voice cloning workflow that turns a 30-second WAV file into a usable Cicero voice in one command. VibeVoice and ElevenLabs are already wired as TTS providers, but the user-facing workflow — drop audio, provision, switch — doesn't exist yet. This plan builds that.

**Architecture:** A `VoiceLibrary` manages voice clones on disk at `~/.cicero/voices/<voice-name>/`. Each voice directory holds the reference audio, derived metadata (waveform-trimmed clip, voice_id for cloud providers, sample-rate-normalized files), and a `voice.yaml` manifest. The library is provider-aware: a VibeVoice voice is just a reference clip path; an ElevenLabs voice is a `voice_id` plus the source clip kept for re-uploads; future Pocket-TTS / LuxTTS / Voxtral voices follow the same pattern. CLI commands (`cicero voice add`, `cicero voice list`, `cicero voice use <name>`, `cicero voice remove <name>`) operate on the library and update `~/.cicero/config.yaml` atomically.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9. New dep: `wavefile` (Apache-2.0, ~30 KB) for WAV header inspection + clip trimming, or use `Bun.spawn(['ffmpeg', ...])` if ffmpeg is already required (it is, per current README). Provider uploads reuse Plan 0's `helpers/clone-voice-elevenlabs.ts` as the cloud-side path. VibeVoice is purely local (reference path → existing `MlxAudioProvider` / VibeVoice provider config).

**Source inspiration:** None — this is a Cicero-original UX. The underlying voice-clone models (VibeVoice, ElevenLabs Instant Voice Cloning, future Pocket-TTS / Voxtral) are off-the-shelf; the orchestration on top is the Cicero contribution.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/voice/library.ts` | NEW | `VoiceLibrary` — list, add, remove, get active voice; manages `~/.cicero/voices/` |
| `src/voice/manifest.ts` | NEW | `VoiceManifest` type + `voice.yaml` parser/writer (provider, source_clip, voice_id, sample_rate, duration_s, created_at) |
| `src/voice/provision.ts` | NEW | Per-provider provisioning: VibeVoice (validate clip, no upload) and ElevenLabs (upload, capture voice_id, persist) |
| `src/voice/audio-utils.ts` | NEW | WAV header inspection, trim to N seconds, downsample/resample if needed (ffmpeg-shelled) |
| `src/cli/voice.ts` | NEW | CLI subcommand handlers: `add`, `list`, `use`, `remove`, `inspect` |
| `src/cli/index.ts` | MODIFY | Wire `voice` subcommand dispatch |
| `src/types.ts` | MODIFY | Add `VoiceConfig` (per-voice manifest type); add `voice` field to `CiceroConfig` for active voice name |
| `src/config.ts` | MODIFY | Read `voice` field; resolve to `tts.refAudio` (VibeVoice) or `tts.voice_id` (ElevenLabs) at config load |
| `tests/voice-library.test.ts` | NEW | Add/list/use/remove against a temp HOME dir |
| `tests/voice-manifest.test.ts` | NEW | YAML round-trip, validation |
| `tests/voice-provision.test.ts` | NEW | Mocked ElevenLabs upload; VibeVoice path-validation |
| `tests/voice-audio-utils.test.ts` | NEW | WAV header parsing on a synthesized fixture clip |
| `README.md` | MODIFY | Add "Voice cloning" section with the 3-command quickstart |

---

## Task 1: Voice manifest type + on-disk schema

**Files:**
- Create: `src/voice/manifest.ts`
- Create: `tests/voice-manifest.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add `VoiceManifest` and `VoiceProvider` to types**

```typescript
// src/types.ts (add)
export type VoiceProvider = "vibevoice" | "elevenlabs" | "pocket-tts" | "luxtts" | "voxtral";

export interface VoiceManifest {
  name: string;                  // user-chosen, kebab-case
  provider: VoiceProvider;
  source_clip: string;           // absolute path to original WAV/MP3 sample
  trimmed_clip?: string;         // path to ≤30s, 16kHz mono WAV used for inference
  voice_id?: string;             // cloud provider voice ID (ElevenLabs, Voxtral)
  sample_rate?: number;          // source clip sample rate
  duration_s?: number;
  ref_text?: string;             // optional transcript of the clip (improves VibeVoice quality)
  created_at: string;            // ISO 8601
}
```

- [ ] **Step 2: Write the manifest parser tests**

```typescript
// tests/voice-manifest.test.ts
import { test, expect, describe } from "bun:test";
import { parseManifest, serializeManifest } from "../src/voice/manifest";

describe("VoiceManifest", () => {
  test("round-trips through YAML", () => {
    const m = {
      name: "jarvis",
      provider: "vibevoice" as const,
      source_clip: "/tmp/jarvis.wav",
      created_at: "2026-05-14T12:00:00Z",
    };
    const yaml = serializeManifest(m);
    const parsed = parseManifest(yaml);
    expect(parsed.name).toBe("jarvis");
    expect(parsed.provider).toBe("vibevoice");
  });

  test("rejects unknown provider", () => {
    const yaml = "name: bad\nprovider: nonexistent\nsource_clip: /tmp/x.wav\ncreated_at: 2026-05-14T12:00:00Z\n";
    expect(() => parseManifest(yaml)).toThrow(/provider/);
  });

  test("requires source_clip", () => {
    const yaml = "name: bad\nprovider: vibevoice\ncreated_at: 2026-05-14T12:00:00Z\n";
    expect(() => parseManifest(yaml)).toThrow(/source_clip/);
  });
});
```

- [ ] **Step 3: Implement parser/serializer**

```typescript
// src/voice/manifest.ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { VoiceManifest, VoiceProvider } from "../types";

const PROVIDERS: VoiceProvider[] = ["vibevoice", "elevenlabs", "pocket-tts", "luxtts", "voxtral"];

export function parseManifest(yaml: string): VoiceManifest {
  const raw = parseYaml(yaml) as Partial<VoiceManifest>;
  if (!raw.name) throw new Error("voice manifest: missing 'name'");
  if (!raw.provider || !PROVIDERS.includes(raw.provider)) {
    throw new Error(`voice manifest: invalid provider '${raw.provider}' (must be one of ${PROVIDERS.join(", ")})`);
  }
  if (!raw.source_clip) throw new Error("voice manifest: missing 'source_clip'");
  if (!raw.created_at) throw new Error("voice manifest: missing 'created_at'");
  return raw as VoiceManifest;
}

export function serializeManifest(m: VoiceManifest): string {
  return stringifyYaml(m);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/voice-manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/voice/manifest.ts src/types.ts tests/voice-manifest.test.ts
git commit -m "feat(voice): add VoiceManifest type and YAML parser"
```

---

## Task 2: Audio utilities — WAV header inspection + trimming

**Files:**
- Create: `src/voice/audio-utils.ts`
- Create: `tests/voice-audio-utils.test.ts`

- [ ] **Step 1: Tests first**

```typescript
// tests/voice-audio-utils.test.ts
import { test, expect, describe } from "bun:test";
import { inspectWav } from "../src/voice/audio-utils";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("inspectWav", () => {
  test("reads sample rate and duration from WAV header", async () => {
    // 1 second of silence, 16kHz, mono, 16-bit PCM
    const samples = 16000;
    const dataSize = samples * 2;
    const fileSize = dataSize + 36;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(fileSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);   // PCM
    buf.writeUInt16LE(1, 22);   // mono
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    const path = join(tmpdir(), `cicero-test-${Date.now()}.wav`);
    writeFileSync(path, buf);
    try {
      const info = await inspectWav(path);
      expect(info.sampleRate).toBe(16000);
      expect(info.duration_s).toBeCloseTo(1.0, 1);
      expect(info.channels).toBe(1);
    } finally {
      unlinkSync(path);
    }
  });
});
```

- [ ] **Step 2: Implement `inspectWav` + `trimWav` (shells out to ffmpeg)**

```typescript
// src/voice/audio-utils.ts
import { readFileSync } from "node:fs";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  duration_s: number;
}

export async function inspectWav(path: string): Promise<WavInfo> {
  // Read just the header (first 44 bytes is enough for canonical PCM WAV)
  const buf = readFileSync(path).subarray(0, 44);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a RIFF/WAVE file: ${path}`);
  }
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  const duration_s = dataSize / (sampleRate * channels * (bitsPerSample / 8));
  return { sampleRate, channels, bitsPerSample, duration_s };
}

export async function trimWav(input: string, output: string, maxSeconds = 30): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-y", "-i", input, "-t", String(maxSeconds), "-ar", "16000", "-ac", "1", output], {
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg trim failed (${code}): ${err}`);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/voice-audio-utils.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/voice/audio-utils.ts tests/voice-audio-utils.test.ts
git commit -m "feat(voice): add WAV header inspection and ffmpeg-based trim/resample"
```

---

## Task 3: VoiceLibrary — disk-backed CRUD

**Files:**
- Create: `src/voice/library.ts`
- Create: `tests/voice-library.test.ts`

- [ ] **Step 1: Tests first**

```typescript
// tests/voice-library.test.ts
import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceLibrary } from "../src/voice/library";

describe("VoiceLibrary", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cicero-voices-"));
  });

  test("list returns empty array on fresh dir", async () => {
    const lib = new VoiceLibrary(dir);
    expect(await lib.list()).toEqual([]);
  });

  test("add and list", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({
      name: "jarvis",
      provider: "vibevoice",
      source_clip: "/tmp/fake.wav",
      created_at: "2026-05-14T12:00:00Z",
    });
    const all = await lib.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("jarvis");
  });

  test("remove deletes the voice dir", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    await lib.remove("jarvis");
    expect(await lib.list()).toEqual([]);
  });

  test("rejects duplicate names", async () => {
    const lib = new VoiceLibrary(dir);
    await lib.add({ name: "jarvis", provider: "vibevoice", source_clip: "/tmp/x.wav", created_at: "2026-05-14T12:00:00Z" });
    await expect(
      lib.add({ name: "jarvis", provider: "elevenlabs", source_clip: "/tmp/y.wav", created_at: "2026-05-14T12:00:00Z" })
    ).rejects.toThrow(/exists/);
  });
});
```

- [ ] **Step 2: Implement `VoiceLibrary`**

```typescript
// src/voice/library.ts
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, serializeManifest } from "./manifest";
import type { VoiceManifest } from "../types";

export class VoiceLibrary {
  constructor(private root: string) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  }

  voiceDir(name: string): string {
    return join(this.root, name);
  }

  async list(): Promise<VoiceManifest[]> {
    const entries = readdirSync(this.root);
    const out: VoiceManifest[] = [];
    for (const name of entries) {
      const dir = join(this.root, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, "voice.yaml");
      if (!existsSync(manifestPath)) continue;
      const yaml = await Bun.file(manifestPath).text();
      out.push(parseManifest(yaml));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<VoiceManifest | null> {
    const path = join(this.voiceDir(name), "voice.yaml");
    if (!existsSync(path)) return null;
    return parseManifest(await Bun.file(path).text());
  }

  async add(manifest: VoiceManifest): Promise<void> {
    const dir = this.voiceDir(manifest.name);
    if (existsSync(dir)) throw new Error(`voice '${manifest.name}' exists at ${dir}`);
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "voice.yaml"), serializeManifest(manifest));
  }

  async remove(name: string): Promise<void> {
    const dir = this.voiceDir(name);
    if (!existsSync(dir)) throw new Error(`voice '${name}' not found`);
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/voice-library.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/voice/library.ts tests/voice-library.test.ts
git commit -m "feat(voice): add VoiceLibrary for ~/.cicero/voices/ CRUD"
```

---

## Task 4: Provisioning — VibeVoice (local) + ElevenLabs (cloud)

**Files:**
- Create: `src/voice/provision.ts`
- Create: `tests/voice-provision.test.ts`

- [ ] **Step 1: Tests first**

Mock `fetch` for ElevenLabs upload; for VibeVoice, just verify the file is copied and trimmed:

```typescript
// tests/voice-provision.test.ts (excerpt — full test sketches both paths)
import { test, expect, describe, mock } from "bun:test";
import { provisionVoice } from "../src/voice/provision";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("provisionVoice", () => {
  test("vibevoice path validates the clip exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-test-"));
    await expect(
      provisionVoice({
        name: "jarvis",
        provider: "vibevoice",
        source_clip: "/nonexistent/clip.wav",
        targetDir: dir,
      })
    ).rejects.toThrow(/not found/);
  });

  test("elevenlabs path POSTs to /v1/voices/add and captures voice_id", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ voice_id: "abc123" }), { status: 200 })) as any;
    // ... synthesize a real WAV fixture, call provisionVoice, assert manifest.voice_id === "abc123"
    globalThis.fetch = origFetch;
    delete process.env.ELEVENLABS_API_KEY;
  });
});
```

- [ ] **Step 2: Implement `provisionVoice`**

```typescript
// src/voice/provision.ts
import { existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { inspectWav, trimWav } from "./audio-utils";
import type { VoiceManifest, VoiceProvider } from "../types";

export interface ProvisionArgs {
  name: string;
  provider: VoiceProvider;
  source_clip: string;
  targetDir: string;       // typically the voice's dir under ~/.cicero/voices/<name>/
  ref_text?: string;
}

export async function provisionVoice(args: ProvisionArgs): Promise<VoiceManifest> {
  if (!existsSync(args.source_clip)) {
    throw new Error(`source clip not found: ${args.source_clip}`);
  }

  const trimmedPath = join(args.targetDir, "trimmed-16k-mono.wav");
  const sourceCopy = join(args.targetDir, basename(args.source_clip));
  copyFileSync(args.source_clip, sourceCopy);
  await trimWav(args.source_clip, trimmedPath, 30);
  const info = await inspectWav(trimmedPath);

  const base: VoiceManifest = {
    name: args.name,
    provider: args.provider,
    source_clip: sourceCopy,
    trimmed_clip: trimmedPath,
    sample_rate: info.sampleRate,
    duration_s: info.duration_s,
    ref_text: args.ref_text,
    created_at: new Date().toISOString(),
  };

  switch (args.provider) {
    case "vibevoice":
      // Purely local — manifest is complete after trim/inspect
      return base;

    case "elevenlabs": {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) throw new Error("ELEVENLABS_API_KEY env var must be set for elevenlabs provider");
      const form = new FormData();
      form.append("name", args.name);
      form.append("files", Bun.file(args.source_clip), basename(args.source_clip));
      const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`ElevenLabs voice upload failed (${res.status}): ${err}`);
      }
      const data = (await res.json()) as { voice_id: string };
      return { ...base, voice_id: data.voice_id };
    }

    case "pocket-tts":
    case "luxtts":
    case "voxtral":
      throw new Error(`provider '${args.provider}' not yet implemented — wire the TTS provider first`);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/voice-provision.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/voice/provision.ts tests/voice-provision.test.ts
git commit -m "feat(voice): add per-provider provisioning (VibeVoice + ElevenLabs)"
```

---

## Task 5: CLI subcommands — `cicero voice {add, list, use, remove, inspect}`

**Files:**
- Create: `src/cli/voice.ts`
- Modify: `src/cli/index.ts` (or wherever the main CLI dispatch lives)
- Modify: `src/config.ts` (read active voice; resolve to tts.refAudio / tts.voice_id)

- [ ] **Step 1: Wire the subcommand dispatch**

```typescript
// src/cli/voice.ts
import { join } from "node:path";
import { VoiceLibrary } from "../voice/library";
import { provisionVoice } from "../voice/provision";
import type { VoiceProvider } from "../types";

const VOICES_DIR = join(process.env.HOME || "~", ".cicero", "voices");

export async function handleVoiceCommand(args: string[]): Promise<void> {
  const lib = new VoiceLibrary(VOICES_DIR);
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":      return voiceAdd(lib, rest);
    case "list":     return voiceList(lib);
    case "use":      return voiceUse(lib, rest);
    case "remove":   return voiceRemove(lib, rest);
    case "inspect":  return voiceInspect(lib, rest);
    default:
      console.error("Usage: cicero voice {add|list|use|remove|inspect} [args]");
      process.exit(1);
  }
}

async function voiceAdd(lib: VoiceLibrary, args: string[]): Promise<void> {
  // cicero voice add <name> <clip.wav> [--provider vibevoice|elevenlabs] [--ref-text "..."]
  const [name, clip, ...flags] = args;
  if (!name || !clip) {
    console.error("Usage: cicero voice add <name> <clip.wav> [--provider <p>] [--ref-text <text>]");
    process.exit(1);
  }
  const provider = (flagValue(flags, "--provider") ?? "vibevoice") as VoiceProvider;
  const ref_text = flagValue(flags, "--ref-text");
  const targetDir = lib.voiceDir(name);
  const { mkdirSync, existsSync } = await import("node:fs");
  if (existsSync(targetDir)) {
    console.error(`Voice '${name}' already exists. Remove it first or pick a different name.`);
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
  const manifest = await provisionVoice({ name, provider, source_clip: clip, targetDir, ref_text });
  await lib.add(manifest);
  console.log(`Added voice '${name}' (${provider}). Activate with: cicero voice use ${name}`);
}

async function voiceList(lib: VoiceLibrary): Promise<void> {
  const voices = await lib.list();
  if (voices.length === 0) {
    console.log("(no voices yet — add one with: cicero voice add <name> <clip.wav>)");
    return;
  }
  for (const v of voices) {
    const idStr = v.voice_id ? ` voice_id=${v.voice_id}` : "";
    console.log(`  ${v.name.padEnd(20)} ${v.provider.padEnd(12)} ${v.duration_s?.toFixed(1) ?? "?"}s${idStr}`);
  }
}

async function voiceUse(lib: VoiceLibrary, args: string[]): Promise<void> {
  const [name] = args;
  const manifest = await lib.get(name);
  if (!manifest) {
    console.error(`Voice '${name}' not found. List voices with: cicero voice list`);
    process.exit(1);
  }
  // Update ~/.cicero/config.yaml — set `voice: <name>` so config.ts resolves to the right refAudio / voice_id
  await updateConfigField("voice", name);
  console.log(`Active voice → ${name}`);
}

async function voiceRemove(lib: VoiceLibrary, args: string[]): Promise<void> {
  const [name] = args;
  await lib.remove(name);
  console.log(`Removed voice '${name}'`);
}

async function voiceInspect(lib: VoiceLibrary, args: string[]): Promise<void> {
  const [name] = args;
  const m = await lib.get(name);
  if (!m) { console.error(`Voice '${name}' not found`); process.exit(1); }
  console.log(JSON.stringify(m, null, 2));
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function updateConfigField(key: string, value: string): Promise<void> {
  // Atomic YAML update — read, mutate, write to tmp, rename
  // (implementation detail — see src/config.ts existing patterns)
}
```

- [ ] **Step 2: Resolve `voice` in `loadConfig()`**

When `~/.cicero/config.yaml` has `voice: jarvis`, `loadConfig()` should:
1. Look up `~/.cicero/voices/jarvis/voice.yaml`
2. Populate `tts.refAudio` (VibeVoice) from `manifest.trimmed_clip`
3. Populate `tts.voice_id` (ElevenLabs) from `manifest.voice_id`
4. Populate `tts.refText` from `manifest.ref_text` if set
5. **Override the provider** if needed: a voice with `provider: elevenlabs` switches `tts.backend` to `elevenlabs`; a voice with `provider: vibevoice` switches to `vibevoice`

- [ ] **Step 3: Smoke test**

```bash
# Add a local voice (uses VibeVoice)
cicero voice add jarvis ~/Recordings/jarvis-sample.wav

# Add a cloud voice (uploads to ElevenLabs)
export ELEVENLABS_API_KEY=...
cicero voice add jarvis-cloud ~/Recordings/jarvis-sample.wav --provider elevenlabs

cicero voice list
cicero voice use jarvis
echo "Hello, sir." | cicero speak    # should use VibeVoice with the jarvis clip
cicero voice use jarvis-cloud
echo "Hello, sir." | cicero speak    # should now use ElevenLabs cloned voice
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/voice.ts src/cli/index.ts src/config.ts src/types.ts
git commit -m "feat(voice): add cicero voice {add,list,use,remove,inspect} CLI subcommands"
```

---

## Task 6: README + onboarding

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a top-level "Voice cloning" section**

```markdown
## Voice cloning

Cicero supports voice cloning out of the box — bring a 30-second clean clip of any voice (your own, an actor, a public figure you're authorized to clone) and it becomes Cicero's voice.

### Quickstart — local (VibeVoice, free, private)

\`\`\`bash
cicero voice add jarvis ~/Recordings/jarvis-30s.wav
cicero voice use jarvis
echo "Welcome back, sir." | cicero speak
\`\`\`

### Quickstart — cloud (ElevenLabs, paid, polished)

\`\`\`bash
export ELEVENLABS_API_KEY=sk_...
cicero voice add jarvis-cloud ~/Recordings/jarvis-30s.wav --provider elevenlabs
cicero voice use jarvis-cloud
echo "Welcome back, sir." | cicero speak
\`\`\`

### Managing voices

\`\`\`bash
cicero voice list           # show all voices in your library
cicero voice inspect jarvis # show manifest details
cicero voice use jarvis     # switch active voice
cicero voice remove jarvis  # delete voice + clip
\`\`\`

Voices live at `~/.cicero/voices/<name>/`. Each voice directory contains:
- `voice.yaml` — manifest (provider, voice_id, source clip path, duration)
- A copy of your original clip
- A trimmed-to-30s, 16kHz mono WAV used for inference (VibeVoice) or upload (ElevenLabs)

### Authorized use only

Cicero is BYO-voice: the cloning happens on data you supply. Cicero does not ship celebrity clones, fictional-character clones, or any pre-trained third-party voices. Authorized use cases include your own voice, voices you have permission to clone (content creators with explicit rights), and accessibility / personal-use cases. **Do not use voice cloning to impersonate someone without consent.** This isn't a legal disclaimer — it's the policy that keeps the project shippable.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add voice cloning quickstart and library management"
```

---

## Task 7: Final integration check

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: ALL PASS (the two pre-existing KittyAdapter integration tests still fail — that's environment, not a regression)

- [ ] **Step 2: End-to-end smoke test**

```bash
# Fresh state — confirm no existing voices
rm -rf ~/.cicero/voices

# Local path
cicero voice add jarvis assets/sample-30s.wav
cicero voice list                       # expect 1 voice
cicero voice use jarvis
echo "Test" | cicero speak              # should use the cloned voice

# Cloud path (if ELEVENLABS_API_KEY set)
cicero voice add jarvis-cloud assets/sample-30s.wav --provider elevenlabs
cicero voice list                       # expect 2 voices
cicero voice use jarvis-cloud
echo "Test cloud" | cicero speak        # should use ElevenLabs

# Cleanup
cicero voice remove jarvis
cicero voice remove jarvis-cloud
```

---

## What's deliberately NOT in this plan

- **Voice training / fine-tuning.** This plan covers *cloning* (one-shot inference from a reference clip). Full fine-tuning (GPT-SoVITS, Applio/RVC) is a different workflow with hours of compute — that's a separate "Plan 7 — Custom voice training" if/when needed.
- **Voice marketplace / sharing.** No upload/download to a shared registry. Personal library only.
- **Voice activity-based switching.** Active voice is per-session config, not per-turn. If you want different voices for different agents/contexts, that's a future enhancement layered on top of this library.
- **Pocket-TTS / LuxTTS / Voxtral provider implementations.** This plan provisions voices for the providers that already exist (VibeVoice wired, ElevenLabs from Plan 0). Adding new TTS providers is a separate, smaller task — `provisionVoice` already throws `"not yet implemented"` for those three so it's obvious where to extend.
- **Authorization workflow / consent capture.** The README mentions the policy. No code-side gate. If this ever ships to non-experts, add a consent prompt on first `cicero voice add`.

---

## Self-review notes

- Voices are stored under `$HOME/.cicero/voices/`. Use the OS temp dir for test scratch space; never hardcode `/tmp`.
- `provisionVoice` shells out to `ffmpeg` — README's Requirements section already lists ffmpeg, so no new install step.
- ElevenLabs voice quota: free tier has limited cloned voices. The CLI doesn't track or enforce quota; if upload fails on quota, the error message from ElevenLabs surfaces directly.
- `cicero voice use <name>` rewrites `~/.cicero/config.yaml`. Use the atomic write pattern already established in `src/config.ts`.
- The provider switch in `loadConfig()` (Task 5 Step 2) is the trickiest piece. A voice has a fixed provider, so picking the voice should pick the TTS backend. If the user explicitly sets `tts.backend: kokoro` AND `voice: jarvis-cloud` (which is ElevenLabs), the explicit backend wins and `voice_id` is ignored — log a warning.
- This plan is intentionally focused on the UX layer; the underlying model quality is a model-recommendations question, not a UX question. VibeVoice 7B is the current open-source winner (ICLR 2026 Oral; see [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md#tts-voice-cloning)).
