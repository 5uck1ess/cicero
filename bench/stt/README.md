# STT bench

Compare transcription backends empirically — the way Pocket-TTS was picked, not by guessing. Reports **WER** (accuracy), **latency** (cold + warm), and **RTF** (real-time factor) per candidate.

## Run

```bash
bun run bench:stt
# or with flags:
bun run bench/stt-bench.ts --clips bench/stt/clips --candidates bench/stt/candidates.json --runs 3
```

## 1. Add clips

Drop test audio in `bench/stt/clips/` as **`name.wav` + `name.txt`** (the `.txt` is the ground-truth transcript). Clips are git-ignored — they're your data.

**Capturing real clips from live use:** start the daemon with `CICERO_STT_TAP=<dir>` and every live utterance is teed into that directory — the exact WAV the STT provider received plus a `.json` sidecar (engine, transcript, timing). Talk to Cicero normally for a day, then replay the captured WAVs through other backends for a same-audio comparison on your real voice, mic, and room — the thing synthetic clips can't measure. Capture is bounded (oversized clips skipped, directory pruned to ~1000 utterances) and off unless the variable is set. The captures contain your actual voice and words — point the tap somewhere private (e.g. `~/.cicero/stt-tap`), never at a committed path.

- Use **real conversational speech** at 16 kHz mono if you can — that's what Cicero feeds STT.
- A handful of 5–15s clips covering your accent, jargon, and a noisy one is plenty to separate the field.
- Good public source: LibriSpeech `test-clean` samples (each comes with a transcript).

## 2. Pick candidates

Copy `candidates.example.json` → `candidates.json` and edit. Two kinds:

- **`provider`** — an integrated Cicero backend (`mlx-whisper`, `faster-whisper`). Its server must already be running (the bench health-checks and skips it if down).
- **`command`** — any CLI model not yet wired into Cicero (Kyutai, parakeet-mlx, Moonshine). It must print **only the transcript** to stdout; `{audio}` is replaced with the WAV path. This is how you compare a candidate *before* writing a full backend for it.

The example file has templates for the June-2026 research picks — install the model, fix the command to match its CLI, and move it into the `candidates` array.

## What it measures — and what it doesn't

- ✅ **WER** vs your references (normalized: case/punctuation-insensitive).
- ✅ **Latency**: cold (first run, includes model load) vs warm (median of the rest).
- ✅ **RTF** = warm transcribe time ÷ audio duration; `< 1` is faster than real-time.
- ❌ **Streaming time-to-final** — this is a *batch* bench (whole-clip transcribe). In the live loop STT streams while you talk, so its marginal latency is small and the LLM TTFT dominates (see `wiki/research/cicero/realtime-stt-selection-jun2026.md`). Use this for accuracy + footprint + batch speed, then confirm the streaming *feel* of your shortlist with a live mic test.

Results print to the console and write to `bench/stt/last-results.md`.
