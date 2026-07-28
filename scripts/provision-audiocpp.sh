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
BUILD_DIR="$SUB/build/linux-cuda-release"
BIN="$BUILD_DIR/bin/audiocpp_server"
# Which source commit produced $BIN. Lives inside the (git-ignored) build tree,
# so it is discarded exactly when the build output is.
STAMP="$BUILD_DIR/.built-from-commit"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

echo "==> Syncing vendor/audio.cpp submodule to its pinned commit…"
# `update --init` writes .git/config only for a submodule it is initializing for
# the FIRST time. A checkout that initialized the submodule before its URL
# changed keeps the old URL and tries to fetch the newly pinned commit from a
# repo that does not have it, failing before the build. `submodule sync` is the
# only operation that republishes .gitmodules → .git/config.
#
# Skipped when vendor/audio.cpp is a standalone clone — its own .git DIRECTORY
# rather than a gitlink file. That is the fork-sync development layout, where
# `origin` deliberately tracks upstream and `fork` tracks ours; sync would
# clobber `origin` and break the upstream-sync pipeline that reads it.
if [[ -d "$SUB/.git" ]]; then
  echo "    vendor/audio.cpp is a standalone clone — leaving its remotes untouched."
  # Leaving the remotes alone is not enough: `submodule update` fetches from
  # whatever `origin` is, and on this layout `origin` is UPSTREAM, which does not
  # carry a fork-only pin. Fetch the pinned commit directly BY URL from the one
  # recorded in .gitmodules — a URL fetch creates and rewrites no remote, so the
  # upstream-tracking `origin` the sync pipeline reads is preserved.
  PIN="$(git -C "$ROOT" rev-parse "HEAD:vendor/audio.cpp" 2>/dev/null || true)"
  URL="$(git -C "$ROOT" config -f "$ROOT/.gitmodules" --get submodule.vendor/audio.cpp.url || true)"
  if [[ -n "$PIN" && -n "$URL" ]] && ! git -C "$SUB" cat-file -e "$PIN^{commit}" 2>/dev/null; then
    echo "    pinned $PIN is not present locally — fetching it from $URL"
    # Fetch the exact commit when the server allows it; otherwise take the
    # recorded branch (or all refs) and re-check.
    git -C "$SUB" fetch --quiet "$URL" "$PIN" 2>/dev/null \
      || git -C "$SUB" fetch --quiet "$URL" \
           "$(git -C "$ROOT" config -f "$ROOT/.gitmodules" --get submodule.vendor/audio.cpp.branch || echo HEAD)" 2>/dev/null \
      || git -C "$SUB" fetch --quiet "$URL" || true
    if ! git -C "$SUB" cat-file -e "$PIN^{commit}" 2>/dev/null; then
      echo "!! pinned $PIN is not reachable from $URL — cannot provision this checkout." >&2
      exit 1
    fi
  fi
else
  git -C "$ROOT" submodule sync --recursive vendor/audio.cpp
fi
git -C "$ROOT" submodule update --init --recursive vendor/audio.cpp

# Checking out a new pin does not rebuild anything: /build*/ is git-ignored, so
# the old executable survives the update. Skipping on its mere existence would
# keep running the previously built revision — including past the security and
# stability fixes the new pin was chosen for. Compare commits, not presence.
SRC_COMMIT="$(git -C "$SUB" rev-parse HEAD 2>/dev/null || true)"
BUILT_COMMIT="$(cat "$STAMP" 2>/dev/null || true)"

if [[ -x "$BIN" && "$FORCE" -eq 0 ]]; then
  if [[ -n "$SRC_COMMIT" && "$BUILT_COMMIT" == "$SRC_COMMIT" ]]; then
    echo "==> Already built at $SRC_COMMIT: $BIN"
    echo "    (re-run with --force to rebuild)"
    exit 0
  fi
  # Fail closed: an unknown or mismatched provenance means rebuild. The first
  # run after this check was introduced has no stamp, so it rebuilds once.
  if [[ -z "$SRC_COMMIT" ]]; then
    echo "==> Cannot determine the source commit of $SUB — rebuilding rather than trusting the existing binary."
  elif [[ -z "$BUILT_COMMIT" ]]; then
    echo "==> $BIN exists but records no source commit — rebuilding so it matches $SRC_COMMIT."
  else
    echo "==> $BIN was built from $BUILT_COMMIT, but the checkout is now $SRC_COMMIT — rebuilding."
  fi
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
  # Record provenance only after the binary exists, so a failed build cannot
  # leave a stamp that makes the next run skip.
  if [[ -n "$SRC_COMMIT" ]]; then printf '%s\n' "$SRC_COMMIT" > "$STAMP"; else rm -f "$STAMP"; fi
  echo "==> Built: $BIN"
  echo "    Next: add your model paths to servers/audiocpp_server.local.json"
  echo "    (a task:\"tts\" entry for the TTS seat, a task:\"asr\" entry for STT)."
else
  echo "!! Build finished but $BIN is missing — check the build output above." >&2
  exit 1
fi
