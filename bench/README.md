# Conversation loop bench

Start a configured Cicero daemon with web voice enabled, then run:

```sh
CICERO_WEB_VOICE_TOKEN=your-token bun run bench/conversation-bench.ts --wav /path/to/spoken-utterance.wav --host 127.0.0.1 --port 8090 --turns 20
```

`--token` also works. The clip must be a real PCM WAV utterance within the web voice limits. This is an opt-in live-provider bench, never part of `bun test`. It connects to the running daemon with protocol v2 and `record=0` so synthetic turns do not enter conversation history. It sends client metric frames and acknowledges clips. Its local table reports **first clip receipt**, which may be filler; the server's private latency log resolves reply and filler from sequence IDs and contains the full table via `cicero latency`. The browser uses actual `playing` events in real use. `--timeout-ms` sets the bounded connection and per-turn deadline (default 60 seconds).
