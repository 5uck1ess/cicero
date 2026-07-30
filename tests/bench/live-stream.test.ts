import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createServer, type Socket as NodeSocket } from "node:net";
import { transcribeLive } from "../../bench/stt/live-stream";
import type { StreamCandidate } from "../../bench/stt/types";
import { writeWavFixture } from "../helpers/wav";

const encoder = new TextEncoder();

function candidate(port: number): StreamCandidate {
  return {
    name: "local test stream",
    kind: "stream",
    model: "test-model",
    host: "127.0.0.1",
    port,
    pace: "fast",
  };
}

function listenAfterCompleteRequest(
  respond: (socket: Bun.Socket) => void,
): Bun.TCPSocketListener<undefined> {
  let request = "";
  let responded = false;
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        request += data.toString("latin1");
        if (!responded && request.includes("0\r\n\r\n")) {
          responded = true;
          respond(socket);
        }
      },
    },
  });
}

async function withGuard<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test guard expired after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeChunk(socket: Bun.Socket, text: string): void {
  const bytes = encoder.encode(text);
  socket.write(`${bytes.byteLength.toString(16)}\r\n`);
  socket.write(bytes);
  socket.write("\r\n");
}

/**
 * A peer that consumes the whole request and then neither answers nor closes —
 * and, crucially, tolerates the client's half-close. This has to be `node:net`
 * with `allowHalfOpen`: a `Bun.listen` server closes the connection as soon as
 * it sees the client's FIN, which resolves the client's `closed` promise for it
 * and makes a write-side-only `end()` look like a working deadline. Keeping the
 * response side open is what a real streaming HTTP server does while the
 * request body is already finished, and it is the case the deadline must
 * survive without hanging.
 */
async function listenIgnoringHalfClose(): Promise<{
  port: number;
  sawCompleteRequest: () => boolean;
  stop: () => Promise<void>;
}> {
  const sockets = new Set<NodeSocket>();
  let request = "";
  let complete = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("data", (data: Buffer) => {
      request += data.toString("latin1");
      if (request.includes("0\r\n\r\n")) complete = true;
    });
    // Deliberately no `socket.end()` here: the client's FIN must not be echoed.
    socket.on("end", () => {});
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test peer did not report a numeric port");
  }
  return {
    port: address.port,
    sawCompleteRequest: () => complete,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    },
  };
}

/*
 * This test is a behavioural guard, NOT a pre-fix reproducer, and the
 * distinction is worth recording because the original review claimed otherwise.
 * The claim was that the old write-side-only `socket.end()` left `closed`
 * pending until the peer closed, so a silent peer hung the request forever.
 * That is Node's half-close behaviour, not Bun's: measured on Bun 1.3.14, a
 * client `end()` fires the client's own `close` handler immediately even when
 * the peer holds its side open (`allowHalfOpen`), so `closed` resolved and the
 * old code raised this same error. The write path does not hang either — Bun
 * fires `drain` after a close, so a parked `writeAll` is released.
 *
 * The deadline rework is therefore hardening rather than a bug fix: it stops
 * depending on Bun choosing to fire `drain` on a closing socket, which is not
 * documented behaviour. What this test locks in is the error text and that the
 * request terminates; no mutation of the release path makes it fail.
 */
test("live stream deadline releases a peer that never responds or closes", async () => {
  const server = await listenIgnoringHalfClose();
  const wav = writeWavFixture(0.01);
  try {
    await expect(withGuard(
      transcribeLive(wav.path, candidate(server.port), { timeoutMs: 50 }),
    )).rejects.toThrow("no response within 50 ms");
    expect(server.sawCompleteRequest()).toBe(true);
  } finally {
    await server.stop();
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 1_000);

test("live stream rejects a response chunk above the configured limit", async () => {
  const server = listenAfterCompleteRequest((socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/event-stream\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n" +
      "9\r\n",
    );
  });
  const wav = writeWavFixture(0.01);
  try {
    await expect(withGuard(
      transcribeLive(wav.path, candidate(server.port), {
        timeoutMs: 250,
        limits: { maxChunkBytes: 8 },
      }),
    )).rejects.toThrow("response chunk exceeds 8-byte limit");
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 1_000);

test("live stream without a terminal event uses the last delta for time-to-final", async () => {
  const server = listenAfterCompleteRequest((socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/event-stream\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n",
    );
    writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"hello "}\n\n');
    writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"world"}\n\n');
    socket.write("0\r\n\r\n");
    socket.end();
  });
  const wav = writeWavFixture(10);
  const clock = [0, 1_000, 10_500];
  try {
    const result = await withGuard(
      transcribeLive(wav.path, candidate(server.port), {
        timeoutMs: 250,
        now: () => clock.shift() ?? 10_500,
      }),
    );
    expect(result.audioMs).toBeCloseTo(10_000, 5);
    expect(result.firstDeltaMs).toBeCloseTo(1_000, 5);
    expect(result.finalAfterAudioMs).toBeCloseTo(500, 5);
    expect(result.finalAfterAudioMs).not.toBeCloseTo(-9_000, 5);
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 1_000);
