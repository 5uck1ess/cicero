# Performance and Portability Evaluation

Date: 2026-06-18

> **Point-in-time audit.** The findings below describe the June 18 source
> snapshot; they are not the current backlog. The July
> [evaluation follow-up](evaluation-follow-up-2026-07.md) records the delivered
> reliability, security, portability, and lifecycle work and separates it from
> the platform/hardware validation that still remains.

## Executive summary

Cicero already has the right high-level latency architecture: keyword-first
routing, streamed brain output, sentence-level TTS pipelining, provider warmup,
barge-in, remote backends, and platform-specific audio adapters. The largest
remaining problem is not TypeScript execution speed. It is that installation,
backend selection, timeouts, and model sizes still assume an informed user and
mostly Apple Silicon defaults.

The recommended order is:

1. Add a capability-aware `cicero doctor`/setup path and validated deployment
   profiles.
2. Add request deadlines and per-stage latency telemetry.
3. Establish target-hardware benchmarks before changing model defaults.
4. Remove per-sentence temporary files and player process creation.
5. Make startup concurrent only after measuring peak memory during model loads.

## Changes made during this evaluation

- Removed the LLM health preflight from fallback routing. An unmatched command
  now performs one inference request instead of a health request followed by an
  inference request. Failed inference still falls back to keyword routing.
- Made streamed Linux playback select `paplay` when `aplay` is unavailable,
  matching the behavior of the non-streaming audio adapter.

## Priority findings

### P0: The conversational local-LLM path bypasses provider configuration

Both `ActionExecutor.executeLocalLLM()` and `executeLocalLLMStreaming()` build a
raw OpenAI-style request to `http://localhost:${config.servers.router.port}`.
They ignore `llmBackend.host`, `llmBackend.port`, backend-specific protocols,
authentication, and the provider instance used by the router.

This breaks the documented remote-LLM setup and the built-in CPU/CUDA tiers,
which select Ollama on port 11434. In conversational mode, simple questions take
the streaming branch and fail rather than using the configured Ollama or remote
provider.

Move completion and streaming behind `LLMProvider`. Add a streaming method (or
capability check) to the provider interface, and make unsupported streaming
fall back to `chatCompletion()` rather than to a hardcoded endpoint. Test the
simple-question path with MLX, Ollama, OpenAI-compatible, and remote-host
providers.

### P0: Barge-in leaves a competing recorder running

The listener races the command callback against `detectBargeIn()`. When the
command finishes first, the detection recorder is not cancelled or awaited. It
can continue holding the microphone for up to ten seconds while the next normal
recording begins, overwrite `currentRecording`, and leave its WAV file behind
when its unobserved promise resolves.

Give each recording an explicit cancellation owner. After `Promise.race`, abort
and await the losing operation in a `finally` block before starting another
recording. Add tests for callback-wins, barge-in-wins, deactivate-during-race,
and recorder failure.

### P1: Streaming SSE parsing drops arbitrarily split events

The streaming local-LLM path splits every network chunk on newlines but does not
retain an incomplete SSE line across chunks. TCP/fetch chunks do not preserve
SSE event boundaries, so a JSON event split across chunks is silently discarded
by the empty `catch`. This can omit or garble spoken responses under different
servers and network conditions.

Use an incremental SSE parser with a separate framing buffer. Test a single
event split at every byte boundary, multiple events in one chunk, CRLF input,
and a final event without a trailing blank line.

### P1: Managed model servers can block on unread stderr

Managed processes are spawned with `stderr: "pipe"`, but the pipe is never
drained. A verbose Python/model server can fill the OS pipe buffer and block
before it becomes healthy. If the child exits immediately, startup also keeps
polling health until the full 30-120 second deadline instead of reporting the
exit and stderr.

Continuously drain stderr into a bounded diagnostic buffer and race health
readiness against `proc.exited`. Return immediately on early exit with the last
useful log lines.

### P1: Streaming TTS silently loses the fallback voice

Batch TTS checks health and invokes the system voice when generation fails.
Streaming TTS catches generation errors and substitutes an empty audio buffer,
so the response becomes silent even though a fallback speaker was supplied.

Fall back per sentence, or downgrade the entire turn to buffered system TTS.
Add tests for an unhealthy provider, generation rejection, missing playback
binary, and failure after the first successfully spoken sentence.

### P0: Defaults are platform-specific but presented as general defaults

