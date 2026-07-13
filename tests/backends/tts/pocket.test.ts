import { test, expect, afterEach } from "bun:test";
import { PocketTtsProvider, pocketTtsServerCommand } from "../../../src/backends/tts/pocket";

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
  const p = new PocketTtsProvider({ backend: "pocket-tts", port: 8082 });
  const audio = await p.generateAudio("hello");

  expect(new Uint8Array(audio)).toEqual(wav);
  expect(calls[0].url).toBe("http://localhost:8082/v1/audio/speech");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.input).toBe("hello");
  expect(sent.voice).toBe("anna"); // default predefined voice
  expect(sent.response_format).toBe("wav");
});

test("uses the configured voice (predefined name or clone-wav path)", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new PocketTtsProvider({ backend: "pocket-tts", voice: "/clips/owner.wav" });
  await p.generateAudio("hi");
  expect(JSON.parse(String(calls[0].init.body)).voice).toBe("/clips/owner.wav");
});

test("targets a remote host when configured", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new PocketTtsProvider({ backend: "pocket-tts", host: "192.168.1.50", port: 9000 });
  await p.generateAudio("hi");
  expect(calls[0].url).toBe("http://192.168.1.50:9000/v1/audio/speech");
});

test("throws with the status + body on a non-OK response", async () => {
  captureFetch("model not loaded", 503, "application/json");
  const p = new PocketTtsProvider({ backend: "pocket-tts" });
  await expect(p.generateAudio("hi")).rejects.toThrow(/503/);
});

test("health is true when /v1/models responds ok, false when unreachable", async () => {
  const calls = captureFetch(JSON.stringify({ object: "list", data: [{ id: "pocket-tts" }] }), 200, "application/json");
  const p = new PocketTtsProvider({ backend: "pocket-tts", port: 8082 });
  expect(await p.health()).toBe(true);
  expect(calls[0].url).toBe("http://localhost:8082/v1/models");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await p.health()).toBe(false);
});

test("warmup performs one throwaway generation", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new PocketTtsProvider({ backend: "pocket-tts" });
  await p.warmup();
  expect(calls.length).toBe(1);
  expect(calls[0].url).toContain("/v1/audio/speech");
});

test("managed server receives the explicit trusted voice-library root", () => {
  expect(pocketTtsServerCommand(
    "python",
    "/app/server.py",
    8082,
    "anna",
    "/trusted/voices",
    55,
  )).toEqual([
    "python",
    "/app/server.py",
    "--host", "127.0.0.1",
    "--port", "8082",
    "--voice", "anna",
    "--voice-root", "/trusted/voices",
    "--inference-timeout", "55",
  ]);
});

test("managed server allows only the configured direct reference outside the library", () => {
  expect(pocketTtsServerCommand(
    "python",
    "/app/server.py",
    8082,
    "/clips/owner.wav",
    "/trusted/voices",
    55,
  )).toEqual([
    "python",
    "/app/server.py",
    "--host", "127.0.0.1",
    "--port", "8082",
    "--voice", "/clips/owner.wav",
    "--voice-root", "/trusted/voices",
    "--inference-timeout", "55",
    "--allow-voice-reference", "/clips/owner.wav",
  ]);
});
