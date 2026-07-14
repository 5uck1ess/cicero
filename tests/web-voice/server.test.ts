import { test, expect, afterEach } from "bun:test";
import { startWebVoiceServer, type WebVoiceHandle } from "../../src/web-voice/server";
import { encodeProbeFrame } from "../../src/web-voice/probe";
import type { SpeculativeTurn } from "../../src/web-voice/speculative";
import {
  MAX_TURN_AUDIO_BYTES,
  MAX_TURN_AUDIO_MS,
  MAX_NOTIFY_JSON_BYTES,
  MAX_CHAT_TEXT_CHARS,
  MAX_HEALTH_ROWS,
  MAX_CONCURRENT_WEB_JOBS,
  MAX_WEB_VOICE_CLIENTS,
  decodeTurnAudioFrame,
  encodeTurnAudioFrame,
} from "../../src/web-voice/protocol";

let handle: WebVoiceHandle | null = null;
afterEach(() => {
  const current = handle;
  handle = null;
  if (!current) return Promise.resolve();
  return current.stop().catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
});

const TOKEN = "secret-token-123";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function wav(marker = 1, durationMs = 1, sampleRate = 16_000): ArrayBuffer {
  const sampleCount = Math.max(1, Math.ceil((durationMs / 1_000) * sampleRate));
  const dataBytes = sampleCount * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) out[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  out[44] = marker;
  return out.buffer;
}

function pcm16WavWithByteLength(byteLength: number): ArrayBuffer {
  if (byteLength < 46 || (byteLength - 44) % 2 !== 0) {
    throw new RangeError("PCM16 WAV length must contain a whole sample");
  }
  const out = new Uint8Array(byteLength);
  out.set(new Uint8Array(wav()).subarray(0, 44));
  const view = new DataView(out.buffer);
  view.setUint32(4, byteLength - 8, true);
  view.setUint32(40, byteLength - 44, true);
  return out.buffer;
}

function start(opts: {
  onTurn?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onTurn"]>;
  onStreamTurn?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onStreamTurn"]>;
  onTextTurn?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onTextTurn"]>;
  onNotify?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onNotify"]>;
  onNotified?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onNotified"]>;
  onSay?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onSay"]>;
  onChat?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onChat"]>;
  onHistory?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onHistory"]>;
  onHealth?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onHealth"]>;
  onTurnProbe?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onTurnProbe"]>;
  onSpeculate?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["onSpeculate"]>;
  readiness?: NonNullable<Parameters<typeof startWebVoiceServer>[0]["readiness"]>;
  shutdownDrainTimeoutMs?: number;
  vadDir?: string;
} = {}): string {
  handle = startWebVoiceServer({
    host: "127.0.0.1",
    port: 0, // ephemeral
    token: TOKEN,
    tls: null,
    onTurn: opts.onTurn ?? (async () => ({ transcript: "hi", reply: "hello", audio: new ArrayBuffer(0) })),
    onStreamTurn: opts.onStreamTurn,
    onTextTurn: opts.onTextTurn,
    onNotify: opts.onNotify,
    onNotified: opts.onNotified,
    onSay: opts.onSay,
    onChat: opts.onChat,
    onHistory: opts.onHistory,
    onHealth: opts.onHealth,
    onTurnProbe: opts.onTurnProbe,
    onSpeculate: opts.onSpeculate,
    readiness: opts.readiness,
    shutdownDrainTimeoutMs: opts.shutdownDrainTimeoutMs,
    vadDir: opts.vadDir,
  });
  if (!handle) throw new Error("server failed to start");
  return `http://127.0.0.1:${handle.port}`;
}

function connectV2(base: string): Promise<{ ws: WebSocket; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?protocol=2&token=" + TOKEN);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("v2 hello timeout")), 3000);
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { type?: string; sessionId?: string };
      if (message.type !== "hello" || !message.sessionId) return;
      clearTimeout(timer);
      resolve({ ws, sessionId: message.sessionId });
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("v2 socket error")); };
  });
}

function connect(base: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("socket open timeout")), 3_000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("socket open failed")); };
  });
}

test("/health needs no token", async () => {
  const base = start();
  const res = await fetch(base + "/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("/ready reports daemon readiness with 503/200 while /health stays live", async () => {
  let ready = false;
  const base = start({ readiness: () => ready ? { ready: true } : { ready: false, reason: "starting" } });
  const unavailable = await fetch(base + "/ready");
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({ status: "not_ready", reason: "starting" });
  expect((await fetch(base + "/health")).status).toBe(200);
  ready = true;
  const available = await fetch(base + "/ready");
  expect(available.status).toBe(200);
  expect(await available.json()).toEqual({ status: "ready" });
});

test("/ready fails closed when the readiness callback errors", async () => {
  const base = start({ readiness: async () => { throw new Error("provider exploded"); } });
  const res = await fetch(base + "/ready");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "not_ready", reason: "readiness check failed" });
});

test("page and /api/turn are 403 without the token", async () => {
  const base = start();
  expect((await fetch(base + "/")).status).toBe(403);
  expect((await fetch(base + "/api/turn", { method: "POST", body: new ArrayBuffer(8) })).status).toBe(403);
});

test("the page is served with a valid ?token", async () => {
  const base = start();
  const res = await fetch(base + "/?token=" + TOKEN);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Start conversation");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("POST /api/turn runs onTurn and returns transcript, reply, base64 audio", async () => {
  let received = 0;
  const input = wav(9);
  const output = wav(4);
  const base = start({ onTurn: async (wav) => {
    received = wav.byteLength;
    return { transcript: "what time is it", reply: "noon", audio: output };
  } });
  const res = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: input,
  });
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(received).toBe(input.byteLength);
  expect(data.transcript).toBe("what time is it");
  expect(data.reply).toBe("noon");
  expect(data.audioBase64).toBe(Buffer.from(output).toString("base64"));
  expect(typeof data.sessionId).toBe("string");
  expect(typeof data.turnId).toBe("string");
  expect(res.headers.get("x-cicero-session-id")).toBe(data.sessionId);
  expect(res.headers.get("x-cicero-turn-id")).toBe(data.turnId);
});