`DEFAULT_CONFIG` selects MLX for STT, TTS, and routing. That is appropriate only
for Apple Silicon. Linux and Windows need the user to discover and set a
deployment tier before the default daemon can work. Intel Macs also need a
non-MLX path.

Add a setup/doctor command which reports OS, architecture, memory, available
GPU/runtime, audio binaries, Python environment, terminal adapter, and brain
CLI. It should recommend a profile but never silently download large models.
Persist the accepted profile in `config.yaml`.

Profiles should cover at least:

| Profile | STT | TTS | Router | Terminal |
| --- | --- | --- | --- | --- |
| Apple Silicon | MLX Whisper | Pocket-TTS or MLX | MLX-LM | auto |
| NVIDIA CUDA | faster-whisper | Kokoro | Ollama/llama.cpp | auto |
| CPU-only | smaller quantized STT | lightweight CPU TTS/system TTS | sub-1B quantized or remote | auto |
| Remote/hybrid | remote STT/TTS/LLM | remote | remote | auto |

Do not force `tmux` in CPU/CUDA profiles. It is unrelated to compute capability
and weakens Windows and desktop-Linux portability.

### P0: Network operations have no consistent deadlines

Most provider `fetch()` calls have no abort signal. An unreachable remote model,
half-open connection, or wedged local server can stall routing, transcription,
TTS, health checks, and shutdown behavior for an OS-dependent duration.

Create a shared request helper with separate configurable deadlines:

- health: 1 second local, 2 seconds remote
- router: 3-5 seconds, then keyword fallback
- STT/TTS/brain: workload-specific deadline with cancellation propagation

Timeout errors should identify provider, endpoint class, and elapsed time. Avoid
logging API keys or full request bodies.

### P0: There is no end-to-end latency measurement

Executor duration alone cannot show where voice latency is spent. Record these
timestamps for every conversational turn:

- end of speech detected
- transcription complete
- route complete
- first brain/LLM token
- first complete sentence
- first TTS audio byte
- playback start
- response complete

Track p50, p95, and failure rate by deployment profile. Initial acceptance
targets should be measured, not inferred from third-party model benchmarks. A
useful first target is under 1 second from end-of-speech to playback start on
GPU/Apple Silicon and under 2.5 seconds on the supported CPU profile.

### P1: The CPU profile is too heavy

`local-cpu` currently uses faster-whisper large-v3-turbo. That prioritizes
accuracy over broad hardware support and can dominate response time and memory.
Benchmark a smaller/quantized model against a Cicero-specific utterance set that
contains file names, commands, model names, and technical terms. Promote it only
if word error rate remains acceptable.

The existing audio-model validation plan is useful, but the scripts described
there are not present in the repository. Implement the harness before changing
the profile.

### P1: Startup is serialized and can wait several minutes

`ServerManager.start()` starts LLM, TTS, and STT sequentially. Configured server
deadlines can sum to 210 seconds (30 seconds for Ollama, 60 for common TTS/LLM
servers, and 120 for faster-whisper), before the daemon becomes usable.

Start independent providers concurrently on machines with sufficient memory.
On constrained systems, use a limit of one or two simultaneous model loads to
avoid peak-memory failures. Make the dashboard, stdin listener, and keyword
router usable while optional model providers continue becoming ready.

### P1: Streaming playback creates a file and process per sentence

Every streamed sentence is written to a temporary WAV and played by a new
`afplay`, `aplay`/`paplay`, or `ffplay` process. This adds filesystem and process
startup latency and makes gaps between short sentences more likely.

Move playback ownership into a persistent platform adapter that accepts audio
buffers or a PCM stream and exposes a killable handle for barge-in. Preserve the
current one-sentence-ahead TTS generation. Measure before and after using gap
duration and playback-start latency.

### P1: The declared TypeScript build is not clean

`bun x tsc --noEmit` currently reports nine errors in `tab-inject.ts`,
`daemon.ts`, `conversational.ts`, and `wispr-flow.ts`. The errors concern logger
types, optional subprocess streams, and callbacks declared as returning `void`
but treated as promises. Bun can execute the source despite these errors, but a
release build or different Bun/TypeScript version may not.

Fix these before adding a packaged build, and add `typecheck` and `test` scripts
to `package.json` so CI runs the same commands as local development.

