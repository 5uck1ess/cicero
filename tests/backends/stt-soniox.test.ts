import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SonioxSTTProvider, SONIOX_STT_URL, type SonioxSocket } from "../../src/backends/stt/soniox";
import { liveSttFailure } from "../../src/backends/stt/live-failure";
import { encodeWav } from "../../src/platform/wav";

const KEY = "synthetic-soniox-key-7731";

/** A scripted stand-in for the WHATWG WebSocket the provider drives. */
class FakeSocket implements SonioxSocket {
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }
  close(): void { this.closed = true; }
  terminated = false;
  terminateThrows = false;
  terminate(): void {
    if (this.terminateThrows) throw new Error("terminate failed");
    this.terminated = true;
    this.readyState = 3;
  }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  message(value: unknown): void { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
  closedByPeer(): void { this.readyState = 3; this.onclose?.({}); }
  texts(): string[] { return this.sent.filter((item): item is string => typeof item === "string"); }
  config(): Record<string, unknown> { return JSON.parse(this.texts()[0]!); }
}

function harness(config: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const provider = new SonioxSTTProvider({ backend: "soniox", apiKey: KEY, ...config }, {
    connect: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    env: {},
  });
  return { provider, sockets };
}

const token = (text: string, isFinal: boolean) => ({ text, is_final: isFinal });

test("live PCM streams during speech and the transcript resolves on <fin> after finalize", async () => {
  const { provider, sockets } = harness({ language: "en-US", vocabulary: ["Cicero"] });
  const partials: string[] = [];
  const session = provider.openStream!({ sampleRate: 16_000, onPartial: (text) => partials.push(text) });
  const socket = sockets[0]!;
  expect(socket.url).toBe(SONIOX_STT_URL);

  session.push(new Uint8Array(3200)); // before open: queued, not dropped
  socket.open();
  expect(socket.config()).toEqual({
    api_key: KEY, model: "stt-rt-v5", enable_endpoint_detection: false,
    audio_format: "pcm_s16le", sample_rate: 16_000, num_channels: 1,
    language_hints: ["en"], context: { terms: ["Cicero"] },
  });
  expect(socket.sent[1]).toBeInstanceOf(Uint8Array);
  session.push(new Uint8Array(3200));

  socket.message({ tokens: [token("Hel", false)] });
  socket.message({ tokens: [token("Hello", true), token(" wor", false)] });
  expect(partials).toEqual(["Hel", "Hello wor"]);

  const final = session.end();
  expect(socket.texts().at(-1)).toBe(JSON.stringify({ type: "finalize" }));
  socket.message({ tokens: [token(" world.", true), token("<fin>", true)] });
  expect(await final).toBe("Hello world.");
  // The socket is closed on the way out, after an end-of-audio frame.
  expect(socket.texts().at(-1)).toBe("");
  expect(socket.closed).toBe(true);
  socket.closedByPeer();
  expect(session.released).toBe(true);
});

test("an empty finalized transcript is no speech, not a failure", async () => {
  const { provider, sockets } = harness();
  const session = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  const final = session.end();
  sockets[0]!.message({ tokens: [token("<fin>", true)] });
  expect(await final).toBe("");
});

test("a server error rejects with a scrubbed reason and releases the socket", async () => {
  const { provider, sockets } = harness();
  const session = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  sockets[0]!.message({ tokens: [], error_code: 401, error_type: "unauthenticated", error_message: `Invalid API key ${KEY}\u001b[31m` });
  const error = await session.final.catch((e: unknown) => e);
  expect(liveSttFailure(error)).toBe("server_error");
  expect(String(error)).toContain("401 unauthenticated");
  expect(String(error)).not.toContain(KEY);
  expect(String(error)).not.toContain("\u001b");
  expect(sockets[0]!.terminated).toBe(true);
  expect(session.released).toBe(true);
  expect(() => session.push(new Uint8Array(2))).toThrow("closed");
});

test("abort, early close, and a newer capture each end the session with a typed failure", async () => {
  const { provider, sockets } = harness();
  const controller = new AbortController();
  const aborted = provider.openStream!({ sampleRate: 16_000, signal: controller.signal });
  sockets[0]!.open();
  controller.abort();
  expect(liveSttFailure(await aborted.final.catch((e: unknown) => e))).toBe("aborted");
  expect(sockets[0]!.terminated).toBe(true);
  expect(aborted.released).toBe(true);

  const dropped = provider.openStream!({ sampleRate: 16_000 });
  sockets[1]!.open();
  sockets[1]!.closedByPeer();
  expect(liveSttFailure(await dropped.final.catch((e: unknown) => e))).toBe("missing_terminal");
  expect(dropped.released).toBe(true);

  const first = provider.openStream!({ sampleRate: 16_000 });
  provider.openStream!({ sampleRate: 16_000 });
  expect(liveSttFailure(await first.final.catch((e: unknown) => e))).toBe("aborted");
  expect(sockets[2]!.terminated).toBe(true);
});