test("POST /api/turn admits the exact reply cap and rejects the first larger PCM frame", async () => {
  let output = pcm16WavWithByteLength(MAX_TURN_AUDIO_BYTES);
  const base = start({
    onTurn: async () => ({ transcript: "bounded", reply: "reply", audio: output }),
  });
  const request = () => fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: wav(),
  });

  const exact = await request();
  expect(exact.status).toBe(200);
  const exactBody = await exact.json() as { audioBase64: string };
  expect(Buffer.from(exactBody.audioBase64, "base64").byteLength).toBe(MAX_TURN_AUDIO_BYTES);

  // PCM16 WAVs grow in two-byte frames, so this is the first structurally
  // valid clip above the byte boundary.
  output = pcm16WavWithByteLength(MAX_TURN_AUDIO_BYTES + 2);
  const over = await request();
  expect(over.status).toBe(500);
  expect((await over.json() as { error: string }).error)
    .toContain(`${MAX_TURN_AUDIO_BYTES}-byte limit`);
});

test("POST /api/turn echoes caller identities and rejects invalid ones", async () => {
  const base = start();
  const headers = {
    Authorization: "Bearer " + TOKEN,
    "X-Cicero-Session-Id": "phone-session",
    "X-Cicero-Turn-Id": "phone-turn-42",
  };
  const res = await fetch(base + "/api/turn", { method: "POST", headers, body: wav(1) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ sessionId: "phone-session", turnId: "phone-turn-42" });
  const bad = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { ...headers, "X-Cicero-Turn-Id": "../bad" },
    body: wav(1),
  });
  expect(bad.status).toBe(400);
  expect(bad.headers.get("connection")).toBe("close");
});

test("POST /api/turn rejects oversized audio before invoking the handler", async () => {
  let called = false;
  const base = start({ onTurn: async () => { called = true; return { transcript: "", reply: "", audio: new ArrayBuffer(0) }; } });
  const res = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: new Uint8Array(MAX_TURN_AUDIO_BYTES + 1),
  });
  expect(res.status).toBe(413);
  expect((await res.json() as { error: string }).error).toBe("audio body too large");
  expect(called).toBe(false);
});

test("empty audio body is a 400", async () => {
  const base = start();
  const res = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
    body: new ArrayBuffer(0),
  });
  expect(res.status).toBe(400);
});

test("POST /api/turn rejects compressed, malformed, and excessive-duration audio", async () => {
  let called = 0;
  const base = start({ onTurn: () => {
    called += 1;
    return Promise.resolve({ transcript: "", reply: "", audio: new ArrayBuffer(0) });
  } });
  const auth = { Authorization: "Bearer " + TOKEN };
  const compressed = wav();
  new DataView(compressed).setUint16(20, 6, true); // A-law, not uncompressed PCM
  for (const body of [new Uint8Array([1, 2, 3]).buffer, compressed, wav(1, MAX_TURN_AUDIO_MS + 1)]) {
    const res = await fetch(base + "/api/turn", { method: "POST", headers: auth, body });
    expect(res.status).toBe(415);
  }
  expect(called).toBe(0);
});

test("JSON routes reject oversized and overlong fields before invoking handlers", async () => {
  let calls = 0;
  const base = start({
    onNotify: () => { calls += 1; return Promise.resolve(new ArrayBuffer(0)); },
    onChat: () => { calls += 1; return Promise.resolve("ok"); },
  });
  const headers = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  const oversized = await fetch(base + "/api/notify", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "x".repeat(MAX_NOTIFY_JSON_BYTES) }),
  });
  expect(oversized.status).toBe(413);
  const overlong = await fetch(base + "/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "x".repeat(MAX_CHAT_TEXT_CHARS + 1) }),
  });
  expect(overlong.status).toBe(413);

  // Exercise the chunked cancellation last. Some HTTP runtimes cannot safely
  // reuse a keep-alive connection whose unread request stream was cancelled;
  // production marks this response Connection: close for that reason.
  const encoded = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(MAX_NOTIFY_JSON_BYTES) }));
  const chunkedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const midpoint = Math.floor(encoded.byteLength / 2);
      controller.enqueue(encoded.subarray(0, midpoint));
      controller.enqueue(encoded.subarray(midpoint));
      controller.close();
    },
  });
  const chunked = await fetch(base + "/api/notify", { method: "POST", headers, body: chunkedBody });
  expect(chunked.status).toBe(413);
  expect(chunked.headers.get("connection")).toBe("close");
  expect(calls).toBe(0);
});

test("health ingest caps rows, field sizes, and non-finite values", async () => {
  let calls = 0;
  const base = start({ onHealth: () => { calls += 1; return Promise.resolve(0); } });
  const url = base + "/api/health?token=" + TOKEN;
  const headers = { "Content-Type": "application/json" };
  const tooMany = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(Array.from({ length: MAX_HEALTH_ROWS + 1 }, () => ({ metric: "m", value: 1 }))),
  });
  expect(tooMany.status).toBe(413);
  const invalid = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ metric: "m".repeat(129), note: "x" }),
  });
  expect(invalid.status).toBe(400);
  expect(calls).toBe(0);
});

test("global admission returns 429 instead of spawning unbounded chat work", async () => {
  let entered = 0;
  let releaseJobs = () => {};
  let signalEntered = () => {};
  const jobsReleased = new Promise<void>((resolve) => { releaseJobs = resolve; });
  const allEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const base = start({
    onChat: () => {
      entered += 1;
      if (entered === MAX_CONCURRENT_WEB_JOBS) signalEntered();
      return jobsReleased.then(() => "ok");
    },
  });
  const request = () => fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  const active = Array.from({ length: MAX_CONCURRENT_WEB_JOBS }, () => request());
  await allEntered;
  const overflow = await request();
  expect(overflow.status).toBe(429);
  releaseJobs();
  expect((await Promise.all(active)).every((response) => response.status === 200)).toBe(true);
});

test("body readers acquire global admission before parsing completes", async () => {
  const base = start({ onChat: async () => "ok" });
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests = Array.from({ length: MAX_CONCURRENT_WEB_JOBS }, () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        controller.enqueue(new TextEncoder().encode('{"text":"'));
      },
    });
    return fetch(base + "/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
    });
  });
  await Bun.sleep(100);

  const overflow = await fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "one too many" }),
  });
  expect(overflow.status).toBe(429);

  for (const controller of controllers) {
    controller.enqueue(new TextEncoder().encode('held request"}'));
    controller.close();
  }
  expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true);
});

