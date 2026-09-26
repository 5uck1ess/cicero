# Laya switchboard sidecar

Opt-in local intent routing with a fine-tuned Laya checkpoint. This replaces the
switchboard's summarizer prompt classifier; its answers can trigger routing actions.
The daemon still applies the same `parseIntent` roster/alias, front-desk and off-roster
call-me rules, confidence threshold, cancellation and absolute intent deadline.
Exact commands retain their existing fast path. Without `switchboard.intent_url`,
the summarizer prompt path is unchanged.

## Run

```bash
uv run --python 3.11 --with-requirements requirements/laya-switchboard.txt \
    python sidecars/laya-switchboard/serve.py --ckpt /path/to/switchboard-checkpoint
```

Requires `laya==0.3.20` and a switchboard-trained checkpoint. The base Laya model is not
usable zero-shot for this task. For now, bring your own fine-tuned checkpoint. A public checkpoint
trained on synthetic data only, plus the fine-tuning recipe, is planned as a follow-up. Binds
`127.0.0.1:8096` by default; `--host`, `--port`, and `--device cuda|cpu` override it.
Run this process separately from Cicero, then configure:

```yaml
switchboard:
  intent_url: http://127.0.0.1:8096
  intent_timeout_ms: 1500
  intent_min_confidence: 0.7
```

`intent_url` is an HTTP(S) base URL without a query or fragment. Cicero appends
`/v1/switchboard`. Errors or deadlines fall through to an ordinary brain turn;
there is no retry through the summarizer. The sidecar has no authentication:
keep its listener on loopback or behind a private authenticated proxy.

## Protocol and training contract

`POST /v1/switchboard` takes:

```json
{"utterance":"let me speak to Rick","roster":[{"name":"coder","aliases":["Rick","the coder"]}]}
```

The utterance is at most 2,000 characters. The roster has at most 32 lanes, each
with at most 16 aliases; names and aliases have at most 128 characters. Names must
be nonempty and unique; `nobody` is reserved. Invalid requests return 400. Bodies
are capped at 1 MiB, with a five-second absolute body-read deadline. No utterances
or model exception text are logged. Unknown paths return 404; model failures
return a generic 500.

A successful response contains exactly these four fields:

```json
{"intent":"transfer","target":"coder","request_now":true,"confidence":0.95}
```

The six intents are `transfer`, `release`, `rollcall`, `standup`, `callme`, and
`none`. Confidence is the selected intent's probability. The target `nobody`
becomes null; only transfer and callme retain targets. Only callme uses the noul
head (`> 0.5`) for `request_now`; all other actions force it true. None and a
transfer without a target return none/null/false, retaining the model probability
on the wire (Cicero normalizes these to its existing zero-confidence `NONE`).

The questions and whitespace-normalized, 500-character `Operator said: ...`
state in `serve.py` are the exact strings the checkpoint was trained on. Inference calls
`system_one(state, questions, max_len=512, head_max_len=384)` and accepts answer
fields as either dictionary keys or attributes. These training strings must not
be paraphrased.

`GET /health` returns `{"ok":true,"model":"<checkpoint directory name>","device":"cpu|cuda"}`.
It becomes available after model load and warmup.

## Sharing a GPU with llama-swap

```bash
uv run --python 3.11 --with-requirements requirements/laya-switchboard.txt \
    python sidecars/laya-switchboard/serve.py --ckpt /path/to/switchboard-checkpoint \
    --llama-swap http://127.0.0.1:8080/running --cpu-when '^qwen3\.8' --poll 1
```

The model moves to CPU while a matching model is starting or ready, and back to
CUDA otherwise. Failed/unrecognized polls leave it in place; unavailable CUDA or
GPU exhaustion leaves it on CPU. Moves and inference share a lock. CPU inference
may need a longer Cicero deadline. Client cancellation cannot interrupt native
inference already running in the sidecar; inference remains serialized until it
finishes. A stuck native runtime requires restarting this separately supervised
process.

## Verification

```bash
python3 -m unittest discover -s sidecars/laya-switchboard -p 'test_*.py'
```

Tests are model-free and need no Laya installation. They cover protocol bounds,
training strings, dict/attribute decoding, the runtime call contract and device
selection. Real-checkpoint routing accuracy, latency and GPU/CPU moves require a
separate hardware smoke test; these are not proven by the unit tests.