test("an unconfirmed socket release blocks new streams until the close is confirmed", async () => {
  const { provider, sockets } = harness();
  const stuck = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  sockets[0]!.terminateThrows = true;
  stuck.abort();
  expect(liveSttFailure(await stuck.final.catch((e: unknown) => e))).toBe("aborted");
  expect(stuck.released).toBe(false);
  expect(() => provider.openStream!({ sampleRate: 16_000 })).toThrow("cleanup is unconfirmed");
  expect(sockets).toHaveLength(1);
  // The latch is retryable: once the runtime reports the socket closed, streaming resumes.
  sockets[0]!.closedByPeer();
  expect(stuck.released).toBe(true);
  provider.openStream!({ sampleRate: 16_000 });
  expect(sockets).toHaveLength(2);
});

test("a release that fails while superseding blocks the new stream and the batch retry", async () => {
  const { provider, sockets } = harness();
  const first = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  sockets[0]!.terminateThrows = true;
  expect(() => provider.openStream!({ sampleRate: 16_000 })).toThrow("cleanup is unconfirmed");
  expect(liveSttFailure(await first.final.catch((e: unknown) => e))).toBe("aborted");
  expect(sockets).toHaveLength(1);
  const wav = join(mkdtempSync(join(tmpdir(), "cicero-soniox-")), "turn.wav");
  writeFileSync(wav, encodeWav(new Int16Array(1_600), 16_000));
  expect(await provider.transcribeResult(wav)).toEqual({ kind: "failure", reason: "prior Soniox socket cleanup is unconfirmed" });
  expect(sockets).toHaveLength(1);
  sockets[0]!.closedByPeer();
  provider.openStream!({ sampleRate: 16_000 });
  expect(sockets).toHaveLength(2);
});

test("oversized or malformed server messages fail closed instead of being retained", async () => {
  const { provider, sockets } = harness();
  const big = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  sockets[0]!.message("x".repeat(300 * 1024));
  expect(String(await big.final.catch((e: unknown) => e))).toContain("size limit");

  const garbled = provider.openStream!({ sampleRate: 16_000 });
  sockets[1]!.open();
  sockets[1]!.message("{not json");
  expect(String(await garbled.final.catch((e: unknown) => e))).toContain("malformed");
});

test("transcribe() sends the finished WAV with format auto and returns the final text", async () => {
  const { provider, sockets } = harness();
  const dir = mkdtempSync(join(tmpdir(), "cicero-soniox-"));
  const path = join(dir, "turn.wav");
  writeFileSync(path, encodeWav(new Int16Array(16_000), 16_000));
  const pending = provider.transcribeResult(path);
  for (let i = 0; i < 100 && sockets.length === 0; i++) await Bun.sleep(1);
  const socket = sockets[0]!;
  socket.open();
  expect(socket.config()).toMatchObject({ audio_format: "auto", api_key: KEY });
  expect(socket.config().sample_rate).toBeUndefined();
  const audioBytes = socket.sent.filter((item) => item instanceof Uint8Array).reduce((sum, item) => sum + (item as Uint8Array).length, 0);
  expect(audioBytes).toBe(44 + 32_000);
  socket.message({ tokens: [token("Testing one two.", true), token("<fin>", true)] });
  expect(await pending).toEqual({ kind: "transcript", text: "Testing one two." });
});

test("no key means no socket, and live streaming can be switched off", () => {
  const sockets: FakeSocket[] = [];
  const provider = new SonioxSTTProvider({ backend: "soniox" }, {
    connect: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    env: {},
  });
  expect(() => provider.openStream!({ sampleRate: 16_000 })).toThrow("SONIOX_API_KEY");
  expect(sockets).toHaveLength(0);
  expect(new SonioxSTTProvider({ backend: "soniox", apiKey: KEY, streaming: false }).openStream).toBeUndefined();
});

test("stop() keeps ownership of an unconfirmed socket and succeeds once a retry closes it", async () => {
  const { provider, sockets } = harness();
  const session = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  sockets[0]!.terminateThrows = true;
  session.abort();
  await expect(provider.stop()).rejects.toThrow("cleanup is unconfirmed");
  await expect(provider.stop()).rejects.toThrow("cleanup is unconfirmed");
  sockets[0]!.terminateThrows = false;
  await provider.stop();
  expect(sockets[0]!.terminated).toBe(true);
  expect(session.released).toBe(true);
  provider.openStream!({ sampleRate: 16_000 });
  expect(sockets).toHaveLength(2);
});

test("stop() force-closes a finished session still inside its close grace period", async () => {
  const { provider, sockets } = harness();
  const session = provider.openStream!({ sampleRate: 16_000 });
  sockets[0]!.open();
  const final = session.end();
  sockets[0]!.message({ tokens: [token("done", true), token("<fin>", true)] });
  expect(await final).toBe("done");
  expect(session.released).toBe(false);
  await provider.stop();
  expect(sockets[0]!.terminated).toBe(true);
  expect(session.released).toBe(true);
});

test("swap readiness: warmup accepts a listed Soniox model and refuses an unknown one", async () => {
  const models = { models: [{ id: "stt-rt-v5" }, { id: "stt-rt-v4", aliased_model_id: "stt-rt-v5" }] };
  const listing = (async () => Response.json(models)) as unknown as typeof fetch;
  await new SonioxSTTProvider({ backend: "soniox", apiKey: KEY, model: "stt-rt-v4" }, { fetcher: listing, env: {} }).warmup();
  const error = await new SonioxSTTProvider({ backend: "soniox", apiKey: KEY, model: "stt-404" }, { fetcher: listing, env: {} })
    .warmup().catch((e: Error) => e);
  expect(String(error)).toContain("does not offer model 'stt-404'");
});
