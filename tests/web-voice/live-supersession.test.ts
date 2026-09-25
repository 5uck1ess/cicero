import { expect, test } from "bun:test";
import { startWebVoiceServer } from "../../src/web-voice/server";
import { encodeStreamPcmFrame, encodeTurnAudioFrame } from "../../src/web-voice/protocol";
import type { LivePcmSession } from "../../src/backends/stt/live-client";

function wav(): ArrayBuffer {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, 38, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, 2, true);
  return bytes.buffer;
}

function fakeStream() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const final = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const pushed: number[] = [];
  let ended = false;
  let aborted = 0;
  let settled = false;
  const session: LivePcmSession = {
    push(pcm) { pushed.push(pcm[0]!); },
    end() { ended = true; return final; },
    abort() { aborted++; if (!settled) { settled = true; reject(new Error("aborted")); } },
    final,
    partials: { async *[Symbol.asyncIterator]() {} },
    get released() { return settled; },
  };
  return { session, pushed, get ended() { return ended; }, get aborted() { return aborted; },
    finish(text: string) { if (!settled) { settled = true; resolve(text); } } };
}

function harness() {
  let handlers: any;
  let socket: any;
  let server: any;
  const sockets: any[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  const finals: string[] = [];
  let batchRetries = 0;
  const serve = ((options: any) => {
    handlers = options;
    server = {
      port: 0,
      upgrade(_req: Request, upgrade: { data: unknown }) {
        let closed = false;
        const connected: any = {
          data: upgrade.data,
          getBufferedAmount: () => 0,
          send(value: string) { sent.push(JSON.parse(value)); return 1; },
          close() { if (!closed) { closed = true; handlers.websocket.close(connected); } },
          terminate() { connected.close(); },
        };
        socket = connected;
        sockets.push(connected);
        return true;
      },
      stop() { for (const connected of sockets) connected.close(); },
    };
    return server;
  }) as unknown as typeof Bun.serve;
  const handle = startWebVoiceServer({ port: 0, token: "synthetic-token", serve,
    onTurn: async () => ({ transcript: "", reply: "", audio: new ArrayBuffer(0) }),
    onStreamTurn: async (_wav, sink, options) => {
      if (!options?.streamFinal) { batchRetries++; sink.done(); return; }
      const text = await options.streamFinal.catch(() => { batchRetries++; return "batch result"; });
      finals.push(text);
      if (!sink.aborted()) sink.transcript(text);
      sink.done();
    },
    resolveSttStream: () => () => {
      const stream = fakeStream();
      streams.push(stream);
      return stream.session;
    },
  })!;
  const connect = async () => {
    await handlers.fetch(new Request("http://localhost/ws?token=synthetic-token&protocol=2"), server);
    handlers.websocket.open(socket);
    return (sent.filter((item) => item.type === "hello").at(-1) as { sessionId: string }).sessionId;
  };
  const send = (sessionId: string, turnId: string, payload: ArrayBuffer) =>
    handlers.websocket.message(socket, new Uint8Array(encodeTurnAudioFrame(sessionId, turnId, payload)));
  const pcmBytes = (sessionId: string, turnId: string, sequence: number, bytes: Uint8Array) =>
    send(sessionId, turnId, encodeStreamPcmFrame(sequence, 16_000, bytes).buffer);
  const pcm = (sessionId: string, turnId: string, sequence: number, marker: number) =>
    pcmBytes(sessionId, turnId, sequence, new Uint8Array([marker, 0]));
  const abortCapture = (sessionId: string, turnId: string) =>
    handlers.websocket.message(socket, JSON.stringify({ type: "capture_abort", sessionId, turnId }));
  const abortTurn = (sessionId: string, turnId: string) =>
    handlers.websocket.message(socket, JSON.stringify({ type: "abort", sessionId, turnId }));
  return { handle, connect, send, pcm, pcmBytes, abortCapture, abortTurn, disconnect: () => socket.close(),
    streams, finals, sent, get batchRetries() { return batchRetries; } };
}

test("a stray new tap cannot abort a pending live final or trigger batch retry", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    const olderWav = h.send(id, "old", wav());
    await Bun.sleep(0);
    expect(h.streams[0]!.ended).toBe(true);
    await h.abortCapture(id, "stray");
    expect(h.streams[0]!.aborted).toBe(0);
    expect(h.streams).toHaveLength(1);
    h.streams[0]!.finish("old final");
    await olderWav;
    await Bun.sleep(0);
    expect(h.finals).toEqual(["old final"]);
    expect(h.sent.some((message) => message.type === "transcript" && message.turnId === "old")).toBe(true);
    expect(h.batchRetries).toBe(0);
  } finally { await h.handle.stop(); }
});

