# Voice cloning

Bring a clean clip of any voice you're authorized to clone and provision it for one supported provider. Voices live in `~/.cicero/voices/<name>/`; `cicero voice use` switches the TTS backend and activates that provider's safe reference or cloud voice ID. A clone is provider-specific—use another `voice add` name if you want the same source provisioned for another engine. Lanes can each carry their own compatible voice (see [the office](office.md)).

Voice provisioning requires `ffmpeg` to create the provider-safe derivative.
Install it with your package manager (`apt`, Homebrew, or Scoop); `cicero doctor`
checks it whenever the configured TTS graph supports voice-library clones.

## Quickstart — local, realtime (audio.cpp pocket-tts)

The fastest path: pocket-tts running on [audio.cpp](https://github.com/0xShug0/audio.cpp) (ggml, CUDA) clones a reference WAV at **36–46 ms per short sentence** warm — kokoro-class latency, with any voice. The prepared voice state is cached after the first utterance.

This provisioner/runtime path is currently **Linux + CUDA only**: both the
script and providers expect
`vendor/audio.cpp/build/linux-cuda-release/bin/audiocpp_server`. Use the
pure-Python Pocket TTS path below on CPU or another platform.

```bash
# one-time: fetch the pinned audio.cpp submodule and build the CUDA server
scripts/provision-audiocpp.sh
# then download the pocket-tts model per audio.cpp's docs into
# vendor/audio.cpp/models/pocket-tts
```

audio.cpp is vendored as a git submodule (`vendor/audio.cpp`, pinned in
`.gitmodules`). A fresh clone gets it with `git submodule update --init
--recursive`; `provision-audiocpp.sh` does that and compiles the CUDA binary.

```json
// servers/audiocpp_server.local.json (machine-local, untracked)
{
  "host": "127.0.0.1", "port": 8092, "device": 0,
  "models": [{ "id": "pocket-tts", "family": "pocket_tts",
               "path": "<abs-path>/vendor/audio.cpp/models/pocket-tts",
               "task": "tts", "mode": "offline",
               "load_options": { "language": "english" } }]
}
```

```yaml
# ~/.cicero/config.yaml
tts:
  backend: audiocpp
  port: 8092
  model: pocket-tts
  refAudio: /home/you/verified-reference-18s.wav   # must be locally readable and <=18s
```

Cicero launches and manages the server; the startup warmup also primes the cloned-voice cache so the first real utterance is already warm. For library provisioning, `cicero voice add butler clip.wav` creates a capped `trimmed-18s.wav` derivative because longer references can abort audio.cpp. Direct `refAudio` paths are inspected and safely derived to 18 seconds before a request. The pure-Python `pocket-tts` backend (see [setup](setup.md)) is the CPU-friendly alternative—same model family, no CUDA build.

## Quickstart — local, CPU (Pocket TTS)

```bash
cicero voice add butler-pocket ~/Recordings/butler-30s.wav --provider pocket-tts
cicero voice use butler-pocket
echo "Welcome back, sir." | cicero speak
```

## Quickstart — local (VibeVoice)

The published `vibevoice-api==0.0.1` wheel omits the core `vibevoice` package
its server imports. Cicero's manifest instead installs pinned source snapshots
of both upstream repositories, plus the server's explicit runtime imports, in
a dedicated Python 3.11 environment (Git is required):

```bash
uv venv .venv-vibevoice --python 3.11
uv pip install --python .venv-vibevoice -r requirements/vibevoice.txt
```

```yaml
# ~/.cicero/config.yaml
tts:
  backend: vibevoice
  port: 8082
  model: vibevoice/VibeVoice-1.5B
```

```bash
cicero voice add butler-vibe ~/Recordings/butler-30s.wav --provider vibevoice
cicero voice use butler-vibe
echo "Welcome back, sir." | cicero speak               # uses the cloned voice
```

Cicero launches the source package's real server entry point,
`python -m vibevoice_api.server`, and downloads the selected model weights on
first launch. `uv` fetches the pinned upstream revisions, so a manual source
checkout is not required and branch movement cannot silently change the install.

## Quickstart — cloud (ElevenLabs)

```bash
export ELEVENLABS_API_KEY=sk_...
cicero voice add butler-cloud ~/Recordings/butler-90s.wav --provider elevenlabs
cicero voice use butler-cloud
```

`add` creates a 16 kHz mono upload derivative, uploads it, and captures the returned `voice_id`. `voice use` then selects the ElevenLabs TTS backend automatically. The API key must remain available to the Cicero process for playback.

## Managing voices

```bash
cicero voice list             # show the library
cicero voice inspect butler   # print the manifest (provider, clip paths, duration)
cicero voice use butler       # switch active voice
cicero voice remove butler    # delete voice + clips
```

Each voice directory holds a `voice.yaml` manifest, a copy of the original clip, and a provider-safe derivative: `trimmed-18s.wav` for audio.cpp, `trimmed-mono.wav` for Pocket TTS, `trimmed-16k-mono.wav` for VibeVoice, or `upload-16k-mono.wav` for ElevenLabs. `--ref-text "<transcript>"` stores reference metadata for engines that support transcript conditioning; the pinned `vibevoice_api.server` currently accepts only the reference WAV.

## Getting a clone to sound right

Zero-shot cloning copies **timbre from the reference clip's opening seconds** — the recipe below is the difference between "recognizable" and "uncanny":

- **Match the provider's clip window.** Use up to 18 seconds for audio.cpp, 20–30 seconds for Pocket TTS or VibeVoice, and about 1–2 minutes of clean continuous speech for ElevenLabs. Cicero caps each derived file before inference or upload.
- **Trim silent or quiet lead-ins.** The speaker embedding is computed from the head of the clip; two seconds of near-silence audibly degrades the whole voice.
- **Normalize loudness** so all your voices sit at the same level, e.g.: `ffmpeg -i in.wav -af loudnorm=I=-17:TP=-1.0:LRA=9 -ar 48000 -ac 1 -sample_fmt s16 out.wav`.
- **Studio-clean sources win.** Stem-separated audio (vocals extracted from music/effects) carries a lowpass haze the clone inherits. Clean VO recordings clone dramatically better.
- **Calm references, calm clones.** Yelling, laughter, or big prosody spikes in the reference become random shouting in the clone. Punctuation acts like a volume knob at synthesis time too — exclamation points get belted, so personas for TTS should use them sparingly.
- Clones carry **timbre, not acting**: highly distinctive voices survive cloning; subtle ones come out generic.

## Alternative TTS backends

| Backend | Cloning | Latency (warm, short sentence) | VRAM |
|---|---|---|---|
| `audiocpp` (pocket-tts) | **Yes (zero-shot, capped WAV)** | **36–46 ms** (measured, RTX 3090) | ~1 GB |
| `pocket-tts` (Python) | Yes (zero-shot) | fast on CPU | — |
| `kokoro` | No (presets) | 50–100 ms | ~1 GB (CUDA) or CPU |
| `vibevoice` | Yes (zero-shot) | ~150 ms | ~2 GB |
| `elevenlabs` | Yes (uploaded voice ID) | network-dependent | cloud |
| `mlx-audio` (default Mac) | Direct reference config only | ~200 ms | unified |

The voice-library providers are `audiocpp`, `pocket-tts`, `vibevoice`, and `elevenlabs`. Kokoro, Wyoming, and MLX Audio remain useful preset/direct-reference engines and fallback seats, but `voice add` does not claim to provision clones for them.

**TTS fallback chain** — add a hot-standby engine and a failed generation can route to it per sentence (both engines start and warm at boot). Cicero first preserves a lane voice override across the handoff. If the fallback rejects that provider-specific voice, it logs the identity downgrade and retries once with the fallback's configured default so the sentence remains audible:

```yaml
tts:          { backend: audiocpp, port: 8092, model: pocket-tts, refAudio: /home/you/.cicero/voices/butler/trimmed-18s.wav }
tts_fallback: { backend: kokoro,   port: 8082, voice: af_heart }
```

## Authorized use only

Cicero is BYO-voice: cloning happens on data you supply. It ships no celebrity, character, or pre-trained third-party voices. Authorized uses include your own voice, voices you have explicit permission to clone, and accessibility / personal-use cases. **Do not use voice cloning to impersonate someone without consent.**
