#!/usr/bin/env bash
# Provision the audio.cpp native runtime for Cicero's audiocpp backends
# (TTS: pocket-tts / STT: qwen3-asr et al. via one shared CUDA server).
#
# Two steps: sync the pinned submodule, then build the CUDA server binary the
# backends launch (vendor/audio.cpp/build/linux-cuda-release/bin/audiocpp_server).
# Idempotent — skips the (slow) compile if the binary is already present.
#
#   scripts/provision-audiocpp.sh          # sync + build if needed
#   scripts/provision-audiocpp.sh --force  # rebuild even if the binary exists
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/vendor/audio.cpp"
BIN="$SUB/build/linux-cuda-release/bin/audiocpp_server"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "==> Syncing vendor/audio.cpp submodule to its pinned commit…"
git -C "$ROOT" submodule update --init --recursive vendor/audio.cpp

if [[ -x "$BIN" && "$FORCE" -eq 0 ]]; then
  echo "==> Already built: $BIN"
  echo "    (re-run with --force to rebuild)"
  exit 0
fi

if [[ ! -f "$SUB/scripts/build_linux.sh" ]]; then
  echo "!! $SUB/scripts/build_linux.sh missing — submodule not checked out? Run: git submodule update --init --recursive" >&2
  exit 1
fi

echo "==> Building audio.cpp (CUDA) — compiles the ggml CUDA kernels, takes several minutes…"
# Build from the submodule root: build_linux.sh runs `cmake -S .` against the
# current directory, so it must be invoked with $SUB as CWD. Also run it via
# bash — git records it as mode 0644 (no exec bit), so a clean submodule
# checkout can't execute it directly.
( cd "$SUB" && bash scripts/build_linux.sh --backend cuda --target audiocpp_cli --target audiocpp_server )

if [[ -x "$BIN" ]]; then
  echo "==> Built: $BIN"
  echo "    Next: add your model paths to servers/audiocpp_server.local.json"
  echo "    (a task:\"tts\" entry for the TTS seat, a task:\"asr\" entry for STT)."
else
  echo "!! Build finished but $BIN is missing — check the build output above." >&2
  exit 1
fi
