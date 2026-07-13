import { test, expect, mock, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FasterWhisperProvider } from "../../src/backends/stt/faster-whisper";
import { MlxAudioProvider } from "../../src/backends/tts/mlx-audio";
import { MlxLmProvider } from "../../src/backends/llm/mlx-lm";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("STT faster-whisper transcribes against the configured remote host", async () => {
  let url = "";
  globalThis.fetch = mock(async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ text: "hello world" }));
  }) as unknown as typeof fetch;

  const tmp = join(tmpdir(), "cicero-host-test.wav");
  await Bun.write(tmp, new Uint8Array([1, 2, 3]));
  const stt = new FasterWhisperProvider({ host: "192.168.1.50", port: 8083 });
  const text = await stt.transcribe(tmp);

  expect(url).toContain("http://192.168.1.50:8083/");
  expect(text).toBe("hello world");
});

test("TTS mlx-audio generates against the configured remote host", async () => {
  let url = "";
  globalThis.fetch = mock(async (u: string) => {
    url = u;
    return new Response(new Uint8Array([0, 1, 2, 3]));
  }) as unknown as typeof fetch;

  const tts = new MlxAudioProvider({ host: "gpu.local", port: 8082 });
  const buf = await tts.generateAudio("hi");

  expect(url).toContain("http://gpu.local:8082/v1/audio/speech");
  expect(buf.byteLength).toBe(4);
});

test("LLM mlx-lm completes against the configured remote host", async () => {
  let url = "";
  globalThis.fetch = mock(async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  }) as unknown as typeof fetch;

  const llm = new MlxLmProvider({ host: "10.0.0.5", port: 8081 });
  const out = await llm.chatCompletion([{ role: "user", content: "hi" }]);

  expect(url).toContain("http://10.0.0.5:8081/v1/chat/completions");
  expect(out).toBe("ok");
});
