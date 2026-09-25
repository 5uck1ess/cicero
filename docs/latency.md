# Conversation latency

The web voice protocol v2 browser sends bounded `client_metric` frames for speech end, playback start by sequence, and barge-in. Browser durations use its own monotonic clock relative to speech end. Playback start comes from the audio element's `playing` event; the server classifies the sequence as filler or reply. A typed web turn has no speech end, so its browser playback metric is absent.

Cicero writes transcript-free records to `~/.cicero/latency/turns.*.jsonl`. The private ring keeps at most four 128 KiB segments with 256 appended records per segment. A later playback metric may append an updated record for the same session and turn; reporting keeps the latest record. Records include input length, bounded server mark offsets, derived durations, and interruption/parking flags. A `false_interrupt` flag is omitted because the web transport has no definitive empty/echo classifier result. Real remote playback and capture behavior require a browser smoke test.

```sh
cicero latency --last 100
cicero latency --last 100 --json
```

The table reports nearest-rank p50/p95 for each available metric, grouped by surface. `speech_end→reply` is the end-to-end headline. `brain first token` begins at brain dispatch, and `TTS first audio` begins at the first reply sentence. Missing values are excluded from that metric's sample count.

For a live daemon synthetic-turn bench, see [bench/README.md](../bench/README.md).