test("stop aborts and drains a request that is still reading its body", async () => {
  let calls = 0;
  const base = start({ onChat: async () => { calls += 1; return "unexpected"; } });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"text":"'));
    },
  });
  const request = fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body,
  }).catch(() => null);
  await Bun.sleep(50);

  await Promise.race([
    handle!.stop(),
    Bun.sleep(1_000).then(() => { throw new Error("shutdown did not abort the active body reader"); }),
  ]);
  await request;
  expect(calls).toBe(0);
});

test("HTTP client cancellation reaches an active provider signal", async () => {
  const entered = deferred();
  const cancelled = deferred();
  const base = start({
    onChat: (_text, options) => {
      entered.resolve();
      return new Promise<string>((resolve) => {
        const signal = options?.signal;
        const finish = () => { cancelled.resolve(); resolve("cancelled"); };
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    },
  });
  const controller = new AbortController();
  const request = fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "cancel me" }),
    signal: controller.signal,
  }).catch(() => null);
  await entered.promise;
  controller.abort(new Error("client left"));
  await Promise.race([
    cancelled.promise,
    Bun.sleep(1_000).then(() => { throw new Error("client cancellation did not reach the provider"); }),
  ]);
  await request;
});

test("live speculative work is charged to the global admission cap", async () => {
  let created = 0;
  const sockets: WebSocket[] = [];
  const base = start({
    onChat: async () => "should be saturated",
    onTurnProbe: async () => ({ complete: true, probability: 0.99 }),
    onSpeculate: () => {
      created += 1;
      return {
        claim: () => false,
        coverageOk: () => false,
        transcript: async () => null,
        tokens: () => null,
        abort: async () => {},
      };
    },
  });
  try {
    for (let index = 0; index < MAX_CONCURRENT_WEB_JOBS; index++) {
      const ws = await connect(base);
      sockets.push(ws);
      ws.send(encodeProbeFrame(new Float32Array([0.1, -0.1]), 16_000, 100));
      const expected = index + 1;
      const deadline = Date.now() + 2_000;
      while (created < expected && Date.now() < deadline) await Bun.sleep(5);
      expect(created).toBe(expected);
    }
    const response = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "must wait" }),
    });
    expect(response.status).toBe(429);
  } finally {
    for (const ws of sockets) ws.close();
  }
});

test("self-closed speculative work releases its exact global admission slot", async () => {
  let created = 0;
  const lifetimes = Array.from({ length: MAX_CONCURRENT_WEB_JOBS }, () => deferred());
  const sockets: WebSocket[] = [];
  const base = start({
    onChat: async () => "admitted after cleanup",
    onTurnProbe: async () => ({ complete: true, probability: 0.99 }),
    onSpeculate: () => {
      const lifetime = lifetimes[created++]!;
      return {
        claim: () => false,
        coverageOk: () => false,
        transcript: async () => null,
        tokens: () => null,
        abort: async () => {},
        closed: lifetime.promise,
      };
    },
  });
  const chat = () => fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "admission check" }),
  });
  try {
    for (let index = 0; index < MAX_CONCURRENT_WEB_JOBS; index++) {
      const ws = await connect(base);
      sockets.push(ws);
      ws.send(encodeProbeFrame(new Float32Array([0.1, -0.1]), 16_000, 100));
      const expected = index + 1;
      const deadline = Date.now() + 2_000;
      while (created < expected && Date.now() < deadline) await Bun.sleep(5);
      expect(created).toBe(expected);
    }

    expect((await chat()).status).toBe(429);
    lifetimes[0]!.resolve();
    await lifetimes[0]!.promise;
    await Bun.sleep(0);
    expect((await chat()).status).toBe(200);
  } finally {
    for (const lifetime of lifetimes) lifetime.resolve();
    for (const ws of sockets) ws.close();
  }
});

test("ws: streams transcript (json), sentence (json), audio (binary), done (json)", async () => {
  const base = start({
    onStreamTurn: (_input, sink) => {
      sink.transcript("hello");
      sink.sentence("Hi there.");
      sink.audio(wav(4));
      sink.done();
      return Promise.resolve();
    },
  });
  const msgs: Array<string | ArrayBuffer> = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
    ws.onopen = () => ws.send(wav(9));
    ws.onmessage = (e: MessageEvent) => {
      msgs.push(e.data);
      if (typeof e.data === "string" && JSON.parse(e.data).type === "done") { clearTimeout(timer); ws.close(); resolve(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(JSON.parse(msgs[0] as string)).toEqual({ type: "transcript", text: "hello" });
  expect(JSON.parse(msgs[1] as string)).toEqual({ type: "sentence", text: "Hi there." });
  expect(msgs[2] instanceof ArrayBuffer).toBe(true);
  expect((msgs[2] as ArrayBuffer).byteLength).toBe(wav(4).byteLength);
  expect(JSON.parse(msgs[3] as string)).toEqual({ type: "done" });
});

test("ws sink rejects malformed and oversized synthesized clips before forwarding", async () => {
  const oversizedDurationMs = Math.ceil(
    ((MAX_TURN_AUDIO_BYTES + 1) / (16_000 * 2)) * 1_000,
  );
  const oversized = wav(1, oversizedDurationMs);
  expect(oversized.byteLength).toBeGreaterThan(MAX_TURN_AUDIO_BYTES);
  const base = start({
    onStreamTurn: (_input, sink) => {
      sink.audio(new ArrayBuffer(8));
      sink.audio(oversized);
      sink.done();
      return Promise.resolve();
    },
  });
  const messages: Array<string | ArrayBuffer> = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws output admission timeout")), 3000);
    ws.onopen = () => ws.send(wav(1));
    ws.onmessage = (event: MessageEvent) => {
      messages.push(event.data);
      if (typeof event.data === "string" && JSON.parse(event.data).type === "done") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws output admission error")); };
  });
  expect(messages.some((message) => message instanceof ArrayBuffer)).toBe(false);
  const errors = messages
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as { type: string; message?: string })
    .filter((message) => message.type === "error")
    .map((message) => message.message ?? "");
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("RIFF/WAVE");
  expect(errors[1]).toContain(`${MAX_TURN_AUDIO_BYTES}-byte limit`);
});

test("ws v2: hello and every turn frame carry the connection and turn identities", async () => {
  const base = start({
    onStreamTurn: async (_wav, sink) => {
      sink.transcript("hello");
      sink.sentence("Hi there.");
      sink.audio(wav(4));
      sink.done();
    },
  });
  const { ws, sessionId } = await connectV2(base);
  const turnId = "turn-v2-1";
  const messages: Array<string | ArrayBuffer> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v2 turn timeout")), 3000);
      ws.onmessage = (event) => {
        messages.push(event.data);
        if (typeof event.data === "string" && JSON.parse(event.data).type === "done") {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("v2 socket error")); };
      ws.send(encodeTurnAudioFrame(sessionId, turnId, wav(9)));
    });
  } finally {
    ws.close();
  }

  const json = messages.filter((m): m is string => typeof m === "string").map((m) => JSON.parse(m));
  expect(json.map((m) => m.type)).toEqual(["transcript", "sentence", "done"]);
  for (const message of json) expect(message).toMatchObject({ sessionId, turnId });
  const binary = messages.find((m): m is ArrayBuffer => m instanceof ArrayBuffer);
  const decoded = decodeTurnAudioFrame(new Uint8Array(binary!));
  expect(decoded).toMatchObject({ sessionId, turnId });
  expect([...new Uint8Array(decoded!.payload)]).toEqual([...new Uint8Array(wav(4))]);
});

