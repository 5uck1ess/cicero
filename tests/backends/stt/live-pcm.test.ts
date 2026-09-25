import { expect, test } from "bun:test";
import { openLivePcm, type LiveStreamConnect } from "../../../src/backends/stt/live-client";
import { AudioCppSTTProvider } from "../../../src/backends/stt/audiocpp";
import { liveSttFailure } from "../../../src/backends/stt/live-failure";

const encoder = new TextEncoder();
const delta = (text: string) => `data: ${JSON.stringify({ type: "transcript.text.delta", delta: text })}\n\n`;
const done = (text: string) => `data: ${JSON.stringify({ type: "transcript.text.done", text })}\n\n`;
const chunk = (body: string) => `${encoder.encode(body).length.toString(16)}\r\n${body}\r\n`;

function fakeEndpoint(first = [delta("he"), delta("llo")], final = done("hello")) {
  let callbacks: any;
  let socket: any;
  let started = false;
  let terminated = 0;
  let written = "";
  const emit = (text: string) => callbacks.data(socket, encoder.encode(text));
  const connect: LiveStreamConnect = async (options) => {
    callbacks = options.socket;
    socket = {
      write(data: Uint8Array | string) {
        const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
        written += new TextDecoder().decode(bytes);
        if (!started && bytes.length === 2 && bytes[0] === 1 && bytes[1] === 0) {
          started = true;
          emit("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + first.map(chunk).join(""));
        }
        if (new TextDecoder().decode(bytes) === "0\r\n\r\n") emit(chunk(final) + "0\r\n\r\n");
        return bytes.length;
      },
      terminate() { terminated++; },
    };
    return socket;
  };
  return { connect, emit, get terminated() { return terminated; }, get written() { return written; } };
}

test("live PCM uses one full-duplex request and yields ordered cumulative partials", async () => {
  const peer = fakeEndpoint();
  const observed: Array<{ text: string; at: number }> = [];
  let time = 10;
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000,
    connect: peer.connect, now: () => ++time, onPartial: (text, at) => observed.push({ text, at }) });
  stream.push(new Uint8Array([1, 0]));
  expect(await stream.end()).toBe("hello");
  const partials: string[] = [];
  for await (const value of stream.partials) partials.push(value);
  expect(partials).toEqual(["he", "hello"]);
  expect(observed).toEqual([{ text: "he", at: 11 }, { text: "hello", at: 12 }]);
  expect(peer.written).toContain("POST /v1/audio/transcriptions/live?model=nemotron&sample_rate=16000&channels=1&sample_format=s16le");
  expect(peer.terminated).toBe(1);
});

test("a terminal whitespace transcript is a successful no-speech result even after partials", async () => {
  const peer = fakeEndpoint([delta("tentative")], done("  \n "));
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000, connect: peer.connect });
  stream.push(new Uint8Array([1, 0]));
  expect(await stream.end()).toBe("");
  expect(peer.terminated).toBe(1);
});

test("a clean response without a terminal transcript fails as missing_terminal", async () => {
  const peer = fakeEndpoint([delta("tentative")], "data: [DONE]\n\n");
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000, connect: peer.connect });
  stream.push(new Uint8Array([1, 0]));
  const failure = await stream.end().catch((error: unknown) => error);
  expect(liveSttFailure(failure)).toBe("missing_terminal");
  expect(failure.message).toContain("missing terminal event");
  expect(peer.terminated).toBe(1);
});

test("queued PCM stays ordered ahead of stream end while the socket is still opening", async () => {
  const peer = fakeEndpoint();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000,
    connect: async (options) => { await gate; return peer.connect(options); } });
  stream.push(new Uint8Array([1, 0]));
  stream.push(new Uint8Array([2, 0]));
  const final = stream.end();
  open();
  expect(await final).toBe("hello");
  expect(peer.written.indexOf("\x01\0")).toBeLessThan(peer.written.indexOf("\x02\0"));
  expect(peer.written.indexOf("\x02\0")).toBeLessThan(peer.written.indexOf("0\r\n\r\n"));
});

test("live response bounds reject an oversized partial", async () => {
  const peer = fakeEndpoint([delta("x".repeat(16_385))]);
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000, connect: peer.connect });
  stream.push(new Uint8Array([1, 0]));
  await expect(stream.end()).rejects.toThrow(/character limit/);
  expect(peer.terminated).toBe(1);
});

