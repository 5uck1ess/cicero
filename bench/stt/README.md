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

Copy `candidates.example.json` → `candidates.json` and edit. Three kinds:

- **`provider`** — an integrated Cicero backend (`mlx-whisper`, `faster-whisper`). Its server must already be running (the bench health-checks and skips it if down).
- **`command`** — any CLI model not yet wired into Cicero (Kyutai, parakeet-mlx, Moonshine). It must print **only the transcript** to stdout; `{audio}` is replaced with the WAV path. This is how you compare a candidate *before* writing a full backend for it.
- **`stream`** — an audio.cpp model driven over `POST /v1/audio/transcriptions/live`: PCM fed up a chunked request body at real-time pace, SSE deltas timed as they arrive. The only kind that measures streaming time-to-final. Needs a `mode: "streaming"` model and an audio.cpp build with that endpoint (upstream PR #144).

The example file carries templates under `_templates` for the June-2026 research picks and the audio.cpp seats — install the model, fix the command to match its CLI, and move the entry into the `candidates` array. (Only `candidates` is read; anything else in the file is ignored, so templates can sit there indefinitely.)

**Point audio.cpp candidates at an isolated server, not the live seat.** Both `command` and `stream` candidates hold the model lock for the whole run; aimed at the seat Cicero is using, they will stall your voice loop.

## What it measures — and what it doesn't

- ✅ **WER** vs your references (normalized: case/punctuation-insensitive).
- ✅ **Latency**: cold (first run, includes model load) vs warm (median of the rest).
- ✅ **RTF** = warm transcribe time ÷ audio duration; `< 1` is faster than real-time.
- ✅ **Streaming time-to-final** (`stream` candidates only) — time to the first partial, how many partials landed *while the audio was still uploading*, and when the final transcript arrived relative to the end of the audio. Reported in its own table: a real-time feed spends at least the clip's duration by construction, so its wall-clock is not comparable to a batch latency.
- ❌ **Your room and your mic.** Every clip here is a recording, replayed. Streaming timings tell you whether a model emits during capture; they say nothing about how it copes with a noisy room, a far mic, or a false VAD cut. Confirm the shortlist live.

Whether partials arrive during capture is a property of the **model**, not the endpoint. A model that buffers internally reports `n/a` first delta and `0` deltas during audio — that is the real answer, and it means streaming buys you only the emission tail.

**Cost warning:** a real-time `stream` run takes at least the total clip duration per run. 75 s of clips × 3 runs ≈ 4 minutes per candidate before the model does any work. Set `"pace": "fast"` to check a model responds at all — but the resulting timings are not streaming latencies and shouldn't be quoted as any.

Results print to the console and write to `bench/stt/last-results.md`, plus a run-stamped copy under `bench/stt/results/` (both git-ignored). `last-results.md` is **overwritten every run** — keep notes and merged comparisons somewhere else.
