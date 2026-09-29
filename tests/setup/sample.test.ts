import { expect, test } from "bun:test";
import type { TTSProvider } from "../../src/backends/tts/provider";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_SENTENCE, synthesizeSample } from "../../src/setup/sample";
import { startSetupServer } from "../../src/setup/server";

const open = { probePort: async () => true };
const provider = (generate: TTSProvider["generateAudio"]): TTSProvider => ({ name: "fixture", generateAudio: generate, health: async () => true });
const never = () => provider((_text, _voice, options) => new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));

test("a closed port is 'not running' with the install command, and nothing is built or started", async () => {
  let built = 0;
  const result = await synthesizeSample({ backend: "kokoro" }, { signal: new AbortController().signal, timeoutMs: 1000, deps: { probePort: async (host, port) => { expect([host, port]).toEqual(["localhost", 8082]); return false; } }, build: () => { built += 1; return never(); } });
  expect(result).toMatchObject({ ok: false, state: "not running" });
  expect((result as { startCommand?: string }).startCommand).toContain("kokoro.txt");
  expect(built).toBe(0);
  expect(await synthesizeSample({ backend: "audiocpp", port: 8092 }, { signal: new AbortController().signal, timeoutMs: 1000, deps: { probePort: async () => false } })).toMatchObject({ state: "not running", startCommand: "scripts/provision-audiocpp.sh" });
});

test("a running engine speaks the sample sentence; cloud voices are not sampled", async () => {
  let spoken = "";
  const ok = await synthesizeSample({ backend: "kokoro" }, { signal: new AbortController().signal, timeoutMs: 1000, deps: open, build: () => provider(async (text) => { spoken = text; return new Uint8Array([82, 73, 70, 70]).buffer; }) });
  expect(ok).toEqual({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), mime: "audio/wav" });
  expect(spoken).toBe(SAMPLE_SENTENCE);
  expect(await synthesizeSample({ backend: "elevenlabs", apiKey: "synthetic-marker" }, { signal: new AbortController().signal, timeoutMs: 1000, deps: open })).toMatchObject({ ok: false, state: "failed" });
});

test("cancel and timeout end the sample even if the provider ignores the signal", async () => {
  const controller = new AbortController();
  const pending = synthesizeSample({ backend: "kokoro" }, { signal: controller.signal, timeoutMs: 5000, deps: open, build: never });
  setTimeout(() => controller.abort(), 5);
  expect(await pending).toMatchObject({ ok: false, state: "cancelled" });
  const deaf = () => provider(() => new Promise(() => {}));
  const started = Date.now();
  expect(await synthesizeSample({ backend: "kokoro" }, { signal: new AbortController().signal, timeoutMs: 30, deps: open, build: deaf })).toMatchObject({ ok: false, state: "timeout" });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("/api/sample reports a closed engine port and /api/sample/cancel is accepted", async () => {
  let handler: (req: Request) => Response | Promise<Response> = () => new Response();
  const serve = ((o: { fetch: typeof handler }) => { handler = o.fetch; return { port: 9999, stop() {} }; }) as unknown as typeof Bun.serve;
  const home = mkdtempSync(join(tmpdir(), "cicero-sample-server-"));
  const server = await startSetupServer({ home, serve, output: () => {},
    systemDeps: { platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => null, exists: () => true, statfs: () => ({ bavail: 1, bsize: 1 }) as ReturnType<typeof import("node:fs")["statfsSync"]> },
    pickerDeps: { which: () => null, exists: () => false, probePort: async () => false, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch } });
  try {
    const send = (path: string, body: object) => handler(new Request(`http://127.0.0.1:9999${path}`, { method: "POST", headers: { host: "127.0.0.1:9999", "x-cicero-setup-token": server.token, "x-cicero-setup-csrf": "1" }, body: JSON.stringify(body) }));
    expect(await (await send("/api/sample", { tts: { id: "kokoro" } })).json()).toMatchObject({ ok: false, state: "not running" });
    expect((await send("/api/sample", { tts: { id: "nope" } })).status).toBe(400);
    expect(await (await send("/api/sample/cancel", {})).json()).toEqual({ ok: true });
  } finally { await server.stop(); rmSync(home, { recursive: true, force: true }); }
});

test("maxBytes is enforced and provider errors are bounded", async () => {
  expect(await synthesizeSample({ backend: "kokoro" }, { signal: new AbortController().signal, timeoutMs: 1000, maxBytes: 3, deps: open, build: () => provider(async () => new ArrayBuffer(4)) })).toMatchObject({ ok: false, state: "failed" });
  const failed = await synthesizeSample({ backend: "kokoro" }, { signal: new AbortController().signal, timeoutMs: 1000, deps: open, build: () => provider(async () => { throw new Error(`bad\n${"x".repeat(1000)}`); }) });
  expect(failed.ok).toBe(false);
  expect((failed as { message: string }).message.length).toBeLessThanOrEqual(300);
  expect((failed as { message: string }).message).not.toContain("\n");
});
