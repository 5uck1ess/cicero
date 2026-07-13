import { test, expect, afterEach, beforeAll } from "bun:test";
import { AudioCppSTTProvider } from "../../../src/backends/stt/audiocpp";
import { tmpdir } from "os";
import { join } from "path";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// transcribe() reads the file via Bun.file(), so we need a real path on disk.
const wavPath = join(tmpdir(), `cicero-acpp-stt-test-${process.pid}.wav`);
beforeAll(async () => { await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46])); });

function captureFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

test("posts the WAV to the audiocpp seat's /v1/audio/transcriptions with the default ASR model", async () => {
  const calls = captureFetch({ text: "  hello world  " });
  const p = new AudioCppSTTProvider({ backend: "audiocpp" });
  const text = await p.transcribe(wavPath);

  expect(text).toBe("hello world");
  expect(calls[0].url).toBe("http://localhost:8092/v1/audio/transcriptions"); // shares the TTS port
  const fd = calls[0].init.body as FormData;
  expect(fd.get("model")).toBe("qwen3-asr"); // default ASR family
  expect(fd.get("response_format")).toBe("json");
});

test("uses the configured model id and port", async () => {
  const calls = captureFetch({ text: "hi there" });
  const p = new AudioCppSTTProvider({ backend: "audiocpp", model: "whisper", port: 8095 });
  await p.transcribe(wavPath);
  expect(calls[0].url).toBe("http://localhost:8095/v1/audio/transcriptions");
  expect((calls[0].init.body as FormData).get("model")).toBe("whisper");
});

test("targets a remote host when configured", async () => {
  const calls = captureFetch({ text: "remote ok" });
  const p = new AudioCppSTTProvider({ backend: "audiocpp", host: "192.168.1.50", port: 8092 });
  await p.transcribe(wavPath);
  expect(calls[0].url).toBe("http://192.168.1.50:8092/v1/audio/transcriptions");
});

test("returns null on a non-OK response", async () => {
  captureFetch({ error: "boom" }, 500);
  const p = new AudioCppSTTProvider({ backend: "audiocpp" });
  expect(await p.transcribe(wavPath)).toBeNull();
});

test("returns null when the transcript is empty or too short", async () => {
  captureFetch({ text: " " });
  const p = new AudioCppSTTProvider({ backend: "audiocpp" });
  expect(await p.transcribe(wavPath)).toBeNull();
});

test("health probes /v1/models (the shared audiocpp seat), false when unreachable", async () => {
  const calls = captureFetch({ data: [{ id: "qwen3-asr" }] });
  const p = new AudioCppSTTProvider({ backend: "audiocpp", port: 8092 });
  expect(await p.health()).toBe(true);
  expect(calls[0].url).toBe("http://localhost:8092/v1/models");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await p.health()).toBe(false);
});