test("ws v2: replacement turns suppress stale output and stay isolated per socket", async () => {
  const base = start({
    onStreamTurn: async (wav, sink) => {
      const n = new Uint8Array(wav)[44]!;
      sink.transcript("turn-" + n);
      if (n === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        // Deliberately ignore sink.aborted(): the transport itself must reject
        // these late emissions after a replacement turn has won.
        sink.sentence("stale-one");
        sink.done();
        return;
      }
      if (n === 3) await new Promise((resolve) => setTimeout(resolve, 10));
      sink.sentence("reply-" + n);
      sink.done();
    },
  });
  const a = await connectV2(base);
  const b = await connectV2(base);
  const seenA: Array<{ type: string; text?: string; turnId?: string }> = [];
  const seenB: Array<{ type: string; text?: string; turnId?: string }> = [];

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("isolated turns timeout")), 3000);
      let replaced = false;
      let doneA = false;
      let doneB = false;
      const finish = () => {
        if (doneA && doneB) { clearTimeout(timer); resolve(); }
      };
      a.ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        seenA.push(message);
        if (message.type === "transcript" && message.turnId === "a-1" && !replaced) {
          replaced = true;
          a.ws.send(encodeTurnAudioFrame(a.sessionId, "a-2", wav(2)));
        }
        if (message.type === "done" && message.turnId === "a-2") { doneA = true; finish(); }
      };
      b.ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        seenB.push(message);
        if (message.type === "done" && message.turnId === "b-1") { doneB = true; finish(); }
      };
      a.ws.onerror = b.ws.onerror = () => { clearTimeout(timer); reject(new Error("isolated socket error")); };
      a.ws.send(encodeTurnAudioFrame(a.sessionId, "a-1", wav(1)));
      b.ws.send(encodeTurnAudioFrame(b.sessionId, "b-1", wav(3)));
    });
    // Give the deliberately late old handler enough time to try emitting.
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    a.ws.close();
    b.ws.close();
  }

  expect(seenA.some((m) => m.text === "stale-one")).toBe(false);
  expect(seenA.some((m) => m.turnId === "a-2" && m.text === "reply-2")).toBe(true);
  expect(seenB.every((m) => m.turnId === "b-1")).toBe(true);
  expect(seenB.some((m) => m.text === "reply-3")).toBe(true);
});

test("ws v2: rejects raw binary, replayed ids, and oversized control frames", async () => {
  const base = start({ onStreamTurn: async (_wav, sink) => sink.done() });
  const { ws, sessionId } = await connectV2(base);
  const errors: Array<{ message: string; turnId: string | null }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("protocol errors timeout")), 3000);
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        if (message.type === "error") errors.push(message);
        if (message.type === "done") {
          ws.send(encodeTurnAudioFrame(sessionId, "same-turn", wav(2)));
          ws.send(JSON.stringify({ type: "text", sessionId, turnId: "large-text", text: "x".repeat(70 * 1024) }));
        }
        if (errors.length === 3) { clearTimeout(timer); resolve(); }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("protocol socket error")); };
      ws.send(new Uint8Array([1, 2, 3]).buffer); // no v2 envelope
      ws.send(encodeTurnAudioFrame(sessionId, "same-turn", wav(1)));
    });
  } finally {
    ws.close();
  }
  expect(errors.map((e) => e.message)).toEqual([
    "binary frame is not a valid protocol-v2 envelope",
    "duplicate or replayed turn id",
    "control frame too large",
  ]);
  expect(errors[1]!.turnId).toBe("same-turn");
});

test("ws: barge-in aborts the in-flight turn and drains the interrupting utterance", async () => {
  let turns = 0;
  const base = start({
    onStreamTurn: async (wav, sink) => {
      turns += 1;
      const n = turns;
      sink.transcript("turn" + n);
      sink.sentence("sentence " + n);
      if (n === 1) {
        // Simulate a long reply: keep going until barge-in flips sink.aborted().
        for (let i = 0; i < 200; i++) {
          if (sink.aborted()) return; // bail WITHOUT done() — this turn was preempted
          await new Promise((r) => setTimeout(r, 5));
        }
        return;
      }
      sink.done(); // only the second (interrupting) turn completes
    },
  });

  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws timeout")), 4000);
    let barged = false;
    ws.onopen = () => ws.send(wav(1));
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      if (m.type === "sentence") seen.push(m.text);
      if (m.type === "sentence" && m.text === "sentence 1" && !barged) {
        barged = true; // talk over turn 1: signal abort, then send the new utterance
        ws.send(JSON.stringify({ type: "abort" }));
        ws.send(wav(2));
      }
      if (m.type === "done") { clearTimeout(timer); ws.close(); resolve(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });

  expect(turns).toBe(2);             // the interrupting utterance was processed, not dropped
  expect(seen).toContain("sentence 1");
  expect(seen).toContain("sentence 2");
});

test("ws: rejects connection without a valid token", async () => {
  const base = start({ onStreamTurn: async () => { /* unused */ } });
  const ok = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=wrong");
    const timer = setTimeout(() => resolve(false), 2000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); }; // opened = bad
    ws.onerror = () => { clearTimeout(timer); resolve(false); };
    ws.onclose = () => { clearTimeout(timer); resolve(false); };
  });
  expect(ok).toBe(false); // 403 → upgrade refused
});

