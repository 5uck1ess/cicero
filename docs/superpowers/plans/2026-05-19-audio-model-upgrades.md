# Audio Model Upgrades — Moonshine STT + OmniVoice TTS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire two SOTA audio models identified in [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md) as **alternative** providers (not new defaults): Moonshine v2 for STT and OmniVoice for TTS. Both have registry stubs already (`src/backends/registry.ts:36, 54`). Add the underlying Python ML servers, the TS provider classes, the config plumbing, and a manual validation harness for the user to compare against current defaults before promoting either to default.

**Architecture:** Mirrors the existing pattern — Bun/TS provider class implements `STTProvider` / `TTSProvider` interface and HTTPs against a Python ML server on the standard port (8083 for STT, 8082 for TTS). Servers are mutually exclusive per role — only one STT and one TTS run at a time based on `~/.cicero/config.yaml`.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, Python 3.11+ (existing `servers/` pattern), fetch / FormData. New Python deps: `moonshine-ai` (MIT, ~250MB), `omnivoice` (license per repo).

**Non-defaults policy:** Defaults stay on `whisper-large-v3-turbo` / `Kokoro` per the model-recs operating principle ("Defaults stay stable. The working MacBook keeps working"). The validation harness produces the data needed to *decide* whether to flip defaults — promotion is a separate config change, not part of this plan.

**Skipped from the model-recs list:**
- **Nemotron Speech 0.6B** — only worth wiring when CUDA streaming latency becomes the bottleneck. Defer.
- **NVIDIA Parakeet TDT 0.6B v2** — only worth wiring when WER on the 5090 becomes the bottleneck. Defer.
- **Pocket-TTS / LuxTTS** — appliance scenarios (CPU-only / low VRAM). Defer until that deployment shape exists.
- **Qwen3-TTS 1.7B (larger Mac variant)** — pure config swap, no code. Document but don't add a task.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `servers/moonshine_server.py` | NEW | FastAPI wrap of Moonshine v2 (`/inference` endpoint matching whisper server shape) |
| `servers/omnivoice_server.py` | NEW | FastAPI wrap of OmniVoice (`/v1/audio/speech` endpoint matching Kokoro shape) |
| `src/backends/stt/moonshine.ts` | NEW | TS provider, mirrors `MlxWhisperProvider` |
| `src/backends/tts/omnivoice.ts` | NEW | TS provider, mirrors `KokoroProvider` |
| `src/backends/registry.ts` | MODIFY | Replace `throw` stubs at lines 36 + 54 with `return new MoonshineProvider(...)` / `return new OmniVoiceProvider(...)` |
| `src/config.ts` | MODIFY | Add Moonshine + OmniVoice to the server-spec map so `managed-server.ts` can start them |
| `scripts/validate-stt.ts` | NEW | Manual A/B harness: record N utterances, run through both backends, output WER + latency table |
| `scripts/validate-tts.ts` | NEW | Manual A/B harness: synthesize N prompts on both backends, write paired wav files for blind listen |
| `validation/stt-prompts.txt` | NEW | Cicero-realistic utterance corpus (wake word, file paths, technical jargon) |
| `validation/tts-prompts.txt` | NEW | Representative response patterns (confirmation, code suggestion, question, long explanation, tech-term salad) |
| `tests/backends-moonshine.test.ts` | NEW | Provider test, mocked fetch |
| `tests/backends-omnivoice.test.ts` | NEW | Provider test, mocked fetch |
| `tests/registry-moonshine-omnivoice.test.ts` | NEW | Registry returns the new providers without throwing |

---

## Phase 1: Moonshine v2 STT

### Task 1: Python server

**Files:**
- Create: `servers/moonshine_server.py`

- [ ] **Step 1: Write the integration test (skipped if Moonshine model not installed)**

Create `tests/server-moonshine.test.ts`:

```ts
import { test, expect } from "bun:test";

const SKIP = !process.env.CICERO_TEST_MOONSHINE;
test.skipIf(SKIP)("moonshine server responds to /inference with WAV input", async () => {
  const wav = Bun.file("tests/fixtures/hello.wav");
  const formData = new FormData();
  formData.append("file", wav, "audio.wav");
  const res = await fetch("http://localhost:8083/inference", { method: "POST", body: formData });
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(typeof data.text).toBe("string");
});
```

