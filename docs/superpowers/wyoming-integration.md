# Wyoming protocol integration

[Wyoming](https://github.com/rhasspy/wyoming) is a small JSON-over-TCP wire protocol for voice-pipeline components (speech-to-text, text-to-speech, wake word). It's the protocol the [Home Assistant voice ecosystem](https://www.home-assistant.io/voice_control/) speaks. Cicero can use any Wyoming server as a drop-in STT or TTS backend.

## Why you'd want this

- **Reuse Home Assistant voice servers.** If you already run `wyoming-faster-whisper` or `wyoming-piper` (e.g. on a Home Assistant box), point Cicero at them instead of running Cicero's own Python model servers.
- **Swap models without writing a wrapper.** Any Wyoming-compatible STT/TTS server works through the same config — no bespoke HTTP shim per model.
- **ESP32 / IoT hardware reuse.** Willow-firmware mics and other Wyoming-compatible devices fit the same ecosystem once multi-device support lands.

## How to use it

Point Cicero's STT and/or TTS at a Wyoming server in `~/.cicero/config.yaml`:

```yaml
# Speech-to-text via wyoming-faster-whisper
stt:
  backend: wyoming
  host: 192.168.1.10        # Home Assistant / Wyoming host
  port: 10300               # default wyoming-faster-whisper port

# Text-to-speech via wyoming-piper
tts:
  backend: wyoming
  host: 192.168.1.10
  port: 10200               # default wyoming-piper port
  voice: en_US-lessac-medium   # optional; server default used if omitted
  responseTimeoutMs: 60000  # optional absolute synthesis deadline
  maxAudioBytes: 67108864   # optional cap for accumulated PCM (64 MiB default)
```

Either backend can be Wyoming independently — you can run Wyoming STT with local TTS, or vice versa. Defaults stay on Cicero's bundled providers unless you set `backend: wyoming`.

## Currently compatible

- [`wyoming-faster-whisper`](https://github.com/rhasspy/wyoming-faster-whisper) (STT)
- [`wyoming-piper`](https://github.com/rhasspy/wyoming-piper) (TTS)
- Other Wyoming STT/TTS servers should work via the same framing; report any that don't.

`wyoming-openwakeword` (wake word) is **not yet wired** — it depends on Cicero's wake-word abstraction, which is still in progress.

## What this is NOT

- **Not smart-home control.** Wyoming is a backend voice protocol, not a way to control Home Assistant devices — that's a separate MCP integration.
- **Not multi-device transport.** Wyoming here is a *backend* (Cicero → server), not a client/server transport for distributing Cicero across rooms.
- **Not Cicero-as-a-Wyoming-service yet.** Exposing Cicero's pipeline so Home Assistant can route voice *through* Cicero is a planned follow-up, gated on demand.