The listener callback errors are not merely cosmetic: the interface declares a
`void` callback while the implementation explicitly detects and awaits promises.
Change the contract to `void | Promise<void>` so async command failures and
cancellation behavior are type-checked.

### P2: Installation is repository-layout dependent

Several local providers locate `.venv`, `.venv-pocket`, and Python server files
relative to the source tree. That works for a checkout but not for a standalone
binary or conventional global package installation. Windows virtualenv paths
also differ (`Scripts/python.exe` rather than `bin/python`).

Resolve runtimes through configuration and a platform helper. Validate paths in
`doctor`, and separate user cache/model data from packaged server assets.

**Status:** virtual-environment interpreter discovery now goes through the
shared platform helper and is covered on Windows and POSIX in CI. The remaining
repository-layout concern (locating packaged `servers/` assets independently of
a source checkout) is still a packaging decision, not something the interpreter
resolver should guess.

The generic action executor also launches `sh`, and the compute shell tool uses
`/bin/sh`; neither exists on a standard Windows installation. Built-in local
actions use Unix tools, and the battery action is specifically macOS-only.
Replace built-in system queries with platform APIs/helpers and make configurable
shell execution explicitly platform-aware.

### P2: Full-suite tests are not isolated enough

Focused router/audio tests pass. The full suite binds fixed local ports in some
tests and did not terminate reliably during this evaluation. Use ephemeral port
allocation everywhere, ensure all servers/timers/subprocesses close in
`afterEach`, and split pure unit tests from socket/process integration tests.

## Benchmark matrix

Run the same recorded utterance corpus and response fixtures on:

| System | Minimum coverage |
| --- | --- |
| Apple Silicon, 8-16 GB | MLX and CPU-light profiles |
| Linux x86_64, NVIDIA GPU | CUDA profile |
| Linux x86_64, no GPU | CPU and remote profiles |
| Windows 11, NVIDIA GPU | CUDA, audio, path, and terminal-none paths |
| Windows 11, no GPU | remote/system-TTS degraded mode |

For each system record cold startup, warm startup, peak RSS/VRAM, STT latency,
router latency, time to first audio, complete-turn latency, transcription error
rate, and degraded-mode behavior with each backend intentionally unavailable.

## Stored results — Apple Silicon (M4)

First stored results toward the matrix above (the
[definition of done](#definition-of-done) calls for at least one machine per OS
class). **STT and TTS component latency only** — end-to-end time-to-first-word
through a live brain is not measured here.

- **Machine:** Apple M4 (10-core), 16 GB, macOS 26.5.2, Bun runtime. Measured
  2026-07-13.
- **Method:** Cicero's own `MlxWhisperProvider` / `PocketTtsProvider` driving the
  real managed Python servers (`bench/mac-bench.ts`), 5 runs/clip, warm = median
  of runs 2–5.
- **STT input:** real prior utterances captured to `~/.cicero/tmp` (3.9–21.3 s of
  natural speech), not synthetic fixtures.

| Stage | Backend | Warm latency | Real-time factor | Cold server start |
| --- | --- | ---: | ---: | ---: |
| STT | mlx-whisper (whisper-large-v3-turbo) | ~0.95 s / utterance (0.81–1.0 s on speech) | 0.05–0.21 (≈5–20× realtime) | 7.0 s |
| TTS | pocket-tts (voice `michael`, CPU) | 375 ms / sentence (268–459) | ≈8.9× realtime | 3.0 s |

Notes:

- STT warm latency is roughly flat (~0.85–1.0 s) across 4–21 s clips, so RTF falls
  as clips get longer — cost is dominated by a fixed per-request floor, not audio
  length.
- Two near-silent/noise clips in the sample triggered Whisper's known
  repetition-hallucination (empty output after 6.9 s; a `"food food food …"` loop
  for 24 s) and are excluded as non-speech, not throughput. Feeding silence to the
  model is a failure mode to guard against, not a latency measurement.
- TTS confirms the CPU figures cited elsewhere: ~half a second per sentence
  (README) and ~9× realtime on an M4 (the `PocketTtsProvider` comment).

## Definition of done

- A new user can run one diagnostic command and receive a working recommended
  configuration without reading implementation docs.
- Every provider request has a deadline and cancellation behavior.
- CI type-checks and runs isolated unit tests on macOS, Linux, and Windows.
- The benchmark matrix has stored results for at least one machine per OS class.
- Performance changes are accepted against p50/p95 metrics, not subjective feel.