test("ws: caps idle clients before accepting another connection", async () => {
  const base = start({ onStreamTurn: () => Promise.resolve() });
  const sockets: WebSocket[] = [];
  try {
    for (let index = 0; index < MAX_WEB_VOICE_CLIENTS; index++) sockets.push(await connect(base));
    expect(handle?.clientCount()).toBe(MAX_WEB_VOICE_CLIENTS);
    const accepted = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
      const timer = setTimeout(() => { ws.close(); resolve(false); }, 1_000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
      ws.onclose = () => { clearTimeout(timer); resolve(false); };
    });
    expect(accepted).toBe(false);
  } finally {
    for (const ws of sockets) ws.close();
  }
});

test("ws: a saturated pool rejects with 429 + Retry-After and readmits after a close", async () => {
  const base = start({ onStreamTurn: () => Promise.resolve() });
  const sockets: WebSocket[] = [];
  try {
    for (let index = 0; index < MAX_WEB_VOICE_CLIENTS; index++) sockets.push(await connect(base));
    expect(handle?.clientCount()).toBe(MAX_WEB_VOICE_CLIENTS);
    // The admission gate runs before the upgrade attempt, so a plain GET to
    // /ws surfaces the exact rejection the browser's WebSocket API hides.
    const rejected = await fetch(base + "/ws?token=" + TOKEN);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("5");
    expect(await rejected.text()).toBe("too many voice clients");
    // Freeing one slot readmits the next client.
    sockets.pop()?.close();
    const deadline = Date.now() + 2_000;
    while ((handle?.clientCount() ?? 0) >= MAX_WEB_VOICE_CLIENTS && Date.now() < deadline) await Bun.sleep(5);
    expect(handle?.clientCount()).toBe(MAX_WEB_VOICE_CLIENTS - 1);
    sockets.push(await connect(base));
    expect(handle?.clientCount()).toBe(MAX_WEB_VOICE_CLIENTS);
  } finally {
    for (const ws of sockets) ws.close();
  }
});

test("PWA manifest and icon need no token", async () => {
  const base = start();
  const manifest = await fetch(base + "/manifest.webmanifest");
  expect(manifest.status).toBe(200);
  const manifestBody = (await manifest.json()) as { short_name: string; start_url: string };
  expect(manifestBody.short_name).toBe("Cicero");
  expect(manifestBody.start_url).toBe("/app");
  const app = await fetch(base + "/app");
  expect(app.status).toBe(200);
  const appText = await app.text();
  expect(appText).toContain("authorization required");
  expect(appText).not.toContain("missing ?token= in URL");
  const icon = await fetch(base + "/icon.svg");
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
});

test("POST /api/notify renders and broadcasts to connected ws clients", async () => {
  let rendered = "";
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async (text) => { rendered = text; return wav(7); },
  });

  // Connect a voice client, then push a notification through the HTTP surface.
  const got = await new Promise<{ type: string; text: string; audioBase64: string }>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("notify timeout")), 3000);
    ws.onopen = async () => {
      const res = await fetch(base + "/api/notify", {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "PR 142 is up." }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { delivered: number }).delivered).toBe(1);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      clearTimeout(timer); ws.close(); resolve(JSON.parse(e.data));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });

  expect(rendered).toBe("PR 142 is up.");
  expect(got.type).toBe("notify");
  expect(got.text).toBe("PR 142 is up.");
  expect(got.audioBase64).toBe(Buffer.from(wav(7)).toString("base64"));
});

test("onNotified fires when a notification parks (no client connected)", async () => {
  const seen: Array<{ text: string; delivered: number; parked: boolean }> = [];
  const base = start({
    onNotify: async () => wav(5),
    onNotified: (text, outcome) => seen.push({ text, ...outcome }),
  });
  const res = await fetch(base + "/api/notify", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Fork sync failed, needs a decision." }),
  });
  expect(res.status).toBe(200);
  expect(seen).toEqual([{ text: "Fork sync failed, needs a decision.", delivered: 0, parked: true }]);
});

test("onNotified fires on broadcast delivery with the client count", async () => {
  const seen: Array<{ delivered: number; parked: boolean }> = [];
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async () => wav(5),
    onNotified: (_text, outcome) => seen.push(outcome),
  });
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("notify timeout")), 3000);
    ws.onopen = async () => {
      await fetch(base + "/api/notify", {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "PR 142 is up." }),
      });
    };
    ws.onmessage = () => { clearTimeout(timer); ws.close(); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(seen).toEqual([{ delivered: 1, parked: false }]);
});

test("onNotified does NOT fire when the daemon defers the notification (quiet hours)", async () => {
  let called = 0;
  const base = start({
    onNotify: async () => null, // daemon signals quiet-hours deferral
    onNotified: () => { called += 1; },
  });
  const res = await fetch(base + "/api/notify", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "late night news" }),
  });
  expect(res.status).toBe(200);
  expect(called).toBe(0);
});

test("a throwing onNotified hook does not fail the delivery", async () => {
  const base = start({
    onNotify: async () => wav(5),
    onNotified: () => { throw new Error("brain unavailable"); },
  });
  const res = await fetch(base + "/api/notify", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "still delivered" }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { parked: boolean }).parked).toBe(true);
});

test("an async-rejecting onNotified hook does not fail the delivery", async () => {
  const base = start({
    onNotify: async () => wav(5),
    onNotified: async () => { throw new Error("brain went away mid-hook"); },
  });
  const res = await fetch(base + "/api/notify", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "still delivered async" }),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { parked: boolean }).parked).toBe(true);
  // Let the rejected hook promise settle; an unhandled rejection here fails the run.
  await new Promise((r) => setTimeout(r, 10));
});

test("/api/notify without onNotify is a 501; bad bodies are 400s; token required", async () => {
  const bare = start(); // no onNotify
  const auth = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  expect((await fetch(bare + "/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ text: "x" }) })).status).toBe(501);

  await handle?.stop();
  const base = start({ onNotify: async () => new ArrayBuffer(1) });
  expect((await fetch(base + "/api/notify", { method: "POST", headers: auth, body: "not json" })).status).toBe(400);
  expect((await fetch(base + "/api/notify", { method: "POST", headers: auth, body: JSON.stringify({}) })).status).toBe(400);
  expect((await fetch(base + "/api/notify", { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(403);
});

test("ws: recent history is pushed to a freshly connected client", async () => {
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onHistory: async () => [{ t: 1, user: "hello", reply: "Hi." }],
  });
  const got = await new Promise<{ type: string; items: Array<{ user: string }> }>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("history timeout")), 3000);
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      clearTimeout(timer); ws.close(); resolve(JSON.parse(e.data));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(got.type).toBe("history");
  expect(got.items[0].user).toBe("hello");
});

test("notify with no client connected is parked and delivered to the next connection", async () => {
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async () => wav(5),
  });
  const auth = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };

  // Nobody connected yet — the notification parks instead of dropping.
  const res = await fetch(base + "/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ text: "while you were out" }) });
  expect(await res.json()).toEqual({ delivered: 0, parked: true });

  // First client to connect gets it.
  const got = await new Promise<{ type: string; text: string }>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("parked notify timeout")), 3000);
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      clearTimeout(timer); ws.close(); resolve(JSON.parse(e.data));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(got.type).toBe("notify");
  expect(got.text).toBe("while you were out");

  // …and it's not replayed to a second client.
  const second = await new Promise<string | null>((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => { ws.close(); resolve(null); }, 500);
    ws.onmessage = (e: MessageEvent) => { clearTimeout(timer); ws.close(); resolve(typeof e.data === "string" ? e.data : "binary"); };
  });
  expect(second).toBeNull();
});

