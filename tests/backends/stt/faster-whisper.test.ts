import { test, expect, afterEach, beforeAll } from "bun:test";
import { FasterWhisperProvider } from "../../../src/backends/stt/faster-whisper";
import { tmpdir } from "os";
import { join } from "path";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// transcribe() reads the file via Bun.file(), so we need a real path on disk.
const wavPath = join(tmpdir(), `cicero-fw-test-${process.pid}.wav`);
beforeAll(async () => { await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46])); });

function captureFetch(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

test("posts the WAV + default model to /v1/audio/transcriptions and returns trimmed text", async () => {
  const calls = captureFetch({ text: "  hello world  " });
  const p = new FasterWhisperProvider({ backend: "faster-whisper", port: 8083 });
  const text = await p.transcribe(wavPath);

  expect(text).toBe("hello world");
  expect(calls[0].url).toBe("http://localhost:8083/v1/audio/transcriptions");
  const fd = calls[0].init.body as FormData;
  expect(fd.get("model")).toBe("large-v3-turbo"); // default = CT2 turbo shorthand
});

test("uses the configured model id", async () => {
  const calls = captureFetch({ text: "hi there" });
  const p = new FasterWhisperProvider({ backend: "faster-whisper", model: "large-v3" });
  await p.transcribe(wavPath);
  expect((calls[0].init.body as FormData).get("model")).toBe("large-v3");
});

test("targets a remote host when configured", async () => {
  const calls = captureFetch({ text: "remote ok" });
  const p = new FasterWhisperProvider({ backend: "faster-whisper", host: "192.168.1.50", port: 8083 });
  await p.transcribe(wavPath);
  expect(calls[0].url).toBe("http://192.168.1.50:8083/v1/audio/transcriptions");
});

test("returns null on a non-OK response", async () => {
  captureFetch({ error: "boom" }, 500);
  const p = new FasterWhisperProvider({ backend: "faster-whisper" });
  expect(await p.transcribe(wavPath)).toBeNull();
});

test("returns null when the transcript is empty or too short", async () => {
  captureFetch({ text: " " });
  const p = new FasterWhisperProvider({ backend: "faster-whisper" });
  expect(await p.transcribe(wavPath)).toBeNull();
});

test("health is true when /health responds ok, false when unreachable", async () => {
  const calls = captureFetch({ status: "ok" });
  const p = new FasterWhisperProvider({ backend: "faster-whisper", port: 8083 });
  expect(await p.health()).toBe(true);
  expect(calls[0].url).toBe("http://localhost:8083/health");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await p.health()).toBe(false);
});
