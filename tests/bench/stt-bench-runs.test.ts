import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { benchStreamCandidate } from "../../bench/stt-bench";
import type { Clip, StreamCandidate } from "../../bench/stt/types";
import { writeWavFixture } from "../helpers/wav";

const encoder = new TextEncoder();

function writeChunk(socket: Bun.Socket, text: string): void {
  const bytes = encoder.encode(text);
  socket.write(`${bytes.byteLength.toString(16)}\r\n`);
  socket.write(bytes);
  socket.write("\r\n");
}

/**
 * A listener that answers each connection differently, so a candidate can be
 * driven through a run that succeeds and a run that does not.
 */
function listenPerConnection(
  responders: Array<(socket: Bun.Socket) => void>,
  respondAfterHeaders = false,
): Bun.TCPSocketListener<{ request: string; done: boolean }> {
  // Indexed by HTTP requests, not connections: benchStreamCandidate opens and
  // drops a liveness-probe connection first, which would otherwise shift every
  // responder by one and silently test a different scenario.
  let requests = 0;
  return Bun.listen<{ request: string; done: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { request: "", done: false };
      },
      data(socket, data) {
        socket.data.request += data.toString("latin1");
        const requestComplete = socket.data.request.includes("0\r\n\r\n");
        if (socket.data.done) {
          if (respondAfterHeaders && requestComplete) socket.end();
          return;
        }
        const responseReady = respondAfterHeaders
          ? socket.data.request.includes("\r\n\r\n")
          : requestComplete;
        if (!responseReady) return;
        socket.data.done = true;
        const responder = responders[Math.min(requests++, responders.length - 1)];
        responder?.(socket);
        if (respondAfterHeaders && requestComplete) socket.end();
      },
    },
  });
}

function goodResponse(socket: Bun.Socket): void {
  socket.write(
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n",
  );
  writeChunk(socket, 'data: {"type":"transcript.text.done","text":"hello world"}\n\n');
  socket.write("0\r\n\r\n");
  socket.end();
}

function truncatedResponse(socket: Bun.Socket): void {
  socket.write(
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n",
  );
  socket.terminate();
}

function deltaOnlyResponse(socket: Bun.Socket): void {
  socket.write(
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Transfer-Encoding: chunked\r\n\r\n",
  );
  writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"hello world"}\n\n');
  socket.write("0\r\n\r\n");
  socket.end();
}

function errorResponse(message: string): (socket: Bun.Socket) => void {
  return (socket) => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/event-stream\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n",
    );
    writeChunk(socket, `data: ${JSON.stringify({ error: { message } })}\n\n`);
    socket.write("0\r\n\r\n");
    socket.end();
  };
}

function deltaResponse(socket: Bun.Socket): void {
  // Sending partials while the paced request is still uploading makes the
  // during-audio counter non-zero, so the rejection regression covers both
  // candidate-wide delta totals rather than only the total event count.
  setTimeout(() => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/event-stream\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n",
    );
    writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"hello "}\n\n');
    writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"brave "}\n\n');
    writeChunk(socket, 'data: {"type":"transcript.text.delta","delta":"world"}\n\n');
    writeChunk(socket, 'data: {"type":"transcript.text.done","text":"hello brave world"}\n\n');
    socket.write("0\r\n\r\n");
  }, 10);
}

function finalOnlyResponse(socket: Bun.Socket): void {
  // Answers on the same schedule as deltaResponse but sends no partials, and
  // leaves the socket to the harness so the client can finish uploading. A
  // responder that hangs up as soon as it has answered fails the run instead
  // of measuring it, which is a different scenario entirely.
  setTimeout(() => {
    socket.write(
      "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/event-stream\r\n" +
      "Transfer-Encoding: chunked\r\n\r\n",
    );
    writeChunk(socket, 'data: {"type":"transcript.text.done","text":"hello brave world"}\n\n');
    socket.write("0\r\n\r\n");
  }, 10);
}

