import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import {
  SMART_TURN_MAX_JSON_BYTES,
  SMART_TURN_MAX_JSON_FLOAT32_BYTES,
  SMART_TURN_MAX_MODEL_CHARS,
  SMART_TURN_MAX_SAMPLE_RATE,
  SMART_TURN_MIGRATION_COMMAND,
  SMART_TURN_WINDOW_SECONDS,
  SmartTurnProvider,
  resolveSmartTurnRuntime,
  smartTurnServerCommand,
} from "../../../src/backends/turn/smart-turn";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function nativeVenvPython(root: string, venv: string): string {
  return process.platform === "win32"
    ? join(root, venv, "Scripts", "python.exe")
    : join(root, venv, "bin", "python");
}

test("maps prediction=1 to a complete TurnPrediction with probability", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ prediction: 1, probability: 0.92 }), { status: 200 })) as typeof fetch;
  const provider = new SmartTurnProvider({ port: 9999 });
  const pred = await provider.predict(new Float32Array([0, 0.1, -0.1]), 16000);
  expect(pred.complete).toBe(true);
  expect(pred.probability).toBeCloseTo(0.92);
});

test("honors an explicit is_complete:false field", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ is_complete: false, probability: 0.3 }), { status: 200 })) as typeof fetch;
  const provider = new SmartTurnProvider();
  const pred = await provider.predict(new Float32Array([0]), 16000);
  expect(pred.complete).toBe(false);
  expect(pred.probability).toBeCloseTo(0.3);
});

test("falls back to incomplete on a server error (silence fallback governs)", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const provider = new SmartTurnProvider();
  const pred = await provider.predict(new Float32Array([0]), 16000);
  expect(pred).toEqual({ complete: false, probability: 0 });
});

test("falls back to incomplete when the endpoint is unreachable", async () => {
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const provider = new SmartTurnProvider();
  const pred = await provider.predict(new Float32Array([0]), 16000);
  expect(pred.complete).toBe(false);
});

test("uploads only the model's final eight-second analysis window", async () => {
  let requestAudio: number[] = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { audio?: number[] };
    requestAudio = body.audio ?? [];
    return Promise.resolve(new Response(JSON.stringify({ prediction: 0, probability: 0.1 })));
  }) as typeof fetch;
  const samples = new Float32Array(10 * 16_000);
  samples.fill(0.25, 2 * 16_000);

  await new SmartTurnProvider().predict(samples, 16_000);

  expect(requestAudio).toHaveLength(8 * 16_000);
  expect(requestAudio[0]).toBeCloseTo(0.25);
});

test("canonical 8s/96k Float32 JSON stays inside the shared exact wire ceiling", () => {
  let requestBytes = 0;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    requestBytes = new TextEncoder().encode(String(init?.body)).byteLength;
    return Promise.resolve(new Response(JSON.stringify({ prediction: 0, probability: 0.1 })));
  }) as typeof fetch;

  // This normal float32 value has a long scientific representation and made
  // the old 16 MiB sidecar admission limit reject an otherwise valid window.
  const samples = new Float32Array(SMART_TURN_MAX_SAMPLE_RATE * SMART_TURN_WINDOW_SECONDS);
  samples.fill(Math.fround(-1.1754943508222875e-38));
  return new SmartTurnProvider().predict(samples, SMART_TURN_MAX_SAMPLE_RATE)
    .then((prediction) => {
      expect(prediction).toEqual({ complete: false, probability: 0.1 });
      expect(requestBytes).toBeGreaterThan(16 * 1024 * 1024);
      expect(requestBytes).toBeLessThanOrEqual(SMART_TURN_MAX_JSON_BYTES);
      expect(JSON.stringify(Math.fround(-0.0000010000327392845065)).length)
        .toBe(SMART_TURN_MAX_JSON_FLOAT32_BYTES);
    })
    .catch((err: unknown) => { throw err; });
});

test("rejects invalid sample contracts before allocating or uploading JSON", () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ prediction: 1, probability: 1 })));
  }) as typeof fetch;
  const provider = new SmartTurnProvider();

  return Promise.all([
    provider.predict(new Float32Array([0]), 0),
    provider.predict(new Float32Array([Number.NaN]), 16_000),
    provider.predict(new Float32Array(), 16_000),
  ]).then((predictions) => {
    expect(predictions).toEqual([
      { complete: false, probability: 0 },
      { complete: false, probability: 0 },
      { complete: false, probability: 0 },
    ]);
    expect(calls).toBe(0);
  }).catch((err: unknown) => { throw err; });
});

test("bounds the model id included beside the maximum audio window", () => {
  expect(() => new SmartTurnProvider({ model: "m".repeat(SMART_TURN_MAX_MODEL_CHARS + 1) }))
    .toThrow(/model id exceeds/);
});

test("launch command uses the dedicated Smart-Turn virtual environment", () => {
  const root = join(process.cwd(), "portable-project");
  const command = smartTurnServerCommand(root, 8087, "pipecat-ai/smart-turn-v3");

  expect(command[0]).toContain(join(root, ".venv-turn"));
  expect(command).toEqual([
    command[0]!,
    join(root, "servers", "turn_server.py"),
    "--port",
    "8087",
    "--host",
    "127.0.0.1",
    "--model",
    "pipecat-ai/smart-turn-v3",
    "--inference-timeout",
    "9",
  ]);
});

test("prefers the dedicated environment over both migration fallbacks", () => {
  const root = join(process.cwd(), "portable-project");
  const present = new Set([
    nativeVenvPython(root, ".venv-turn"),
    nativeVenvPython(root, ".venv-stt"),
    nativeVenvPython(root, ".venv"),
  ]);
  const runtime = resolveSmartTurnRuntime(root, {
    exists: (path) => present.has(path),
  });

  expect(runtime).toEqual({
    python: nativeVenvPython(root, ".venv-turn"),
    venv: ".venv-turn",
    found: true,
    legacy: false,
  });
});

test("keeps .venv-stt then .venv as ordered deprecated migration fallbacks", () => {
  const root = join(process.cwd(), "portable-project");
  const legacySttPython = nativeVenvPython(root, ".venv-stt");
  const sharedPython = nativeVenvPython(root, ".venv");
  const options = {
    exists: (path: string) => path === legacySttPython || path === sharedPython,
  };
  const runtime = resolveSmartTurnRuntime(root, options);
  const command = smartTurnServerCommand(root, 8087, "smart-turn", options);

  expect(runtime).toEqual({
    python: legacySttPython,
    venv: ".venv-stt",
    found: true,
    legacy: true,
  });
  expect(command[0]).toBe(legacySttPython);
  expect(SMART_TURN_MIGRATION_COMMAND).toBe(
    "uv venv .venv-turn --python 3.11 && uv pip install --python .venv-turn -r requirements/turn.txt",
  );
});

test("points at the dedicated environment when no compatible interpreter exists", () => {
  const root = join(process.cwd(), "portable-project");
  const runtime = resolveSmartTurnRuntime(root, {
    exists: () => false,
  });

  expect(runtime).toEqual({
    python: nativeVenvPython(root, ".venv-turn"),
    venv: ".venv-turn",
    found: false,
    legacy: false,
  });
});
