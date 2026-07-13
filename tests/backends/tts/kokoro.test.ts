import { test, expect, afterEach } from "bun:test";
import { KokoroProvider } from "../../../src/backends/tts/kokoro";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function captureFetch(body: BodyInit, status = 200, contentType = "audio/wav") {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof fetch;
  return calls;
}

test("posts text + default voice to /v1/audio/speech and returns the audio bytes", async () => {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  const calls = captureFetch(wav);
  const p = new KokoroProvider({ backend: "kokoro", port: 8082 });
  const audio = await p.generateAudio("hello");

  expect(new Uint8Array(audio)).toEqual(wav);
  expect(calls[0].url).toBe("http://localhost:8082/v1/audio/speech");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.input).toBe("hello");
  expect(sent.voice).toBe("am_echo"); // default preset voice (Cicero persona)
  expect(sent.response_format).toBe("wav");
});

test("uses the configured voice id", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new KokoroProvider({ backend: "kokoro", voice: "am_onyx" });
  await p.generateAudio("hi");
  expect(JSON.parse(String(calls[0].init.body)).voice).toBe("am_onyx");
});

test("uses an explicit lane voice instead of the configured preset", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new KokoroProvider({ backend: "kokoro", voice: "am_onyx" });
  await p.generateAudio("hi", "af_heart");
  expect(JSON.parse(String(calls[0].init.body)).voice).toBe("af_heart");
});

test("targets a remote host when configured", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new KokoroProvider({ backend: "kokoro", host: "192.168.1.50", port: 9000 });
  await p.generateAudio("hi");
  expect(calls[0].url).toBe("http://192.168.1.50:9000/v1/audio/speech");
});

test("throws with the status + body on a non-OK response", async () => {
  captureFetch("model not loaded", 503, "application/json");
  const p = new KokoroProvider({ backend: "kokoro" });
  await expect(p.generateAudio("hi")).rejects.toThrow(/503/);
});

test("health is true when /v1/models responds ok, false when unreachable", async () => {
  const calls = captureFetch(JSON.stringify({ object: "list", data: [{ id: "kokoro" }] }), 200, "application/json");
  const p = new KokoroProvider({ backend: "kokoro", port: 8082 });
  expect(await p.health()).toBe(true);
  expect(calls[0].url).toBe("http://localhost:8082/v1/models");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await p.health()).toBe(false);
});

test("warmup performs one throwaway generation", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new KokoroProvider({ backend: "kokoro" });
  await p.warmup();
  expect(calls.length).toBe(1);
  expect(calls[0].url).toContain("/v1/audio/speech");
});