test("a committed capture buffers PCM until the preceding live final settles", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    const olderWav = h.send(id, "old", wav());
    await Bun.sleep(0);
    await h.abortTurn(id, "old"); // committed barge-in may cancel its reply, never its pending final
    await h.pcm(id, "new", 1, 2);
    await h.pcm(id, "new", 2, 3);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.aborted).toBe(0);
    const newerWav = h.send(id, "new", wav());
    h.streams[0]!.finish("old final");
    await Bun.sleep(0);
    expect(h.finals).toContain("old final");
    expect(h.sent.some((message) => message.type === "transcript" && message.turnId === "old")).toBe(true);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.pushed).toEqual([2, 3]);
    expect(h.streams[1]!.ended).toBe(true);
    h.streams[1]!.finish("new final");
    await Promise.all([olderWav, newerWav]);
    await Bun.sleep(0);
    expect(h.finals).toContain("new final");
    expect(h.batchRetries).toBe(0);
  } finally { await h.handle.stop(); }
});

test("a committed capture still supersedes a stream receiving audio", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    await h.pcm(id, "new", 1, 2);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0]!.aborted).toBeGreaterThan(0);
    expect(h.streams[1]!.pushed).toEqual([2]);
  } finally { await h.handle.stop(); }
});

test("a second browser waits for the same ended audio.cpp seat", async () => {
  const h = harness();
  try {
    const firstId = await h.connect();
    await h.pcm(firstId, "old", 1, 1);
    const olderWav = h.send(firstId, "old", wav());
    await Bun.sleep(0);
    const secondId = await h.connect();
    await h.pcm(secondId, "new", 1, 2);
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.aborted).toBe(0);
    h.streams[0]!.finish("old final");
    await olderWav;
    await Bun.sleep(0);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.pushed).toEqual([2]);
  } finally { await h.handle.stop(); }
});

test("a newer batch-only WAV also leaves the preceding live final intact", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    const olderWav = h.send(id, "old", wav());
    await Bun.sleep(0);
    const newerWav = h.send(id, "batch", wav());
    expect(h.batchRetries).toBe(0);
    expect(h.streams[0]!.aborted).toBe(0);
    h.streams[0]!.finish("old final");
    await Promise.all([olderWav, newerWav]);
    expect(h.finals).toContain("old final");
    expect(h.batchRetries).toBe(1);
  } finally { await h.handle.stop(); }
});

test("ended captures keep their order when a third turn asks for the seat", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "first", 1, 1);
    const firstWav = h.send(id, "first", wav());
    await Bun.sleep(0);
    await h.pcm(id, "second", 1, 2);
    const secondWav = h.send(id, "second", wav());
    await Bun.sleep(0);
    await h.pcm(id, "third", 1, 3);
    expect(h.streams).toHaveLength(1);
    h.streams[0]!.finish("first final");
    await Bun.sleep(0);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.ended).toBe(true);
    h.streams[1]!.finish("second final");
    await Bun.sleep(0);
    expect(h.streams).toHaveLength(3);
    expect(h.streams[2]!.pushed).toEqual([3]);
    await Promise.all([firstWav, secondWav]);
  } finally { await h.handle.stop(); }
});

test("shutdown closes the ended owner and discards a newer buffered capture", async () => {
  const h = harness();
  const id = await h.connect();
  await h.pcm(id, "old", 1, 1);
  const olderWav = h.send(id, "old", wav());
  await Bun.sleep(0);
  await h.pcm(id, "new", 1, 2);
  expect(h.streams).toHaveLength(1);
  await h.handle.stop();
  await olderWav;
  expect(h.streams[0]!.aborted).toBe(1);
  expect(h.streams).toHaveLength(1);
});

test("disconnect closes its ended stream before a buffered capture can open", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    const olderWav = h.send(id, "old", wav());
    await Bun.sleep(0);
    await h.pcm(id, "new", 1, 2);
    h.disconnect();
    await olderWav;
    await Bun.sleep(0);
    expect(h.streams[0]!.aborted).toBe(1);
    expect(h.streams).toHaveLength(1);
  } finally { await h.handle.stop(); }
});

test("PCM queued behind a final obeys the existing four MiB turn bound", async () => {
  const h = harness();
  try {
    const id = await h.connect();
    await h.pcm(id, "old", 1, 1);
    const olderWav = h.send(id, "old", wav());
    await Bun.sleep(0);
    const block = new Uint8Array(64 * 1024);
    for (let sequence = 1; sequence <= 65; sequence++) {
      await h.pcmBytes(id, "new", sequence, block);
    }
    expect(h.streams).toHaveLength(1);
    expect(h.streams[0]!.aborted).toBe(0);
    h.streams[0]!.finish("old final");
    await olderWav;
    await Bun.sleep(0);
    expect(h.streams).toHaveLength(1);
  } finally { await h.handle.stop(); }
});