function candidate(port: number): StreamCandidate {
  return { name: "flaky", kind: "stream", model: "test-model", port, host: "127.0.0.1", chunkMs: 50 };
}

test("a clip whose later run fails is an error, not a one-sample measurement", async () => {
  // The first run populated `transcript`, so a clip that then failed run 2 was
  // scored anyway: WER from one run, latency medians over one sample, and
  // errors=0 for a clip that demonstrably errored. The bench is a measurement
  // tool — a partially measured clip must not be reported as a clean one.
  const wav = writeWavFixture(0.08, 8_000);
  const server = listenPerConnection([goodResponse, truncatedResponse]);
  const clip: Clip = { name: "clip1", path: wav.path, reference: "hello world", durationSec: 0.08 };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 2);
    expect(row.available).toBe(true);
    expect(row.clips).toBe(0);
    expect(row.errors).toBe(1);
    // No fabricated metrics for a clip that never completed.
    expect(row.meanWerPct).toBeNaN();
    expect(row.streaming?.finalAfterAudioMs).toBeNaN();
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a clip whose run omits the terminal event is an error and is not scored", async () => {
  // Clean HTTP framing does not complete the documented event sequence. If the
  // last delta were scored, the non-conforming server would be ranked using a
  // finish timestamp necessarily earlier than the terminal event it omitted.
  const wav = writeWavFixture(0.08, 8_000);
  const server = listenPerConnection([deltaOnlyResponse]);
  const clip: Clip = { name: "clip1", path: wav.path, reference: "hello world", durationSec: 0.08 };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 1);
    expect(row.available).toBe(true);
    expect(row.clips).toBe(0);
    expect(row.errors).toBe(1);
    expect(row.meanWerPct).toBeNaN();
    expect(row.streaming?.finalAfterAudioMs).toBeNaN();
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a rejected clip does not leak its first run delta counts", async () => {
  const wav = writeWavFixture(0.2, 8_000);
  const server = listenPerConnection([deltaResponse, truncatedResponse], true);
  const clip: Clip = {
    name: "clip1",
    path: wav.path,
    reference: "hello brave world",
    durationSec: 0.2,
  };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 2);
    expect(row.clips).toBe(0);
    expect(row.errors).toBe(1);
    expect(row.streaming?.deltas).toBe(0);
    expect(row.streaming?.deltasDuringAudio).toBe(0);
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a fully measured clip reports its first run delta counts", async () => {
  const wav = writeWavFixture(0.2, 8_000);
  const server = listenPerConnection([deltaResponse], true);
  const clip: Clip = {
    name: "clip1",
    path: wav.path,
    reference: "hello brave world",
    durationSec: 0.2,
  };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 2);
    expect(row.clips).toBe(1);
    expect(row.errors).toBe(0);
    expect(row.streaming?.deltas).toBe(3);
    expect(row.streaming?.deltasDuringAudio).toBe(3);
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("first-delta latency is withheld when any repetition has no partial", async () => {
  const wav = writeWavFixture(0.2, 8_000);
  const server = listenPerConnection([deltaResponse, finalOnlyResponse], true);
  const clip: Clip = {
    name: "clip1",
    path: wav.path,
    reference: "hello brave world",
    durationSec: 0.2,
  };
  try {
    // Both runs succeed — this is about a measured absence, not a failure.
    const row = await benchStreamCandidate(candidate(server.port), [clip], 2);
    expect(row.clips).toBe(1);
    expect(row.errors).toBe(0);
    expect(row.streaming?.firstDeltaMs).toBeNaN();
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a clip whose every run succeeds is scored", async () => {
  // The positive side of that boundary: the strict rule must not reject a clip
  // that actually completed all of its runs.
  const wav = writeWavFixture(0.08, 8_000);
  const server = listenPerConnection([goodResponse]);
  const clip: Clip = { name: "clip1", path: wav.path, reference: "hello world", durationSec: 0.08 };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 2);
    expect(row.clips).toBe(1);
    expect(row.errors).toBe(0);
    expect(row.meanWerPct).toBe(0);
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a fast probe reports no streaming latency at all", async () => {
  const wav = writeWavFixture(0.08, 8_000);
  const server = listenPerConnection([goodResponse]);
  const clip: Clip = { name: "clip1", path: wav.path, reference: "hello world", durationSec: 0.08 };
  try {
    const row = await benchStreamCandidate({ ...candidate(server.port), pace: "fast" }, [clip], 1);
    expect(row.clips).toBe(1);
    expect(row.meanWerPct).toBe(0); // accuracy is still a real measurement
    expect(row.streaming?.paced).toBe(false);
    expect(row.streaming?.firstDeltaMs).toBeNaN();
    expect(row.streaming?.finalAfterAudioMs).toBeNaN();
    expect(row.streaming?.deltasDuringAudio).toBeNaN();
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("a real-time candidate still reports its streaming latency", async () => {
  // The other side: withholding must be tied to pace, not applied everywhere.
  const wav = writeWavFixture(0.08, 8_000);
  const server = listenPerConnection([goodResponse]);
  const clip: Clip = { name: "clip1", path: wav.path, reference: "hello world", durationSec: 0.08 };
  try {
    const row = await benchStreamCandidate(candidate(server.port), [clip], 1);
    expect(row.streaming?.paced).toBe(true);
    expect(Number.isNaN(row.streaming!.finalAfterAudioMs)).toBe(false);
  } finally {
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("remote SSE errors are terminal-safe without mangling ordinary messages", async () => {
  // The transcription server is untrusted input (AGENTS.md), and its error text
  // went straight into console.warn: an escaped ESC ]52 sequence in error.message
  // survived JSON.parse as a real OSC 52 clipboard write on the operator's
  // terminal, and an escaped newline let the server forge benchmark output
  // lines. The ordinary message here is the other half — a sanitizer that
  // mangles readable text would make the bench worse, not safer.
  const wav = writeWavFixture(0.08, 8_000);
  const malicious = `remote \u001b]52;c;Y2xpcGJvYXJk\u0007 forged\nline`;
  const ordinary = "model rejected the requested language";
  const server = listenPerConnection([errorResponse(malicious), errorResponse(ordinary)]);
  const clips: Clip[] = [
    { name: "hostile", path: wav.path, reference: "hello", durationSec: 0.08 },
    { name: "ordinary", path: wav.path, reference: "hello", durationSec: 0.08 },
  ];
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const row = await benchStreamCandidate(candidate(server.port), clips, 1);
    expect(row.errors).toBe(2);
    expect(warnings).toHaveLength(2);

    const hostileCodes = Array.from(warnings[0]!, (ch) => ch.codePointAt(0)!);
    expect(hostileCodes).not.toContain(0x1b);
    expect(hostileCodes).not.toContain(0x07);
    expect(hostileCodes).not.toContain(0x0a);
    expect(warnings[1]).toBe(`  ⚠️  flaky / ordinary: ${ordinary}`);
  } finally {
    console.warn = warn;
    server.stop(true);
    rmSync(wav.dir, { recursive: true, force: true });
  }
}, 15_000);

test("an unreachable streaming candidate is still identified as streaming", async () => {
  // Straight through the real aggregation path: the probe fails, and the row it
  // returns must still know which table it belongs in.
  const clip: Clip = { name: "clip1", path: "/nonexistent.wav", reference: "hello", durationSec: 1 };
  const row = await benchStreamCandidate(
    { name: "closed stream", kind: "stream", model: "test-model", host: "127.0.0.1", port: 1 },
    [clip],
    1,
  );
  expect(row.available).toBe(false);
  expect(row.kind).toBe("stream");
}, 15_000);