test("parked notifications are capped at 10, oldest dropped", async () => {
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async () => new ArrayBuffer(0),
  });
  const auth = { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  for (let i = 0; i < 12; i++) {
    await fetch(base + "/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ text: "n" + i }) });
  }
  const texts = await new Promise<string[]>((resolve, reject) => {
    const out: string[] = [];
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => { ws.close(); resolve(out); }, 800);
    ws.onmessage = (e: MessageEvent) => { if (typeof e.data === "string") out.push(JSON.parse(e.data).text); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(texts.length).toBe(10);
  expect(texts[0]).toBe("n2");   // n0/n1 fell off the front
  expect(texts[9]).toBe("n11");
});

test("a wrong token is rejected", async () => {
  const base = start();
  const res = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
    body: new ArrayBuffer(8),
  });
  expect(res.status).toBe(403);
  expect(res.headers.get("connection")).toBe("close");
});

test("ws: a typed {type:'text'} frame runs the text turn and streams the reply", async () => {
  let got = "";
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onTextTurn: async (text, sink) => {
      got = text;
      sink.transcript(text);
      sink.sentence("Typed reply.");
      sink.audio(wav(7));
      sink.done();
    },
  });
  const msgs: Array<string | ArrayBuffer> = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "text", text: "  hello from keyboard " }));
    ws.onmessage = (e: MessageEvent) => {
      msgs.push(e.data);
      if (typeof e.data === "string" && JSON.parse(e.data).type === "done") { clearTimeout(timer); ws.close(); resolve(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(got).toBe("hello from keyboard");
  expect(JSON.parse(msgs[0] as string)).toEqual({ type: "transcript", text: "hello from keyboard" });
  expect(JSON.parse(msgs[1] as string)).toEqual({ type: "sentence", text: "Typed reply." });
  expect(msgs[2] instanceof ArrayBuffer).toBe(true);
  expect(JSON.parse(msgs[3] as string)).toEqual({ type: "done" });
});

test("ws: typed frame without onTextTurn reports 'typed input not available'", async () => {
  const base = start({ onStreamTurn: async () => { /* unused */ } });
  const reply = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws?token=" + TOKEN);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "text", text: "hi" }));
    ws.onmessage = (e: MessageEvent) => { clearTimeout(timer); ws.close(); resolve(String(e.data)); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(JSON.parse(reply)).toEqual({ type: "error", message: "typed input not available" });
});

test("handle.notify() broadcasts like POST /api/notify and parks when nobody's connected", async () => {
  start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async () => wav(3),
  });
  const h = handle!;
  // Nobody connected → parked.
  const first = await h.notify("build finished");
  expect(first).toEqual({ delivered: 0, parked: true });
  // A client connects: gets the parked one, then a live broadcast.
  const got: string[] = [];
  const base = `ws://127.0.0.1:${h.port}/ws?token=${TOKEN}`;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(base);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 3000);
    ws.onmessage = async (e: MessageEvent) => {
      got.push(String(e.data));
      if (got.length === 1) {
        const second = await h.notify("tests passed");
        expect(second).toEqual({ delivered: 1, parked: false });
      }
      if (got.length === 2) { clearTimeout(timer); ws.close(); resolve(); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
  expect(JSON.parse(got[0]).text).toBe("build finished");
  expect(JSON.parse(got[1]).text).toBe("tests passed");
});

test("handle.notify() resolves null when no onNotify is configured", async () => {
  start({ onStreamTurn: async () => { /* unused */ } });
  expect(await handle!.notify("hello")).toBeNull();
});

test("handle.notify() forwards telegramMirror to onNotify (the morning-briefing digest path)", async () => {
  // The briefing texts its own Telegram digest and speaks flat prose through
  // notify(); the mirror suppression must reach the daemon's fan-out or the
  // spoken rendering double-delivers (seen live 2026-07-12).
  const seen: Array<boolean | undefined> = [];
  start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async (_text, _voice, opts) => { seen.push(opts?.telegramMirror); return wav(1); },
  });
  await handle!.notify("morning briefing", undefined, { telegramMirror: false });
  await handle!.notify("kanban done");
  expect(seen).toEqual([false, undefined]);
});