- [ ] **Step 2: Implement the server**

`servers/moonshine_server.py`:

```python
import argparse, io
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import uvicorn
import numpy as np
import soundfile as sf
import moonshine

app = FastAPI()
MODEL = None

@app.on_event("startup")
def load():
    global MODEL
    MODEL = moonshine.load_model("moonshine/base")  # or "moonshine/tiny"

@app.get("/")
def root():
    return {"ok": True, "model": "moonshine"}

@app.post("/inference")
async def inference(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    audio, sr = sf.read(io.BytesIO(audio_bytes))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        # moonshine expects 16kHz — resample if needed
        from scipy.signal import resample
        audio = resample(audio, int(len(audio) * 16000 / sr))
    text = moonshine.transcribe(audio, model=MODEL)
    return JSONResponse({"text": text})

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8083)
    p.add_argument("--model", default="moonshine/base")
    args = p.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
```

- [ ] **Step 3: Document install in `servers/README.md`** (or new section): `pip install useful-moonshine soundfile scipy fastapi uvicorn`. Note that the Moonshine package name may vary — check `github.com/moonshine-ai/moonshine` for current pip name.

- [ ] **Step 4: Manual smoke test**

```bash
python servers/moonshine_server.py --port 8083 &
curl -F "file=@tests/fixtures/hello.wav" http://localhost:8083/inference
```

Expected: JSON with non-empty `text` field. If response shape differs from Whisper server, the TS provider needs to adapt — note any discrepancy.

### Task 2: TS provider

**Files:**
- Create: `src/backends/stt/moonshine.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/backends-moonshine.test.ts`:

```ts
import { test, expect, mock } from "bun:test";
import { MoonshineProvider } from "../src/backends/stt/moonshine";

test("MoonshineProvider hits /inference and returns cleaned text", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ text: "  hello world  " }))) as typeof fetch;

  const provider = new MoonshineProvider({ backend: "moonshine", port: 8083 });
  const result = await provider.transcribe("/tmp/fake.wav");
  expect(result).toBe("hello world");

  globalThis.fetch = origFetch;
});

test("MoonshineProvider returns null on server error", async () => {
  globalThis.fetch = mock(async () => new Response("err", { status: 500 })) as typeof fetch;
  const provider = new MoonshineProvider({ backend: "moonshine", port: 8083 });
  expect(await provider.transcribe("/tmp/fake.wav")).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (file doesn't exist)

- [ ] **Step 3: Implement the provider**

Copy `src/backends/stt/mlx-whisper.ts` to `src/backends/stt/moonshine.ts`. Change:
- Class name → `MoonshineProvider`
- `readonly name = "moonshine"`
- Default model → `"moonshine/base"`
- Default port → 8083 (same role; only one STT runs at a time)

Endpoint and request shape stay identical — the Python server matches Whisper's `/inference` contract by design.

- [ ] **Step 4: Run — expect PASS**

### Task 3: Registry + config wiring

**Files:**
- Modify: `src/backends/registry.ts:36`
- Modify: `src/config.ts` (server-spec map)
- Modify: `src/backends/managed-server.ts` if it has per-backend startup logic

- [ ] **Step 1: Write the failing registry test**

Create `tests/registry-moonshine-omnivoice.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createSTTProvider } from "../src/backends/registry";

test("registry returns MoonshineProvider when backend is 'moonshine'", () => {
  const provider = createSTTProvider({
    sttBackend: { backend: "moonshine", port: 8083, model: "moonshine/base" },
  } as any);
  expect(provider.name).toBe("moonshine");
});
```

- [ ] **Step 2: Run — expect FAIL** (current code throws)

- [ ] **Step 3: Update `src/backends/registry.ts`**

Replace lines 35-38:

```ts
case "moonshine":
  return new MoonshineProvider(sttConfig);
case "nemotron":
case "deepgram":
  throw new Error(`STT backend '${sttConfig.backend}' is not yet implemented...`);
