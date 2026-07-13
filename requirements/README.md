# Optional Python stacks

These files constrain Cicero's **direct** Python dependencies. They are kept
separate because the backends intentionally run in isolated virtual
environments and some stacks require different Python or accelerator builds.

They are not universal transitive lockfiles. In particular, PyTorch,
CTranslate2, ONNX Runtime, and MLX select platform-specific wheels for CPU,
CUDA, or Apple Silicon. `uv` still resolves and records the appropriate
transitive graph for the machine at install time; the bounded direct ranges
prevent an unrelated future major release from silently changing Cicero's
runtime contract.

Install a stack with the virtual-environment directory itself as `--python`.
That syntax is portable across POSIX `bin/python` and Windows
`Scripts/python.exe` layouts:

```sh
uv venv .venv-stt --python 3.10
uv pip install --python .venv-stt -r requirements/faster-whisper.txt
```

Use the documented environment for each independent stack:

| Manifest | Environment | Python | Runtime contract |
|---|---|---:|---|
| `faster-whisper.txt` | `.venv-stt` | 3.10 | Linux/Windows CPU or CUDA |
| `mlx.txt` | `.venv` | 3.12 | macOS 14+ on Apple Silicon only |
| `pocket-tts.txt` | `.venv-pocket` | 3.11 | CPU-friendly cloning TTS |
| `kokoro.txt` | `.venv-kokoro` | 3.11 | CPU or CUDA TTS |
| `vibevoice.txt` | `.venv-vibevoice` | 3.11 | VibeVoice cloning API |
| `turn.txt` | `.venv-turn` | 3.11 | Smart-Turn ONNX sidecar |
| `ser.txt` | `.venv-ser` | 3.11 | emotion2vec/FunASR sidecar |
| `telegram-call.txt` | `~/.cicero/tgcalls-venv` | 3.11 | Telegram call bridge |

Pocket-TTS, Kokoro, and VibeVoice stay isolated because their PyTorch graphs
can differ. Smart-Turn also has a small dedicated environment rather than
mutating whichever STT environment happens to be installed. PyPI's
`vibevoice-api==0.0.1` wheel omits the `vibevoice` package its server imports,
so `vibevoice.txt` includes pinned commits from both upstream repositories via
`vibevoice-sources.txt`; `vibevoice-server.txt` lists server imports upstream
does not declare directly. Git is therefore required for that stack.

During the Smart-Turn environment migration, Cicero still accepts an installed
interpreter from `.venv-stt` and then `.venv` when `.venv-turn` is absent. Those
compatibility paths log a deprecation warning; run the `turn.txt` install shown
above so future releases do not depend on the shared-environment fallback.

TorchAudio contains a native extension tied to a matching PyTorch release, so
the SER manifest pins the tested `torch==2.10.0` / `torchaudio==2.10.0` pair;
the package index still selects the platform-appropriate wheels. Python 3.11 is
intentional for Telegram because TgCrypto 1.2.5 provides a CPython 3.11 wheel,
avoiding an undeclared compiler/toolchain requirement. Cicero's current MLX
dependency floors are tested and supported on macOS 14 or newer, Apple Silicon.