test("a provider error event keeps its diagnostic stage", async () => {
  const peer = fakeEndpoint([], `data: ${JSON.stringify({ error: { message: "synthetic provider failure at https://user:password@example.test/?token=synthetic-secret" } })}\n\n`);
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000, connect: peer.connect });
  stream.push(new Uint8Array([1, 0]));
  const failure = await stream.end().catch((error: unknown) => error);
  expect(liveSttFailure(failure)).toBe("server_error");
  expect(failure.message).toContain("synthetic provider failure");
  expect(failure.message).not.toContain("password");
  expect(failure.message).not.toContain("synthetic-secret");
});

test("abort closes the owned socket and drops a late partial", async () => {
  const peer = fakeEndpoint([], done("hello"));
  const seen: string[] = [];
  const abort = new AbortController();
  const stream = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000,
    connect: peer.connect, signal: abort.signal, onPartial: (text) => seen.push(text) });
  stream.push(new Uint8Array([1, 0]));
  await Promise.resolve();
  abort.abort();
  await expect(stream.final).rejects.toThrow(/aborted/);
  peer.emit(chunk(delta("late")));
  expect(seen).toEqual([]);
  expect(peer.terminated).toBe(1);
});

test("a newer audio.cpp live turn supersedes the previous socket and its late captions", async () => {
  const first = fakeEndpoint([]);
  const second = fakeEndpoint();
  let calls = 0;
  const provider = new AudioCppSTTProvider({ backend: "audiocpp", streaming: true, model: "nemotron", port: 8092 });
  provider.liveConnect = (options) => (++calls === 1 ? first : second).connect(options);
  const seen: string[] = [];
  const old = provider.openStream({ sampleRate: 16000, onPartial: (text) => seen.push(text) });
  old.push(new Uint8Array([1, 0]));
  await Promise.resolve();
  const current = provider.openStream({ sampleRate: 16000 });
  current.push(new Uint8Array([1, 0]));
  await expect(old.final).rejects.toThrow(/aborted/);
  first.emit(chunk(delta("late old turn")));
  expect(seen).toEqual([]);
  expect(await current.end()).toBe("hello");
  expect(first.terminated).toBe(1);
});

test("absolute deadline quarantines a connector that settles late", async () => {
  let resolveConnect!: (socket: any) => void;
  let terminated = 0;
  const connect: LiveStreamConnect = () => new Promise((resolve) => { resolveConnect = resolve; });
  const session = openLivePcm({ host: "127.0.0.1", port: 8092, model: "nemotron", sampleRate: 16000,
    connect, timeoutMs: 20 });
  await expect(session.final).rejects.toThrow(/deadline/);
  resolveConnect({ terminate() { terminated++; } });
  await Promise.resolve();
  await Promise.resolve();
  expect(terminated).toBe(1);
});

test("unconfirmed socket release blocks reuse until the close callback confirms it", async () => {
  const provider = new AudioCppSTTProvider({ backend: "audiocpp", streaming: true, model: "nemotron", port: 8092 });
  let callbacks: any;
  let socket: any;
  provider.liveConnect = async (options) => {
    callbacks = options.socket;
    socket = { write(data: Uint8Array) { return data.length; }, terminate() { throw new Error("synthetic close failure"); } };
    return socket;
  };
  const first = provider.openStream({ sampleRate: 16000 });
  await Promise.resolve();
  await Promise.resolve();
  expect(() => provider.openStream({ sampleRate: 16000 })).toThrow(/cleanup is unconfirmed/);
  await expect(first.final).rejects.toThrow(/aborted/);
  callbacks.close(socket);
  const peer = fakeEndpoint();
  provider.liveConnect = peer.connect;
  const recovered = provider.openStream({ sampleRate: 16000 });
  recovered.push(new Uint8Array([1, 0]));
  expect(await recovered.end()).toBe("hello");
});

test("abort during a pending connect blocks reuse until the late socket is closed", async () => {
  const provider = new AudioCppSTTProvider({ backend: "audiocpp", streaming: true, model: "nemotron", port: 8092 });
  let resolveConnect!: (socket: any) => void;
  provider.liveConnect = () => new Promise((resolve) => { resolveConnect = resolve; });
  const first = provider.openStream!({ sampleRate: 16000 });
  expect(first.released).toBe(false);
  first.abort();
  await expect(first.final).rejects.toThrow(/aborted/);
  expect(first.released).toBe(false);
  expect(() => provider.openStream!({ sampleRate: 16000 })).toThrow(/cleanup is unconfirmed/);
  let terminated = 0;
  resolveConnect({ terminate() { terminated++; } });
  await Promise.resolve();
  await Promise.resolve();
  expect(terminated).toBe(1);
  expect(first.released).toBe(true);
  const peer = fakeEndpoint();
  provider.liveConnect = peer.connect;
  const next = provider.openStream!({ sampleRate: 16000 });
  next.push(new Uint8Array([1, 0]));
  expect(await next.end()).toBe("hello");
});