```

Import `MoonshineProvider` at the top.

- [ ] **Step 4: Add server-spec entry**

In `src/config.ts`, wherever `DEFAULT_CONFIG.servers` defines `mlx-whisper` and `faster-whisper`, add a `moonshine` entry pointing to `servers/moonshine_server.py` with `--port 8083 --model {model}`. Pattern matches existing spec.

- [ ] **Step 5: Run — expect PASS** + full `bun test` suite green

---

## Phase 2: OmniVoice TTS

### Task 4: Python server

**Files:**
- Create: `servers/omnivoice_server.py`

- [ ] **Step 1: Implement the server**

OmniVoice should expose an OpenAI-compatible `/v1/audio/speech` endpoint matching Kokoro's contract so the existing `KokoroProvider` template fits with minimal changes:

```python
import argparse, io
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
import soundfile as sf
import numpy as np
# Import path depends on actual omnivoice package — check upstream repo
import omnivoice

app = FastAPI()
MODEL = None

@app.on_event("startup")
def load():
    global MODEL
    MODEL = omnivoice.load_model()

class SpeechRequest(BaseModel):
    model: str = "omnivoice"
    input: str
    voice: str = "default"
    response_format: str = "wav"
    speed: float = 1.0

@app.get("/")
def root():
    return {"ok": True, "model": "omnivoice"}

@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    audio = omnivoice.synthesize(req.input, voice=req.voice, model=MODEL)
    # audio is np.ndarray float32 mono at model's native SR
    buf = io.BytesIO()
    sf.write(buf, audio, omnivoice.SAMPLE_RATE, format="WAV")
    buf.seek(0)
    return StreamingResponse(buf, media_type="audio/wav")

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8082)
    p.add_argument("--model", default="omnivoice")
    args = p.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)
```

If OmniVoice's actual Python API differs (it almost certainly will — check the upstream repo), adapt the `omnivoice.synthesize(...)` call. Don't fight the upstream API.

- [ ] **Step 2: Document install** in `servers/README.md`.

- [ ] **Step 3: Manual smoke test**

```bash
python servers/omnivoice_server.py --port 8082 &
curl -X POST http://localhost:8082/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world","voice":"default"}' \
  --output /tmp/omnivoice-test.wav
