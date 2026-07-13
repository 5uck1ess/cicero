# Listener Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four additions to `src/listener/`: (1) wake-word-anywhere transcript scanner (steal idea from isair/jarvis — say "Jarvis" anywhere in a sentence to address Cicero), (2) mid-reply "stop" interrupt that extends the existing barge-in to react to verbal stop commands, (3) dictation mode (hold-hotkey-to-paste — free WisprFlow alternative), (4) Silero VAD as a proper voice-activity gate replacing the current sox amplitude-threshold silence check.

**Architecture:** Cicero's `ConversationalListener` already has the recording + STT + barge-in scaffolding. Three of the four features extend existing flows; dictation mode is a new listener variant. Wake-word detection is implemented at the transcript level (scan post-STT text) rather than via a dedicated wake-word engine, because Cicero already runs continuous STT in conversational mode. For "always-on" wake-word without conversational mode, add an optional OpenWakeWord-driven gate later. The Silero VAD task replaces the crude sox `silence` amplitude threshold (which cuts off on quiet voice or holds open in noisy rooms) with a proper ONNX VAD model.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, existing `Bun.spawn` + sox recorder. New dep: `onnxruntime-node` for Silero VAD (also unlocks OpenWakeWord later — they share the same runtime).

**Source inspiration:** [`isair/jarvis`](https://github.com/isair/jarvis) — wake-word-anywhere UX and dictation mode. Non-commercial license: read for patterns; reimplement clean in TS, do not vendor.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/listener/conversational.ts` | MODIFY | Add wake-word-anywhere matching, mid-reply stop detection, Silero VAD silence gate |
| `src/listener/dictation.ts` | NEW | Hold-hotkey-to-paste dictation mode |
| `src/listener/wake-word.ts` | NEW | Transcript-scan wake-word matcher (no engine, pure string logic) |
| `src/listener/silero-vad.ts` | NEW | Silero VAD wrapper — loads the ONNX model, exposes `isSpeech(samples)` |
| `src/listener/index.ts` | MODIFY | Factory exposes dictation listener |
| `src/types.ts` | MODIFY | Add `WakeWordConfig` and `VADConfig`; extend `CiceroConfig` with `wake_word.phrases`, `wake_word.required`, `vad.enabled`, `vad.threshold` |
| `src/config.ts` | MODIFY | Wire wake-word + VAD config defaults |
| `assets/silero_vad.onnx` | NEW | Bundled Silero VAD model (~1.8 MB, MIT) |
| `helpers/cicero-dictation-hotkey.swift` | NEW | macOS hotkey helper for dictation (hold-to-record); Windows/Linux equivalents stubbed |
| `tests/listener-wake-word.test.ts` | NEW | Tests for the wake-word matcher |
| `tests/listener-silero-vad.test.ts` | NEW | Tests for VAD wrapper (mocked ONNX session) |
| `tests/listener-dictation.test.ts` | NEW | Tests for dictation mode state machine |
| `tests/listener-stop-interrupt.test.ts` | NEW | Tests for mid-reply stop |

---

## Task 1: Add wake-word matcher

**Files:**
- Create: `src/listener/wake-word.ts`
- Test: `tests/listener-wake-word.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { matchWakeWord, stripWakeWord } from "../src/listener/wake-word";

test("matchWakeWord finds phrase anywhere in the transcript", () => {
  expect(matchWakeWord("Hey Jarvis what's the time", ["jarvis"])).toBe(true);
  expect(matchWakeWord("What's the time Jarvis?", ["jarvis"])).toBe(true);
  expect(matchWakeWord("Tell me a joke Cicero", ["cicero", "jarvis"])).toBe(true);
});

test("matchWakeWord is case-insensitive and ignores punctuation", () => {
  expect(matchWakeWord("JARVIS, time?", ["jarvis"])).toBe(true);
  expect(matchWakeWord("So, Jarvis... what now?", ["jarvis"])).toBe(true);
});

test("matchWakeWord rejects transcripts without the phrase", () => {
  expect(matchWakeWord("what time is it", ["jarvis"])).toBe(false);
  expect(matchWakeWord("hello there", ["jarvis", "cicero"])).toBe(false);
});

test("matchWakeWord handles homophones via aliases", () => {
  // STT sometimes hears "Travis" / "Charles" for "Jarvis"
  expect(matchWakeWord("Hey Travis", ["jarvis", "travis"])).toBe(true);
});

test("stripWakeWord removes the wake phrase from the query", () => {
  expect(stripWakeWord("Hey Jarvis what's the time", ["jarvis"])).toBe("what's the time");
  expect(stripWakeWord("What's the time Jarvis?", ["jarvis"])).toBe("What's the time?");
  expect(stripWakeWord("Jarvis", ["jarvis"])).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/listener-wake-word.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/listener/wake-word.ts

const PUNCTUATION = /[.,!?;:'"()\[\]{}]/g;

function normalize(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION, " ").replace(/\s+/g, " ").trim();
}

export function matchWakeWord(transcript: string, phrases: string[]): boolean {
  const norm = ` ${normalize(transcript)} `;
  return phrases.some(p => norm.includes(` ${p.toLowerCase()} `));
}

export function stripWakeWord(transcript: string, phrases: string[]): string {
  // Remove the first occurrence of any wake phrase, plus any leading filler.
  let result = transcript;
  for (const phrase of phrases) {
    const pattern = new RegExp(
      `\\b(hey\\s+|ok\\s+|hi\\s+)?${phrase}\\b[,\\s]*`,
      "i",
    );
    result = result.replace(pattern, "");
  }
  return result.replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/listener-wake-word.test.ts`
Expected: PASS for all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/listener/wake-word.ts tests/listener-wake-word.test.ts
git commit -m "feat(listener): add transcript-scan wake-word matcher"
```

---

## Task 2: Extend CiceroConfig with wake_word section

**Files:**
- Modify: `src/types.ts`, `src/config.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
test("wake_word config defaults to disabled with sensible phrases", () => {
  const cfg = loadConfig({});
  expect(cfg.wakeWordEnabled).toBe(false);
  expect(cfg.raw.wake_word_phrases).toEqual(["cicero", "jarvis"]);
  expect(cfg.raw.wake_word_required).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL — fields don't exist on CiceroConfig.

- [ ] **Step 3: Extend type and defaults**

In `src/types.ts`, extend `CiceroConfig`:

```ts
export interface CiceroConfig {
  // ... existing fields ...
  wake_word_phrases?: string[];   // alternate wake words (default ["cicero", "jarvis"])
  wake_word_required?: boolean;   // if true, ignore any transcript not containing a wake word
}
```

In `src/config.ts` DEFAULT_CONFIG, add:

```ts
wake_word_phrases: ["cicero", "jarvis"],
wake_word_required: false,
```

In `RuntimeConfig`, add accessors:

```ts
get wakeWordPhrases(): string[] { return this.config.wake_word_phrases ?? ["cicero", "jarvis"]; }
get wakeWordRequired(): boolean { return this.config.wake_word_required ?? false; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(config): add wake_word_phrases and wake_word_required"
```

---

## Task 3: Wire wake-word gating into ConversationalListener

**Files:**
- Modify: `src/listener/conversational.ts`
- Modify: `src/listener/index.ts` (pass config through)
- Test: extend `tests/listener-wake-word.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/listener-wake-word.test.ts`:

```ts
import { ConversationalListener } from "../src/listener/conversational";

test("ConversationalListener with wakeWordRequired=true drops non-wake transcripts", async () => {
  // Build a fake STT that returns whatever we tell it
  const fakeSTT = {
    transcribe: async () => "what time is it",  // no wake word
  } as any;
  const fakeRecorder = {
    record: () => ({ exited: Promise.resolve(0), kill: () => {} } as any),
  } as any;
  const fakePlayer = { play: async () => {}, stop: async () => {} } as any;

  const listener = new ConversationalListener(fakeSTT, fakeRecorder, fakePlayer, false, "1", "5%");
  listener.setWakeWord(["jarvis"], true);

  let received: string | null = null;
  listener.onCommand((text) => { received = text; });

  // Manually exercise the wake-word gate logic
  expect(listener.shouldProcessTranscript("what time is it")).toBe(false);
  expect(listener.shouldProcessTranscript("jarvis what time is it")).toBe(true);
});

test("Listener strips wake word from transcript before firing callback", () => {
  const fakeSTT = { transcribe: async () => "" } as any;
  const fakeRecorder = { record: () => ({} as any) } as any;
  const fakePlayer = { play: async () => {}, stop: async () => {} } as any;

  const listener = new ConversationalListener(fakeSTT, fakeRecorder, fakePlayer, false, "1", "5%");
  listener.setWakeWord(["jarvis"], true);

  expect(listener.preprocessTranscript("Hey Jarvis what time is it")).toBe("what time is it");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/listener-wake-word.test.ts`
Expected: FAIL — `setWakeWord`, `shouldProcessTranscript`, `preprocessTranscript` don't exist.

- [ ] **Step 3: Add wake-word methods to ConversationalListener**

In `src/listener/conversational.ts`, add as members:

```ts
private wakeWordPhrases: string[] = [];
private wakeWordRequired = false;

setWakeWord(phrases: string[], required: boolean): void {
  this.wakeWordPhrases = phrases;
  this.wakeWordRequired = required;
}

shouldProcessTranscript(transcript: string): boolean {
  if (!this.wakeWordRequired) return true;
  if (this.wakeWordPhrases.length === 0) return true;
  const { matchWakeWord } = require("./wake-word");
  return matchWakeWord(transcript, this.wakeWordPhrases);
}

preprocessTranscript(transcript: string): string {
  if (this.wakeWordPhrases.length === 0) return transcript;
  const { stripWakeWord } = require("./wake-word");
  return stripWakeWord(transcript, this.wakeWordPhrases);
}
```

In the `listenLoop()` method, after STT transcription, add the gate (around the existing `if (!transcript || !this.active) continue;`):

```ts
if (!this.shouldProcessTranscript(transcript)) {
  log("info", `Heard "${transcript}" — no wake word, ignoring`);
  continue;
}
const cleanedTranscript = this.preprocessTranscript(transcript);
```

Then pass `cleanedTranscript` to the callback instead of the raw `transcript`.

- [ ] **Step 4: Wire up the config**

In `src/listener/index.ts`, update `createConversationalListener` to apply the wake-word config:

```ts
export function createConversationalListener(
  config: RuntimeConfig,
  sttProvider: STTProvider,
  recorder: AudioRecorder,
  audioPlayer: AudioPlayer,
): ConversationalListener {
  const listener = new ConversationalListener(
    sttProvider,
    recorder,
    audioPlayer,
    config.bargeInEnabled,
    config.silenceDuration,
    config.silenceThreshold,
  );
  listener.setWakeWord(config.wakeWordPhrases, config.wakeWordRequired);
  return listener;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/listener-wake-word.test.ts`
Expected: PASS for all wake-word tests.

- [ ] **Step 6: Commit**

```bash
git add src/listener/conversational.ts src/listener/index.ts tests/listener-wake-word.test.ts
git commit -m "feat(listener): wake-word-required mode with anywhere-in-sentence matching"
```

---

## Task 4: Add mid-reply stop interrupt

**Files:**
- Modify: `src/listener/conversational.ts`
- Test: `tests/listener-stop-interrupt.test.ts`

The existing `bargeInEnabled` path already detects new speech during TTS playback. The user can already interrupt by speaking anything — but specifically saying "stop" / "wait" / "cancel" should ALWAYS interrupt and NOT be passed downstream as a new command.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { isStopCommand } from "../src/listener/conversational";

test("isStopCommand recognizes verbal stop variants", () => {
  expect(isStopCommand("stop")).toBe(true);
  expect(isStopCommand("Stop.")).toBe(true);
  expect(isStopCommand("wait")).toBe(true);
  expect(isStopCommand("cancel")).toBe(true);
  expect(isStopCommand("hold on")).toBe(true);
  expect(isStopCommand("never mind")).toBe(true);
  expect(isStopCommand("nevermind")).toBe(true);
  expect(isStopCommand("stop talking")).toBe(true);
});

test("isStopCommand rejects unrelated text", () => {
  expect(isStopCommand("what time is it")).toBe(false);
  expect(isStopCommand("stop the deploy")).toBe(false); // not just "stop"
  expect(isStopCommand("")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/listener-stop-interrupt.test.ts`
Expected: FAIL — `isStopCommand` not exported.

- [ ] **Step 3: Add the helper and wire into barge-in**

In `src/listener/conversational.ts`, near the top (after the class or as an exported function):

```ts
const STOP_COMMANDS = new Set([
  "stop",
  "stop.",
  "wait",
  "wait.",
  "cancel",
  "cancel.",
  "hold on",
  "hold on.",
  "never mind",
  "nevermind",
  "stop talking",
  "shut up",
  "quiet",
  "be quiet",
]);

export function isStopCommand(text: string): boolean {
  const norm = text.toLowerCase().trim();
  return STOP_COMMANDS.has(norm);
}
```

Then in the barge-in handler (within `listenLoop`), after transcribing the barge-in utterance:

```ts
const bargeTranscript = await this.sttProvider.transcribe(winner.audio);
try { unlinkSync(winner.audio); } catch {}

if (isStopCommand(bargeTranscript)) {
  log("info", `Stop command "${bargeTranscript}" — interrupting TTS only, no new command`);
  // bargeInCallback already fired (TTS killed); skip the callback path
  continue;
}

if (bargeTranscript && this.active) {
  const bargeResult = this.callback!(bargeTranscript);
  // ...existing logic...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/listener-stop-interrupt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/listener/conversational.ts tests/listener-stop-interrupt.test.ts
git commit -m "feat(listener): mid-reply stop interrupts TTS without firing new command"
```

---

## Task 5: Dictation mode — state machine and listener

**Files:**
- Create: `src/listener/dictation.ts`
- Test: `tests/listener-dictation.test.ts`

Dictation mode is a separate listener variant: hold a hotkey down → start recording → release → transcribe → paste the text into whatever app is currently focused.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { DictationListener } from "../src/listener/dictation";

test("DictationListener state machine: idle → recording → transcribing → idle", async () => {
  const fakeSTT = { transcribe: async () => "hello world" } as any;
  const calls: string[] = [];
  const fakeRecorder = {
    record: () => {
      calls.push("record-start");
      return { exited: Promise.resolve(0), kill: () => calls.push("record-killed") } as any;
    },
  } as any;
  const fakePaste = mock(async (text: string) => { calls.push(`paste:${text}`); });

  const listener = new DictationListener(fakeSTT, fakeRecorder, fakePaste);
  await listener.start();
  expect(listener.getState()).toBe("idle");

  listener.onHotkeyDown();
  expect(listener.getState()).toBe("recording");
  expect(calls).toContain("record-start");

  await listener.onHotkeyUp();
  expect(calls).toContain("record-killed");
  expect(calls).toContain("paste:hello world");
  expect(listener.getState()).toBe("idle");
});

test("DictationListener ignores hotkey-up without prior down", async () => {
  const fakeSTT = { transcribe: async () => "" } as any;
  const fakeRecorder = { record: () => ({} as any) } as any;
  const fakePaste = mock(async () => {});

  const listener = new DictationListener(fakeSTT, fakeRecorder, fakePaste);
  await listener.onHotkeyUp(); // should be a no-op
  expect(fakePaste).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/listener-dictation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/listener/dictation.ts
import type { Listener } from "../types";
import type { STTProvider } from "../backends/stt/provider";
import type { AudioRecorder } from "../platform/audio";
import { log } from "../logger";
import { join } from "path";
import { unlinkSync, mkdirSync } from "fs";

type DictationState = "idle" | "recording" | "transcribing";

export type PasteFn = (text: string) => Promise<void>;

export class DictationListener implements Listener {
  private state: DictationState = "idle";
  private currentRecording: ReturnType<typeof Bun.spawn> | null = null;
  private currentAudioFile: string | null = null;
  private sttProvider: STTProvider;
  private recorder: AudioRecorder;
  private paste: PasteFn;
  private audioDir: string;

  constructor(sttProvider: STTProvider, recorder: AudioRecorder, paste: PasteFn) {
    this.sttProvider = sttProvider;
    this.recorder = recorder;
    this.paste = paste;
    const home = process.env.HOME || "~";
    this.audioDir = join(home, ".cicero", "tmp");
  }

  async start(): Promise<void> {
    mkdirSync(this.audioDir, { recursive: true });
    log("ok", "Dictation listener ready (hold dictation hotkey to record)");
  }

  async stop(): Promise<void> {
    if (this.currentRecording) {
      try { this.currentRecording.kill(); } catch {}
      this.currentRecording = null;
    }
  }

  onCommand(): void {
    // Dictation doesn't fire a command callback — it pastes directly.
  }

  getState(): DictationState {
    return this.state;
  }

  onHotkeyDown(): void {
    if (this.state !== "idle") return;
    this.state = "recording";
    this.currentAudioFile = join(this.audioDir, `dictation-${Date.now()}.wav`);
    this.currentRecording = this.recorder.record(this.currentAudioFile, {
      sampleRate: 16000,
      maxDuration: 60, // 1 min cap for dictation
    });
    log("info", "Dictation: recording...");
  }

  async onHotkeyUp(): Promise<void> {
    if (this.state !== "recording" || !this.currentRecording || !this.currentAudioFile) return;

    try { this.currentRecording.kill(); } catch {}
    const audioFile = this.currentAudioFile;
    this.currentRecording = null;
    this.currentAudioFile = null;

    this.state = "transcribing";
    log("info", "Dictation: transcribing...");

    try {
      const text = await this.sttProvider.transcribe(audioFile);
      try { unlinkSync(audioFile); } catch {}

      if (text && text.trim().length > 0) {
        await this.paste(text.trim());
        log("ok", `Dictation: pasted "${text.substring(0, 60)}..."`);
      }
    } catch (err) {
      log("warn", `Dictation transcribe failed: ${(err as Error).message}`);
    } finally {
      this.state = "idle";
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/listener-dictation.test.ts`
Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
git add src/listener/dictation.ts tests/listener-dictation.test.ts
git commit -m "feat(listener): add DictationListener (hold-hotkey-to-paste)"
```

---

## Task 6: Platform paste functions for dictation

**Files:**
- Modify: `src/platform/audio.ts` (no — create separate paste module)
- Create: `src/platform/paste.ts`
- Test: `tests/platform-paste.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { createPasteFn } from "../src/platform/paste";

test("createPasteFn returns a function for each platform", () => {
  const fn = createPasteFn();
  expect(typeof fn).toBe("function");
});

test("paste writes to clipboard and emits paste keystroke", async () => {
  // Hard to test the actual paste without mocking Bun.spawn; assert no throw on empty string.
  const fn = createPasteFn();
  await expect(fn("")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/platform-paste.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/platform/paste.ts
import { platform } from "os";
import { log } from "../logger";

export type PasteFn = (text: string) => Promise<void>;

export function createPasteFn(): PasteFn {
  switch (platform()) {
    case "darwin": return pasteMacOS;
    case "linux": return pasteLinux;
    case "win32": return pasteWindows;
    default:
      log("warn", `paste: unsupported platform ${platform()}, falling back to clipboard-only`);
      return clipboardOnly;
  }
}

async function pasteMacOS(text: string): Promise<void> {
  if (!text) return;
  // 1) Put text on clipboard via pbcopy
  const pb = Bun.spawn(["pbcopy"], { stdin: "pipe" });
  pb.stdin.write(text);
  pb.stdin.end();
  await pb.exited;
  // 2) Emit Cmd+V via osascript
  Bun.spawn([
    "osascript",
    "-e",
    'tell application "System Events" to keystroke "v" using command down',
  ]);
}

async function pasteLinux(text: string): Promise<void> {
  if (!text) return;
  // Try xdotool first (X11). For Wayland users, configure wl-copy + ydotool externally.
  const xc = Bun.spawn(["xclip", "-selection", "clipboard"], { stdin: "pipe" });
  xc.stdin.write(text);
  xc.stdin.end();
  await xc.exited;
  Bun.spawn(["xdotool", "key", "ctrl+v"]);
}

async function pasteWindows(text: string): Promise<void> {
  if (!text) return;
  // Use PowerShell Set-Clipboard then send Ctrl+V via SendKeys
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"], { stdin: "pipe" });
  ps.stdin.write(text);
  ps.stdin.end();
  await ps.exited;
  Bun.spawn(["powershell", "-NoProfile", "-Command", "[System.Windows.Forms.SendKeys]::SendWait('^v')"]);
}

async function clipboardOnly(text: string): Promise<void> {
  log("info", `[paste fallback] clipboard-only: ${text.substring(0, 60)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/platform-paste.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/paste.ts tests/platform-paste.test.ts
git commit -m "feat(platform): cross-platform paste for dictation mode"
```

---

## Task 7: Hotkey helper extension for dictation

**Files:**
- Modify: `helpers/cicero-hotkey.swift` to support a second hotkey
- Modify: `package.json:build:hotkey` (no change needed unless adding new files)

The existing Swift CGEventTap helper triggers a single hotkey. Extend it to take two args — primary hotkey + dictation hotkey — and emit different signals on stdout (`HOTKEY` vs `DICT_DOWN` / `DICT_UP`).

- [ ] **Step 1: Read the existing helper**

```bash
cat helpers/cicero-hotkey.swift
```

- [ ] **Step 2: Add a "hold mode" flag**

Modify the helper's argv parsing to accept `--dictation-hotkey <keyspec>` in addition to the existing primary hotkey. When the dictation hotkey is pressed, print `DICT_DOWN\n`; on release, print `DICT_UP\n`. The existing primary hotkey continues to print `HOTKEY\n` on press.

(Detailed Swift code omitted — the goal is to read the existing file and add a second-key handler with `CGEventTapCreate` filtering both keyDown and keyUp events for the second hotkey only.)

- [ ] **Step 3: Rebuild**

```bash
bun run build:hotkey
```

Expected: `helpers/cicero-hotkey` binary updated.

- [ ] **Step 4: Smoke test**

```bash
./helpers/cicero-hotkey --hotkey 'ctrl+shift+space' --dictation-hotkey 'ctrl+shift+d'
```

Press the dictation hotkey briefly — should print `DICT_DOWN` then `DICT_UP` on release.

- [ ] **Step 5: Commit**

```bash
git add helpers/cicero-hotkey.swift
git commit -m "feat(hotkey): add second hotkey for dictation hold-to-record"
```

---

## Task 8: Wire dictation into the daemon

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/listener/index.ts`
- Modify: `src/types.ts` (add `dictation_hotkey` to config)

- [ ] **Step 1: Add config field**

In `src/types.ts`, extend `CiceroConfig`:

```ts
dictation_hotkey?: string;       // hold-to-paste hotkey (default "ctrl+shift+d")
dictation_enabled?: boolean;     // default false
```

In `src/config.ts` DEFAULT_CONFIG:

```ts
dictation_hotkey: "ctrl+shift+d",
dictation_enabled: false,
```

In `RuntimeConfig`:

```ts
get dictationHotkey(): string { return this.config.dictation_hotkey ?? "ctrl+shift+d"; }
get dictationEnabled(): boolean { return this.config.dictation_enabled ?? false; }
```

- [ ] **Step 2: Add factory function**

In `src/listener/index.ts`:

```ts
import { DictationListener } from "./dictation";
import { createPasteFn } from "../platform/paste";

export function createDictationListener(
  sttProvider: STTProvider,
  recorder: AudioRecorder,
): DictationListener {
  return new DictationListener(sttProvider, recorder, createPasteFn());
}
```

- [ ] **Step 3: Wire into daemon**

In `src/daemon.ts`, where the hotkey helper is spawned, parse the new `DICT_DOWN` / `DICT_UP` lines and call `dictationListener.onHotkeyDown()` / `onHotkeyUp()`. Only do so when `config.dictationEnabled` is true.

(Exact line numbers depend on current daemon implementation; locate the hotkey stdout parser and add a second case.)

- [ ] **Step 4: Manual smoke test**

```bash
# Enable in ~/.cicero/config.yaml:
# dictation_enabled: true
# dictation_hotkey: ctrl+shift+d
bun run start
```

Hold ctrl+shift+d, say something, release. Expected: text pastes into the currently focused app.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/listener/index.ts src/daemon.ts
git commit -m "feat(dictation): enable hold-hotkey dictation mode end-to-end"
```

---

## Task 9: Silero VAD — replace sox silence threshold with proper VAD

**Files:**
- Create: `src/listener/silero-vad.ts`
- Create: `assets/silero_vad.onnx` (download in setup step)
- Modify: `src/listener/conversational.ts` (replace sox `silence` trailing-pad check with VAD-driven endpoint detection)
- Modify: `src/types.ts` (add `VADConfig`)
- Modify: `src/config.ts` (default `vad.enabled: true`, `vad.threshold: 0.5`)
- Modify: `package.json` (add `onnxruntime-node`)
- Create: `tests/listener-silero-vad.test.ts`

Reference for model choice and rationale: [`../model-recommendations-may-2026.md`](../model-recommendations-may-2026.md#vad-voice-activity-detection).

- [ ] **Step 1: Install ONNX runtime and download Silero model**

```bash
bun add onnxruntime-node
curl -L -o assets/silero_vad.onnx https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
```

- [ ] **Step 2: Write tests first**

```typescript
// tests/listener-silero-vad.test.ts
import { test, expect, describe } from "bun:test";
import { SileroVAD } from "../src/listener/silero-vad";

describe("SileroVAD", () => {
  test("isSpeech returns false for silence", async () => {
    const vad = await SileroVAD.load();
    const silence = new Float32Array(512); // 32ms @ 16kHz, all zeros
    expect(await vad.isSpeech(silence)).toBe(false);
  });

  test("isSpeech respects threshold", async () => {
    const vad = await SileroVAD.load({ threshold: 0.9 });
    expect(vad.threshold).toBe(0.9);
  });
});
```

- [ ] **Step 3: Implement `SileroVAD`**

```typescript
// src/listener/silero-vad.ts
import { InferenceSession, Tensor } from "onnxruntime-node";
import { join } from "path";

const MODEL_PATH = join(import.meta.dir, "..", "..", "assets", "silero_vad.onnx");
const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz

export interface SileroVADOpts {
  threshold?: number;
}

export class SileroVAD {
  readonly threshold: number;
  private session: InferenceSession;
  private state: Float32Array;

  private constructor(session: InferenceSession, opts: SileroVADOpts) {
    this.session = session;
    this.threshold = opts.threshold ?? 0.5;
    this.state = new Float32Array(2 * 1 * 128); // model's recurrent state
  }

  static async load(opts: SileroVADOpts = {}): Promise<SileroVAD> {
    const session = await InferenceSession.create(MODEL_PATH);
    return new SileroVAD(session, opts);
  }

  async isSpeech(samples: Float32Array): Promise<boolean> {
    if (samples.length !== WINDOW_SAMPLES) {
      throw new Error(`Silero VAD expects ${WINDOW_SAMPLES} samples (32ms @ 16kHz)`);
    }
    const inputs = {
      input: new Tensor("float32", samples, [1, WINDOW_SAMPLES]),
      state: new Tensor("float32", this.state, [2, 1, 128]),
      sr: new Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]),
    };
    const output = await this.session.run(inputs);
    this.state = output.stateN.data as Float32Array;
    const prob = (output.output.data as Float32Array)[0];
    return prob > this.threshold;
  }

  reset(): void {
    this.state = new Float32Array(2 * 1 * 128);
  }
}
```

- [ ] **Step 4: Integrate into `ConversationalListener`**

Replace the sox `silence 1 0.5 1%` trailing-pad with a Bun-side loop that reads sox's stdout as raw PCM 16-bit @ 16 kHz, converts each 512-sample frame to Float32, calls `vad.isSpeech()`, and stops the recording when N consecutive non-speech frames are seen (default N = 24 → ~768 ms of silence).

This is the surgical change: keep the `Bun.spawn(['sox', ...])` recorder but pipe its stdout into the VAD loop instead of relying on sox's built-in silence detection.

- [ ] **Step 5: Run tests**

Run: `bun test tests/listener-silero-vad.test.ts`
Expected: PASS

- [ ] **Step 6: Manual smoke test**

```bash
bun run src/index.ts start
# Speak softly — should still capture the full utterance
# Stay silent — recording should end ~750ms after you stop speaking
# Speak in a noisy room — VAD shouldn't trigger on background noise
```

- [ ] **Step 7: Commit**

```bash
git add src/listener/silero-vad.ts src/listener/conversational.ts src/types.ts src/config.ts assets/silero_vad.onnx tests/listener-silero-vad.test.ts package.json bun.lock
git commit -m "feat(listener): replace sox silence threshold with Silero VAD endpoint detection"
```

---

## Future-track: Moonshine v2 STT

Not in scope for this plan, but worth flagging here since it affects the same listener pipeline: **Moonshine v2** (Feb 2026, 250M params) beats Whisper Large v3 on WER and is ~100× faster on Mac (107 ms vs 11,286 ms). The registry already has `case "moonshine":` as a `throw "not yet implemented"` stub.

To add it later: clone `MlxWhisperProvider`, point at the Moonshine model server, register in `src/backends/registry.ts`. Half-day task. See [model recommendations](../model-recommendations-may-2026.md#stt) for the upgrade rationale.

---

## Self-review notes

- Wake-word matching uses transcript scanning (post-STT) — not a dedicated wake-word engine. This means wake words only work when STT is already running (i.e. conversational mode or push-to-talk). For always-on wake-word, layer OpenWakeWord in a later plan.
- `stripWakeWord` preserves the rest of the transcript including punctuation — e.g. `"What's the time Jarvis?"` → `"What's the time?"`. Verify the regex handles trailing punctuation correctly.
- `isStopCommand` is a strict whole-utterance match (`stop`, not `stop the deploy`). This is intentional: ambiguous matches should pass through as normal commands.
- Dictation uses CMD+V / Ctrl+V keystroke emission. On Wayland Linux, this requires `ydotool` setup (documented in Plan separately if user runs Wayland).
- The Swift hotkey helper change is the only platform-specific piece. Windows users would need an AutoHotkey equivalent (out of scope here).
- Silero VAD adds an `onnxruntime-node` runtime dep (~10 MB native binaries) and an 1.8 MB ONNX model committed under `assets/`. Both are MIT-licensed.