test("/api/say renders text to WAV without broadcasting; 501/400 guarded", async () => {
  let notified = 0;
  let said = 0;
  const base = start({
    onStreamTurn: async () => { /* unused */ },
    onNotify: async () => { notified++; return wav(1); },
    onSay: async () => { said++; return wav(2); },
  });
  const res = await fetch(base + "/api/say", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello caller" }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("audio/wav");
  expect((await res.arrayBuffer()).byteLength).toBe(wav(2).byteLength);
  expect(said).toBe(1);
  expect(notified).toBe(0); // say is render-only — never fans out to notify channels
  const bad = await fetch(base + "/api/say", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(bad.status).toBe(400);
  const noHandler = start({ onStreamTurn: async () => { /* unused */ } });
  const r501 = await fetch(noHandler + "/api/say", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x" }),
  });
  expect(r501.status).toBe(501);
});

test("?record=0 marks the socket as a test harness (turns not persisted)", async () => {
  const seen: (boolean | undefined)[] = [];
  const handle = startWebVoiceServer({
    port: 0,
    token: "tok",
    onTextTurn: async (_t, sink, opts) => { seen.push(opts?.record); sink.done(); },
  });
  if (!handle) throw new Error("server failed to start");
  try {
    for (const [qs, expected] of [["&record=0", false], ["", true]] as const) {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=tok${qs}`);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.send(JSON.stringify({ type: "text", text: "hi" }));
      await new Promise((res) => { ws.onmessage = (e) => { if (JSON.parse(String(e.data)).type === "done") res(null); }; });
      ws.close();
      expect(seen.at(-1)).toBe(expected);
    }
  } finally {
    await handle.stop();
  }
});

test("POST /api/health validates rows, normalizes metrics, and reports logged/skipped", async () => {
  const received: Array<{ metric: string; value?: number; unit?: string; note?: string }> = [];
  const base = start({ onHealth: async (rows) => { received.push(...rows); return rows.length; } });

  // no handler counterpart: single object and array both accepted; junk rows skipped
  const res = await fetch(base + "/api/health?token=" + TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { metric: "Weight", value: 82.4, unit: "kg" },
      { metric: "food", note: "chicken bowl", value: 650 },
      { metric: "", value: 1 },              // no metric → skipped
      { metric: "mood" },                    // neither value nor note → skipped
      { metric: "sleep", value: "eight" },   // non-numeric value → skipped
    ]),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ logged: 2, skipped: 3 });
  expect(received).toEqual([
    { metric: "weight", value: 82.4, unit: "kg", note: undefined },
    { metric: "food", value: 650, unit: undefined, note: "chicken bowl" },
  ]);

  const single = await fetch(base + "/api/health?token=" + TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metric: "weight", value: 81.9 }),
  });
  expect((await single.json() as { logged: number }).logged).toBe(1);
});

test("POST /api/health: 403 without token, 400 on garbage, 501 without a handler", async () => {
  const base = start({ onHealth: async () => 0 });
  expect((await fetch(base + "/api/health", { method: "POST", body: "{}" })).status).toBe(403);
  expect((await fetch(base + "/api/health?token=" + TOKEN, { method: "POST", body: "not json" })).status).toBe(400);
  expect((await fetch(base + "/api/health?token=" + TOKEN, { method: "POST", body: JSON.stringify({ metric: "mood" }) })).status).toBe(400);
  await handle?.stop();
  const bare = start({});
  expect((await fetch(bare + "/api/health?token=" + TOKEN, { method: "POST", body: JSON.stringify({ metric: "weight", value: 1 }) })).status).toBe(501);
});

test("stop quiesces direct ingress, aborts an active HTTP job, and waits for its handler", async () => {
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  let notifyCalls = 0;
  const base = start({
    onChat: (_text, options) => {
      signal = options?.signal;
      started.resolve();
      return release.promise.then(() => "finished");
    },
    onNotify: () => {
      notifyCalls += 1;
      return Promise.resolve(new ArrayBuffer(0));
    },
  });
  const activeHandle = handle!;
  const request = fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hold this turn" }),
  }).then((response) => response.status).catch(() => 0);
  await started.promise;

  const stopping = activeHandle.stop();
  let stopSettled = false;
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );

  expect(signal?.aborted).toBe(true);
  expect(await activeHandle.notify("must not start")).toBeNull();
  expect(notifyCalls).toBe(0);
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);

  release.resolve();
  await stopping;
  await request;
  expect(stopSettled).toBe(true);
  await expect(activeHandle.stop()).resolves.toBeUndefined();
});

test("a shutdown drain timeout is visible and a later stop retries the unfinished drain", async () => {
  const started = deferred();
  const release = deferred();
  const base = start({
    shutdownDrainTimeoutMs: 20,
    onChat: () => {
      started.resolve();
      return release.promise.then(() => "late reply");
    },
  });
  const activeHandle = handle!;
  const request = fetch(base + "/api/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "ignore cancellation briefly" }),
  }).catch(() => null);
  await started.promise;

  await expect(activeHandle.stop()).rejects.toThrow("did not drain within 20ms");
  release.resolve();
  await request;
  await expect(activeHandle.stop()).resolves.toBeUndefined();
});

test("stop cancels and drains an active WebSocket turn before resolving", async () => {
  const started = deferred();
  const release = deferred();
  let signal: AbortSignal | undefined;
  const base = start({
    onTextTurn: (_text, sink, options) => {
      signal = options?.signal;
      started.resolve();
      return release.promise.then(() => { sink.done(); });
    },
  });
  const activeHandle = handle!;
  const ws = await connect(base);
  const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
  ws.send(JSON.stringify({ type: "text", text: "keep this open" }));
  await started.promise;

  const stopping = activeHandle.stop();
  expect(signal?.aborted).toBe(true);
  await closed;
  let stopSettled = false;
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);

  release.resolve();
  await stopping;
  expect(stopSettled).toBe(true);
});

test("a successful adopted turn drains speculative provider cleanup before releasing the job", async () => {
  const created = deferred();
  const handlerReturned = deferred();
  const abortStarted = deferred();
  const abortRelease = deferred();
  let abortCalls = 0;
  const spec: SpeculativeTurn = {
    claim: () => true,
    coverageOk: () => true,
    transcript: () => Promise.resolve("local fast path"),
    tokens: () => null,
    abort: () => {
      abortCalls += 1;
      abortStarted.resolve();
      return abortRelease.promise;
    },
  };
  const base = start({
    onTurnProbe: () => Promise.resolve({ complete: true, probability: 0.99 }),
    onSpeculate: () => {
      created.resolve();
      return spec;
    },
    onStreamTurn: async (_wav, sink, options) => {
      expect(options?.spec?.claim()).toBe(true);
      expect(await options?.spec?.transcript()).toBe("local fast path");
      sink.done();
      handlerReturned.resolve();
    },
  });
  const activeHandle = handle!;
  const ws = await connect(base);
  ws.send(encodeProbeFrame(new Float32Array([0.1, -0.1]), 16_000, 100));
  await created.promise;
  ws.send(wav(1, 100));
  await handlerReturned.promise;
  await abortStarted.promise;

  const stopping = activeHandle.stop();
  let stopSettled = false;
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);
  expect(abortCalls).toBe(1);

  abortRelease.resolve();
  await stopping;
  expect(stopSettled).toBe(true);
});

test("stop owns and awaits an unclaimed speculative turn after its socket closes", async () => {
  const created = deferred();
  const abortStarted = deferred();
  const abortRelease = deferred();
  let abortCalls = 0;
  const spec: SpeculativeTurn = {
    claim: () => false,
    coverageOk: () => false,
    transcript: () => Promise.resolve(null),
    tokens: () => null,
    abort: () => {
      abortCalls += 1;
      abortStarted.resolve();
      return abortRelease.promise;
    },
  };
  const base = start({
    onTurnProbe: () => Promise.resolve({ complete: true, probability: 0.99 }),
    onSpeculate: () => {
      created.resolve();
      return spec;
    },
  });
  const activeHandle = handle!;
  const ws = await connect(base);
  ws.send(encodeProbeFrame(new Float32Array([0.1, -0.1]), 16_000, 100));
  await created.promise;

  const stopping = activeHandle.stop();
  await abortStarted.promise;
  let stopSettled = false;
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);
  expect(abortCalls).toBe(1);

  abortRelease.resolve();
  await stopping;
  expect(stopSettled).toBe(true);
});

test("a failed speculative cleanup remains owned and is retried by a later stop", async () => {
  try {
    const created = deferred();
    let abortCalls = 0;
    const spec: SpeculativeTurn = {
      claim: () => false,
      coverageOk: () => false,
      transcript: () => Promise.resolve(null),
      tokens: () => null,
      abort: () => {
        abortCalls += 1;
        return abortCalls === 1
          ? Promise.reject(new Error("first speculative cleanup failed"))
          : Promise.resolve();
      },
    };
    const base = start({
      onTurnProbe: () => Promise.resolve({ complete: true, probability: 0.99 }),
      onSpeculate: () => {
        created.resolve();
        return spec;
      },
    });
    const activeHandle = handle!;
    const ws = await connect(base);
    ws.send(encodeProbeFrame(new Float32Array([0.1, -0.1]), 16_000, 100));
    await created.promise;

    await expect(activeHandle.stop()).rejects.toThrow("first speculative cleanup failed");
    expect(abortCalls).toBe(1);
    await expect(activeHandle.stop()).resolves.toBeUndefined();
    expect(abortCalls).toBe(2);
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});

test("stop drains work deliberately detached by a parked WebSocket turn", async () => {
  const backgroundStarted = deferred();
  const backgroundRelease = deferred();
  const base = start({
    onTextTurn: (_text, sink, options) => {
      options?.trackBackground?.(backgroundRelease.promise);
      backgroundStarted.resolve();
      sink.done();
      return Promise.resolve();
    },
  });
  const activeHandle = handle!;
  const ws = await connect(base);
  ws.send(JSON.stringify({ type: "text", text: "park this" }));
  await backgroundStarted.promise;
  await Bun.sleep(0);

  const stopping = activeHandle.stop();
  let stopSettled = false;
  void stopping.then(
    () => { stopSettled = true; },
    () => { stopSettled = true; },
  );
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);

  backgroundRelease.resolve();
  await stopping;
  expect(stopSettled).toBe(true);
});

test("stop drains background work retained by an HTTP turn", async () => {
  const release = deferred();
  let tracked = false;
  const base = start({
    onTurn: async (_wav, options) => {
      try {
        tracked = options?.trackBackground?.(release.promise) ?? false;
        return { transcript: "heard", reply: "done", audio: new ArrayBuffer(0) };
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  const activeHandle = handle!;
  const response = await fetch(base + "/api/turn", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: wav(1),
  });
  expect(response.status).toBe(200);
  expect(tracked).toBe(true);

  let stopSettled = false;
  const stopping = activeHandle.stop().then(() => { stopSettled = true; });
  await Bun.sleep(10);
  expect(stopSettled).toBe(false);
  release.resolve();
  await stopping;
  expect(stopSettled).toBe(true);
});

test("parked background work shares the global admission cap with new turns", async () => {
  const releases: Array<() => void> = [];
  const tracked: boolean[] = [];
  const base = start({
    onTextTurn: (_text, sink, options) => {
      let release!: () => void;
      const task = new Promise<void>((resolve) => { release = resolve; });
      releases.push(release);
      tracked.push(options?.trackBackground?.(task) ?? false);
      sink.done();
      return Promise.resolve();
    },
  });
  const ws = await connect(base);
  const sendTurn = (text: string): Promise<{ type: string; message?: string }> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("background-cap response timeout")), 3_000);
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { type: string; message?: string };
      if (message.type !== "done" && message.type !== "error") return;
      clearTimeout(timer);
      resolve(message);
    };
    ws.send(JSON.stringify({ type: "text", text }));
  });

  try {
    for (let index = 0; index < MAX_CONCURRENT_WEB_JOBS; index++) {
      expect((await sendTurn(`park ${index}`)).type).toBe("done");
    }
    expect(tracked).toEqual(Array.from({ length: MAX_CONCURRENT_WEB_JOBS }, () => true));
    const overflow = await sendTurn("one too many");
    expect(overflow.type).toBe("error");
    expect(overflow.message).toContain("server busy");
  } finally {
    for (const release of releases) release();
    ws.close();
  }
});

test("/vad serves only whitelisted, present assets — unauthenticated, immutable", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = `${tmpdir()}/cicero-vad-test-${Date.now().toString(36)}`;
  await mkdir(dir, { recursive: true });
  try {
    const base = start({ vadDir: dir });
    // present asset must match the manifest byte size exactly
    const { VAD_ASSETS } = await import("../../src/web-voice/vad-assets");
    const asset = VAD_ASSETS.find((a) => a.name === "ort.wasm.min.js")!;
    // missing file → 404
    expect((await fetch(`${base}/vad/${asset.name}`)).status).toBe(404);
    // wrong size on disk → 404 (a partial download must never be served)
    await Bun.write(`${dir}/${asset.name}`, "x");
    expect((await fetch(`${base}/vad/${asset.name}`)).status).toBe(404);
    // exact size → 200 with the manifest content type, no token required
    await Bun.write(`${dir}/${asset.name}`, "x".repeat(asset.bytes));
    const ok = await fetch(`${base}/vad/${asset.name}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("javascript");
    expect(ok.headers.get("cache-control")).toContain("immutable");
    // traversal / unknown names → never served (encoded dots reach the route
    // and miss the whitelist; a raw ".." is normalized away client-side)
    expect((await fetch(`${base}/vad/%2E%2E%2Fpage.ts`)).status).toBe(404);
    expect((await fetch(`${base}/vad/../${asset.name}`)).status).not.toBe(200);
    expect((await fetch(`${base}/vad/evil.wasm`)).status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/vad without a configured directory stays 404", async () => {
  const base = start({});
  expect((await fetch(`${base}/vad/ort.wasm.min.js`)).status).toBe(404);
});