afplay /tmp/omnivoice-test.wav  # macOS
```

Expected: audible "hello world" played back. If voice slot or model name differs from defaults, update.

### Task 5: TS provider

**Files:**
- Create: `src/backends/tts/omnivoice.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/backends-omnivoice.test.ts`. Mock `fetch`; assert provider POSTs JSON `{input, voice, response_format: "wav"}` and returns the binary stream.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement the provider**

Copy `src/backends/tts/kokoro.ts` to `src/backends/tts/omnivoice.ts`. Change:
- Class name → `OmniVoiceProvider`
- `readonly name = "omnivoice"`
- Default model → `"omnivoice"` (or whatever upstream publishes)
- Default voice → `"default"` (TBD when upstream is checked)
- Default port → 8082

Endpoint shape (`/v1/audio/speech` with OpenAI-compatible JSON) stays identical.

- [ ] **Step 4: Run — expect PASS**

### Task 6: Registry + config wiring

**Files:**
- Modify: `src/backends/registry.ts:54`
- Modify: `src/config.ts`

- [ ] **Step 1: Extend the registry test**

In `tests/registry-moonshine-omnivoice.test.ts`, add a TTS variant:

```ts
test("registry returns OmniVoiceProvider when backend is 'omnivoice'", () => {
  const provider = createTTSProvider({
    ttsBackend: { backend: "omnivoice", port: 8082, model: "omnivoice" },
  } as any);
  expect(provider.name).toBe("omnivoice");
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Update registry**

Replace lines 54-58:

```ts
case "omnivoice":
  return new OmniVoiceProvider(ttsConfig);
case "pocket-tts":
case "elevenlabs":
case "voxtral":
  throw new Error(`TTS backend '${ttsConfig.backend}' is not yet implemented...`);
```

Import `OmniVoiceProvider` at the top.

- [ ] **Step 4: Add server-spec entry** in `src/config.ts`.

- [ ] **Step 5: Run — expect PASS** + full `bun test` green

---

## Phase 3: Manual validation harness

These are scripts you run by hand against your own voice, not automated tests. The point is to generate the data needed to decide whether either model should become a default.

### Task 7: STT validation script

**Files:**
- Create: `scripts/validate-stt.ts`
- Create: `validation/stt-prompts.txt`

- [ ] **Step 1: Build the prompt corpus**

In `validation/stt-prompts.txt`, list ~20 utterances representative of Cicero's actual use. Examples:

```
Cicero
Hey Cicero
Cicero, switch to the auth file
Run the test suite
Ask Codex to review this
Open a new tab for the merge plans
TypeScript, Bun, dot ts
src slash backends slash registry dot ts
The faster-whisper provider has a port number
Pull request review
What's in tab-inject dot ts
```

Mix wake-word phrases, technical tokens, file paths, and longer commands.

- [ ] **Step 2: Implement the harness**

`scripts/validate-stt.ts`:

```ts
#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { MlxWhisperProvider } from "../src/backends/stt/mlx-whisper";
import { MoonshineProvider } from "../src/backends/stt/moonshine";

const prompts = readFileSync("validation/stt-prompts.txt", "utf8").split("\n").filter(Boolean);

console.log("RECORDING PROTOCOL:");
console.log("1. Start both STT servers (whisper on 8083, moonshine on 8084 for this test).");
console.log("2. For each prompt below, record yourself reading it once. Save as validation/recordings/NN.wav.");
console.log("3. Re-run this script with --analyze to compare.\n");

if (!process.argv.includes("--analyze")) {
  prompts.forEach((p, i) => console.log(`${String(i + 1).padStart(2, "0")}: ${p}`));
  process.exit(0);
}

const whisper = new MlxWhisperProvider({ backend: "mlx-whisper", port: 8083 });
const moonshine = new MoonshineProvider({ backend: "moonshine", port: 8084 });

const rows: string[] = ["#\tprompt\twhisper_text\twhisper_ms\tmoonshine_text\tmoonshine_ms"];
for (let i = 0; i < prompts.length; i++) {
  const file = `validation/recordings/${String(i + 1).padStart(2, "0")}.wav`;
  const t0w = performance.now();
  const w = await whisper.transcribe(file);
  const tw = (performance.now() - t0w).toFixed(0);
  const t0m = performance.now();
  const m = await moonshine.transcribe(file);
  const tm = (performance.now() - t0m).toFixed(0);
  rows.push(`${i + 1}\t${prompts[i]}\t${w ?? ""}\t${tw}\t${m ?? ""}\t${tm}`);
}
writeFileSync("validation/stt-results.tsv", rows.join("\n"));
console.log("Wrote validation/stt-results.tsv");
```

- [ ] **Step 3: Run the protocol**

```bash
bun scripts/validate-stt.ts                 # prints prompts to read
# (you record each prompt as validation/recordings/01.wav .. 20.wav)
bun scripts/validate-stt.ts --analyze       # produces validation/stt-results.tsv
```

- [ ] **Step 4: Manually compute WER on the technical-token subset**

Open `validation/stt-results.tsv` in a spreadsheet. For each row, mark whether key tokens (wake word, technical terms, file paths) are correctly transcribed. Compute per-model:
- Wake-word recognition rate
- Technical-token WER
- Median latency

Record the numbers at the bottom of `validation/stt-results.tsv` or in a new `validation/stt-decision.md` note.

### Task 8: TTS validation script

**Files:**
- Create: `scripts/validate-tts.ts`
- Create: `validation/tts-prompts.txt`

- [ ] **Step 1: Build the prompt corpus**

In `validation/tts-prompts.txt`, list 8-10 representative response patterns:

```
Got it.
I'll run the test suite now and report back.
Did you mean the auth middleware file at src slash routes slash auth dot ts, or the older one in legacy?
Switching brain to Codex. Anything you want me to tell it first?
The faster-whisper provider lives at src/backends/stt/faster-whisper.ts and listens on port 8083 by default. The MLX whisper provider is at the parallel mlx-whisper.ts file.
Cicero, TypeScript, Bun, kitty, tmux, Moonshine, OmniVoice, VibeVoice.
```

Mix confirmations, questions, long explanations, code references, and pronunciation challenges.

- [ ] **Step 2: Implement the harness**

`scripts/validate-tts.ts`:

```ts
#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { KokoroProvider } from "../src/backends/tts/kokoro";
import { OmniVoiceProvider } from "../src/backends/tts/omnivoice";

const prompts = readFileSync("validation/tts-prompts.txt", "utf8").split("\n").filter(Boolean);
mkdirSync("validation/synth", { recursive: true });

const kokoro = new KokoroProvider({ backend: "kokoro", port: 8082, voice: "am_onyx" });
const omnivoice = new OmniVoiceProvider({ backend: "omnivoice", port: 8085 });

for (let i = 0; i < prompts.length; i++) {
  const idx = String(i + 1).padStart(2, "0");
  const t0k = performance.now();
  await kokoro.speakToFile(prompts[i], `validation/synth/${idx}-kokoro.wav`);
  const tk = (performance.now() - t0k).toFixed(0);
  const t0o = performance.now();
  await omnivoice.speakToFile(prompts[i], `validation/synth/${idx}-omnivoice.wav`);
  const to = (performance.now() - t0o).toFixed(0);
  console.log(`${idx}: kokoro=${tk}ms omnivoice=${to}ms`);
}
console.log("\nBlind listen:");
console.log("  for f in validation/synth/*.wav; do echo $f; afplay $f; done");
```

Note: this requires `speakToFile(text, path)` on each provider. The existing `Speaker.speak(text)` plays to default audio out; we need a file-output variant. If absent, extend `TTSProvider` interface with `synthesize(text): Promise<Buffer>` and write the buffer in the script.

- [ ] **Step 3: Run the protocol**

```bash
bun scripts/validate-tts.ts
# Then blind-listen each pair without checking the filename first
for f in validation/synth/*.wav; do
  afplay "$f"
  read -p "Which sounded better? [k/o] " choice
  echo "$f $choice" >> validation/tts-votes.txt
done
```

- [ ] **Step 4: Tally results**

Aggregate `validation/tts-votes.txt`. If Kokoro wins ≥ 6/10, keep it as default. If OmniVoice wins ≥ 6/10, plan to swap default in a follow-up commit. If split, listen again on the disagreements and decide which voice characteristics matter more for the assistant role.

---

## Phase 4: Decision + documentation

### Task 9: Capture results

**Files:**
- Create: `validation/audio-bake-off-may2026.md`
- Modify: `docs/superpowers/model-recommendations-may-2026.md` (status column)

- [ ] **Step 1: Write up the validation results**

In `validation/audio-bake-off-may2026.md`, record:
- Date, mic setup, environment (kitty session, headphones vs speakers).
- STT WER per model on the technical-token subset.
- STT median latency per model.
- TTS subjective vote tally.
- Recommended default for each role going forward.
- Open issues (e.g., "OmniVoice mispronounces 'Cicero'").

- [ ] **Step 2: Update model-recs status**

In `docs/superpowers/model-recommendations-may-2026.md`, change Moonshine and OmniVoice rows from "stub / strong upgrade candidate" to one of:
- **Wired, not default** — provider works; defaults unchanged
- **Wired, new default** — promotion happened (if validation said so)
- **Wired, removed** — tested, rejected, code stays for re-test if upstream updates

Reference `validation/audio-bake-off-may2026.md` from the row's notes column.

- [ ] **Step 3: Final test pass**

`bun test` — all green. No regressions on existing 240+ tests.

- [ ] **Step 4: Commit**

Suggested commit messages:
- `feat: wire Moonshine v2 STT as alternative provider`
- `feat: wire OmniVoice TTS as alternative provider`
- `feat: add audio validation harness (scripts/validate-{stt,tts}.ts)`
- `docs: record May 2026 audio bake-off results, update model-recs`

(Four small commits beats one big one for review.)

---

## Acceptance checklist

- [ ] `MoonshineProvider` and `OmniVoiceProvider` exist and pass unit tests
- [ ] Registry returns each when configured; no throws
- [ ] Python servers start cleanly via `managed-server.ts` and respond to health checks
- [ ] `scripts/validate-stt.ts --analyze` produces a results TSV
- [ ] `scripts/validate-tts.ts` produces paired WAV files for blind listen
- [ ] `validation/audio-bake-off-may2026.md` records the actual user decision
- [ ] `docs/superpowers/model-recommendations-may-2026.md` reflects current wiring status
- [ ] Defaults in `DEFAULT_CONFIG.servers.*` and provider class fallbacks **unchanged** unless validation explicitly promoted the new model
- [ ] `bun test` — 240+ tests still pass
