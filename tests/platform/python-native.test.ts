import { expect, test } from "bun:test";
import { normalize, resolve } from "node:path";
import { findVenvPython } from "../../src/platform/python";

const nativeVenv = process.env.CICERO_NATIVE_VENV;

test.skipIf(!nativeVenv)("resolves and launches a real native uv virtual environment", async () => {
  const python = findVenvPython(nativeVenv!);
  expect(python).toBeDefined();

  try {
    const proc = Bun.spawn([
      python!,
      "-c",
      "import json,sys; print(json.dumps({'prefix': sys.prefix, 'executable': sys.executable}))",
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`native Python exited ${exitCode}: ${stderr.trim()}`);
    }
    const runtime = JSON.parse(stdout) as { prefix: string; executable: string };
    expect(normalize(runtime.prefix).toLowerCase()).toBe(normalize(resolve(nativeVenv!)).toLowerCase());
    expect(normalize(runtime.executable).toLowerCase()).toBe(normalize(resolve(python!)).toLowerCase());
  } catch (err: unknown) {
    throw new Error(`failed to launch native venv interpreter ${python}`, { cause: err });
  }
});

test.skipIf(!nativeVenv)("executes the pinned VibeVoice server route and launch contract", async () => {
  const python = findVenvPython(nativeVenv!);
  expect(python).toBeDefined();
  // CI installs the two source packages and lightweight HTTP dependencies with
  // no model stack. Stub only heavyweight synthesis while executing the real
  // parser, FastAPI route, Pydantic payload, and response mapping from the
  // pinned source revision, without downloading Torch or model weights.
  const smoke = [
    "from pathlib import Path",
    "from types import SimpleNamespace",
    "import os, sys, types",
    "import vibevoice, vibevoice_api",
    "core = Path(vibevoice.__file__).parent",
    "assert (core / 'modular' / 'modeling_vibevoice_inference.py').is_file()",
    "assert (core / 'processor' / 'vibevoice_processor.py').is_file()",
    "calls = {}",
    "engine = types.ModuleType('vibevoice_api.tts_engine')",
    "def synthesize(*args, **kwargs):",
    "    calls.update(kwargs)",
    "    return b'RIFF-native-contract', 'audio/wav'",
    "engine.synthesize = synthesize",
    "async def synthesize_stream_pcm(*args, **kwargs):",
    "    if False:",
    "        yield None",
    "engine.synthesize_stream_pcm = synthesize_stream_pcm",
    "sys.modules['vibevoice_api.tts_engine'] = engine",
    "import vibevoice_api.server as server",
    "assert server.API_PREFIX == '/v1'",
    "assert server.health().status_code == 200",
    "payload = server.SpeechRequest(input='Native contract', model='vibevoice/test', voice='default', voice_path='/tmp/reference.wav', response_format='wav')",
    "response = server.audio_speech(payload, SimpleNamespace(url=SimpleNamespace(path='/v1/audio/speech')))",
    "assert response.status_code == 200",
    "assert calls['text'] == 'Native contract'",
    "assert calls['model_path'] == 'vibevoice/test'",
    "assert calls['voice_path'] == '/tmp/reference.wav'",
    "assert calls['response_format'] == 'wav'",
    "import uvicorn",
    "launched = {}",
    "def run(app, **kwargs):",
    "    launched.update({'app': app, **kwargs})",
    "uvicorn.run = run",
    "os.environ.pop('VIBEVOICE_MODEL', None)",
    "server.main(['--host', '127.0.0.1', '--port', '18182', '--model_path', 'vibevoice/native-contract'])",
    "assert launched['app'] is server.app",
    "assert launched['host'] == '127.0.0.1'",
    "assert launched['port'] == 18182",
    "assert os.environ['VIBEVOICE_MODEL'] == 'vibevoice/native-contract'",
  ].join("\n");

  try {
    const proc = Bun.spawn([python!, "-c", smoke], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`VibeVoice source smoke exited ${exitCode}: ${stderr || stdout}`);
    }
  } catch (err: unknown) {
    throw new Error(`VibeVoice source contract is not importable from ${python}`, { cause: err });
  }
}, 30_000);
