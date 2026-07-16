import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTelegramUpdate,
  sendTelegramConfirmation,
  sendTelegramText,
  sendTelegramVoice,
  telegramToken,
  wavToOggOpus,
} from "../../src/notify/telegram";
import type { Brain } from "../../src/types";

const hasFfmpeg = Bun.which("ffmpeg") !== null;
const AUTHORIZED_USER_ID = 42;
const GATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GATE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fakeFfmpeg(directory: string, body: string): string {
  const path = join(directory, "fake-ffmpeg");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function minimalOggOpusPage(): Uint8Array {
  const bytes = new Uint8Array(36);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  bytes[4] = 0; // stream structure version
  bytes[5] = 0x02; // beginning of stream
  bytes[26] = 1; // one lacing value
  bytes[27] = 8; // eight-byte identification payload
  bytes.set(new TextEncoder().encode("OpusHead"), 28);
  return bytes;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

type JsonObject = Record<string, unknown>;
type CapturedCall = { path: string; body: JsonObject };

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return value as JsonObject;
}

function privateMessage(
  messageId: number,
  text: string,
  chatId: string | number = 42,
  senderId: string | number = AUTHORIZED_USER_ID,
) {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "private" as const },
    from: { id: senderId },
    text,
  };
}

function groupMessage(
  messageId: number,
  text: string,
  chatId: string | number,
  senderId: string | number,
) {
  return {
    message_id: messageId,
    chat: { id: chatId, type: "supergroup" as const },
    from: { id: senderId },
    text,
  };
}

/** Minimal valid 16kHz mono PCM WAV with 0.2s of silence. */
function fixtureWav(): ArrayBuffer {
  const sampleRate = 16000;
  const samples = Math.floor(sampleRate * 0.2);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(dataSize + 36, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("telegramToken resolves literal, env var, and absence", () => {
  expect(telegramToken({ token: "abc" })).toBe("abc");
  process.env.CICERO_TG_TEST_TOKEN = "from-env";
  expect(telegramToken({ token_env: "CICERO_TG_TEST_TOKEN" })).toBe("from-env");
  delete process.env.CICERO_TG_TEST_TOKEN;
  expect(telegramToken({ token_env: "CICERO_TG_TEST_TOKEN" })).toBeNull();
});

test("send is a silent no-op without token or chat_id", async () => {
  expect(await sendTelegramVoice({}, "hi", fixtureWav())).toBe(false);
  expect(await sendTelegramVoice({ token: "t" }, "hi", fixtureWav())).toBe(false);
});

test.skipIf(!hasFfmpeg)("wavToOggOpus produces an OGG stream", async () => {
  const ogg = await wavToOggOpus(fixtureWav());
  expect(ogg.byteLength).toBeGreaterThan(0);
  expect(String.fromCharCode(...ogg.slice(0, 4))).toBe("OggS");
});

test.skipIf(process.platform === "win32")("wavToOggOpus owns bounded stdin and validates the output envelope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cicero-telegram-ffmpeg-"));
  const fixture = join(directory, "fixture.ogg");
  writeFileSync(fixture, minimalOggOpusPage());
  const ffmpeg = fakeFfmpeg(
    directory,
    `cat >/dev/null; for last do :; done; cp ${shellQuote(fixture)} "$last"`,
  );
  try {
    const wav = fixtureWav();
    const ogg = await wavToOggOpus(wav, {
      ffmpegBinary: ffmpeg,
      timeoutMs: 1_000,
      inputLimitBytes: wav.byteLength,
      outputLimitBytes: 64,
    });
    expect(ogg).toEqual(minimalOggOpusPage());

    await expect(wavToOggOpus(wav, {
      ffmpegBinary: ffmpeg,
      inputLimitBytes: wav.byteLength - 1,
    })).rejects.toThrow(`${wav.byteLength - 1}-byte input limit`);

    await expect(wavToOggOpus(wav, {
      ffmpegBinary: ffmpeg,
      outputLimitBytes: 4,
    })).rejects.toThrow("output exceeded 4 bytes");

    fakeFfmpeg(directory, 'cat >/dev/null; for last do :; done; printf "OggSfixture" > "$last"');
    await expect(wavToOggOpus(wav, { ffmpegBinary: ffmpeg }))
      .rejects.toThrow("not a complete OGG/Opus stream");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("wavToOggOpus terminates a hung converter at its wall deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cicero-telegram-ffmpeg-timeout-"));
  const ffmpeg = fakeFfmpeg(directory, "trap '' TERM; while :; do :; done");
  try {
    await expect(wavToOggOpus(fixtureWav(), { ffmpegBinary: ffmpeg, timeoutMs: 20 }))
      .rejects.toThrow("20ms wall deadline");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(!hasFfmpeg)("sendVoice posts multipart to the bot API and reports success", async () => {
  let gotPath = "";
  let gotChat = "";
  let gotCaption = "";
  let voiceBytes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      gotPath = url.pathname;
      const form = await req.formData();
      gotChat = String(form.get("chat_id"));
      gotCaption = String(form.get("caption"));
      const voice = form.get("voice");
      if (voice instanceof Blob) voiceBytes = voice.size;
      return Response.json({ ok: true });
    },
  });
  try {
    const ok = await sendTelegramVoice(
      { token: "SECRET", chat_id: 42 },
      "PR 142 is up.",
      fixtureWav(),
      `http://127.0.0.1:${server.port}`,
    );
    expect(ok).toBe(true);
    expect(gotPath).toBe("/botSECRET/sendVoice");
    expect(gotChat).toBe("42");
    expect(gotCaption).toBe("PR 142 is up.");
    expect(voiceBytes).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test.skipIf(!hasFfmpeg)("a bot API error is swallowed and reported as false", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: false, description: "chat not found" }, { status: 400 }),
  });
  try {
    const ok = await sendTelegramVoice(
      { token: "SECRET", chat_id: 1 },
      "hello",
      fixtureWav(),
      `http://127.0.0.1:${server.port}`,
    );
    expect(ok).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("sendTelegramText posts a plain message, no ffmpeg involved", async () => {
  let captured: CapturedCall | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      captured = { path: new URL(req.url).pathname, body: jsonObject(await req.json()) };
      return Response.json({ ok: true });
    },
  });
  const ok = await sendTelegramText({ token: "tok", chat_id: 42 }, "PR is up.", `http://localhost:${server.port}`);
  server.stop();
  expect(ok).toBe(true);
  expect(captured.path).toBe("/bottok/sendMessage");
  expect(captured.body).toEqual({ chat_id: "42", text: "PR is up." });
});

test("sendTelegramText without token or chat_id is a quiet no-op", async () => {
  expect(await sendTelegramText({ chat_id: 42 }, "x")).toBe(false);
  expect(await sendTelegramText({ token: "tok" }, "x")).toBe(false);
});

test("sendTelegramText combines an external abort with its request deadline", async () => {
  let requestStarted = false;
  let requestAborted = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    requestStarted = true;
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      requestAborted = true;
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  const controller = new AbortController();
  try {
    const sending = sendTelegramText(
      { token: "tok", chat_id: 42 },
      "briefing",
      "http://telegram.test",
      {},
      controller.signal,
    );
    await waitFor(() => requestStarted);
    controller.abort(new Error("briefing stopped"));
    expect(await sending).toBe(false);
    await waitFor(() => requestAborted);
    expect(requestAborted).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function confirmationBrain(pending = true, nonce = GATE_A): Brain {
  return {
    start: async () => {},
    stop: async () => {},
    send: async () => "",
    injectContext: () => {},
    restart: async () => {},
    health: async () => true,
    hasPendingConfirmation: () => pending,
    pendingConfirmations: () => pending ? [{ nonce, summary: "guarded operation" }] : [],
    resolvePendingConfirmation: (_approved: boolean, suppliedNonce: string) => {
      if (!pending || suppliedNonce !== nonce) return false;
      pending = false;
      return true;
    },
  };
}

test("sendTelegramConfirmation posts an inline approve/deny keyboard", async () => {
  let captured: CapturedCall | null = null;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      captured = { path: new URL(req.url).pathname, body: jsonObject(await req.json()) };
      return Response.json({ ok: true, result: { message_id: 123 } });
    },
  });
  const ok = await sendTelegramConfirmation({ token: "tok", chat_id: 42 }, "Allow git push?", GATE_A, `http://localhost:${server.port}`);
  server.stop();
  expect(ok).toBe(true);
  expect(captured.path).toBe("/bottok/sendMessage");
  expect(captured.body.chat_id).toBe("42");
  expect(captured.body.text).toBe("Allow git push?");
  expect(captured.body.reply_markup.inline_keyboard).toEqual([[
    { text: "✅ Approve", callback_data: `cicero:confirm:yes:${GATE_A}` },
    { text: "❌ Deny", callback_data: `cicero:confirm:no:${GATE_A}` },
  ]]);
});

test("sendTelegramConfirmation rejects a malformed capability before sending", async () => {
  expect(await sendTelegramConfirmation(
    { token: "tok", chat_id: 42 },
    "Allow git push?",
    "7",
    "http://localhost:9",
  )).toBe(false);
});

test("a stale button from an earlier gate cannot resolve a newer one", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const brain = confirmationBrain(true, GATE_B);
  const handled = await handleTelegramUpdate({
    callback_query: {
      id: "cb-old",
      from: { id: AUTHORIZED_USER_ID },
      data: `cicero:confirm:yes:${GATE_A}`,
      message: privateMessage(8, "Allow rm -rf?"),
    },
  }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`);
  server.stop();
  expect(handled).toBe(true);
  expect(calls.map((c) => c.path)).toEqual(["/bottok/answerCallbackQuery"]);
  expect(calls[0].body.text).toBe("nothing pending");
  expect(brain.hasPendingConfirmation?.()).toBe(true); // gate #2 untouched
});

test("confirmation callback resolves the pending gate, answers spinner, and edits the message", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const handled = await handleTelegramUpdate({
    callback_query: {
      id: "cb1",
      from: { id: AUTHORIZED_USER_ID },
      data: `cicero:confirm:yes:${GATE_A}`,
      message: privateMessage(9, "Allow git push?"),
    },
  }, confirmationBrain(), { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`);
  server.stop();
  expect(handled).toBe(true);
  expect(calls.map((c) => c.path)).toEqual(["/bottok/answerCallbackQuery", "/bottok/editMessageText"]);
  expect(calls[0].body).toEqual({ callback_query_id: "cb1", text: "Approved" });
  expect(calls[1].body).toEqual({ chat_id: "42", message_id: 9, text: "✅ Approved" });
});

test("expired confirmation callback is a no-op and tells Telegram nothing is pending", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const handled = await handleTelegramUpdate({
    callback_query: {
      id: "cb1",
      from: { id: AUTHORIZED_USER_ID },
      data: `cicero:confirm:no:${GATE_A}`,
      message: privateMessage(9, "Allow git push?"),
    },
  }, confirmationBrain(false), { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`);
  server.stop();
  expect(handled).toBe(true);
  expect(calls.map((c) => c.path)).toEqual(["/bottok/answerCallbackQuery"]);
  expect(calls[0].body).toEqual({ callback_query_id: "cb1", text: "nothing pending" });
});

test("legacy private-chat config infers the sender safely and fails closed on incomplete metadata", async () => {
  const asked: string[] = [];
  const brain = confirmationBrain(false);
  const handlers = { onChat: async (text: string) => { asked.push(text); return "ok"; } };
  const cfg = { token: "tok", chat_id: 42 };

  expect(await handleTelegramUpdate({
    message: { message_id: 1, chat: { id: 42, type: "private" }, text: "missing sender" },
  }, brain, cfg, "http://localhost:9", handlers)).toBe(false);
  expect(await handleTelegramUpdate({
    message: privateMessage(2, "wrong sender", 42, 99),
  }, brain, cfg, "http://localhost:9", handlers)).toBe(false);
  expect(await handleTelegramUpdate({
    message: { ...privateMessage(3, "missing chat type"), chat: { id: 42 } },
  }, brain, cfg, "http://localhost:9", handlers)).toBe(false);
  expect(await handleTelegramUpdate({
    message: groupMessage(4, "group member", -1001, 42),
  }, brain, { token: "tok", chat_id: -1001 }, "http://localhost:9", handlers)).toBe(false);
  expect(asked).toEqual([]);
});

test("id-less legacy confirmation callbacks are rejected without resolving the gate", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  try {
    const brain = confirmationBrain();
    expect(await handleTelegramUpdate({
      callback_query: {
        id: "legacy",
        from: { id: AUTHORIZED_USER_ID },
        data: "cicero:confirm:yes",
        message: privateMessage(9, "Allow git push?"),
      },
    }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(["/bottok/answerCallbackQuery"]);
    expect(calls[0].body).toEqual({ callback_query_id: "legacy", text: "invalid approval" });
    expect(brain.hasPendingConfirmation?.()).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("group commands require the configured sender_user_id in addition to chat_id", async () => {
  const sent: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      try {
        sent.push(String(jsonObject(await req.json()).text ?? ""));
        return Response.json({ ok: true });
      } catch (err: unknown) {
        return Response.json({ ok: false, description: String(err) }, { status: 400 });
      }
    },
  });
  try {
    const asked: string[] = [];
    const cfg = { token: "tok", chat_id: -1001, sender_user_id: 42 };
    const handlers = { onChat: async (text: string) => { asked.push(text); return "authorized"; } };
    expect(await handleTelegramUpdate({
      message: groupMessage(1, "attacker", -1001, 99),
    }, confirmationBrain(false), cfg, `http://localhost:${server.port}`, handlers)).toBe(false);
    expect(await handleTelegramUpdate({
      message: groupMessage(2, "owner", -1001, 42),
    }, confirmationBrain(false), cfg, `http://localhost:${server.port}`, handlers)).toBe(true);
    expect(asked).toEqual(["owner"]);
    expect(sent).toEqual(["authorized"]);
  } finally {
    server.stop(true);
  }
});

test("confirmation callbacks authenticate callback_query.from before resolving a gate", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      try {
        calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
        return Response.json({ ok: true });
      } catch (err: unknown) {
        return Response.json({ ok: false, description: String(err) }, { status: 400 });
      }
    },
  });
  try {
    const brain = confirmationBrain();
    const cfg = { token: "tok", chat_id: -1001, sender_user_id: 42 };
    const message = groupMessage(9, "Allow git push?", -1001, 777);
    expect(await handleTelegramUpdate({
      callback_query: { id: "attacker", from: { id: 99 }, data: `cicero:confirm:yes:${GATE_A}`, message },
    }, brain, cfg, `http://localhost:${server.port}`)).toBe(true);
    expect(brain.hasPendingConfirmation?.()).toBe(true);
    expect(calls[0].body.text).toBe("not authorized");

    expect(await handleTelegramUpdate({
      callback_query: { id: "owner", from: { id: 42 }, data: `cicero:confirm:yes:${GATE_A}`, message },
    }, brain, cfg, `http://localhost:${server.port}`)).toBe(true);
    expect(brain.hasPendingConfirmation?.()).toBe(false);
    expect(calls.map((call) => call.path)).toEqual([
      "/bottok/answerCallbackQuery",
      "/bottok/answerCallbackQuery",
      "/bottok/editMessageText",
    ]);
  } finally {
    server.stop(true);
  }
});

test("plain Telegram yes/no text replies resolve a pending confirmation and ack in-chat", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const brain = confirmationBrain();
  const handled = await handleTelegramUpdate({
    message: privateMessage(10, "Yes."),
  }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`);
  server.stop();
  expect(handled).toBe(true);
  expect(brain.hasPendingConfirmation?.()).toBe(false);
  expect(calls.map((c) => c.body.text)).toEqual(["✅ Approved."]);
});

test("a plain Telegram denial resolves only the visible capability and acks in-chat", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  try {
    const brain = confirmationBrain();
    expect(await handleTelegramUpdate({
      message: privateMessage(10, "No!"),
    }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`)).toBe(true);
    expect(brain.hasPendingConfirmation?.()).toBe(false);
    expect(calls.map((call) => call.body.text)).toEqual(["❌ Denied."]);
  } finally {
    server.stop(true);
  }
});

test("'log …' texts hit the health handler and ack with the returned line", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const logged: Array<[string, string[]]> = [];
  const handled = await handleTelegramUpdate({
    message: privateMessage(11, "log calories 650 chicken bowl"),
  }, confirmationBrain(), { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
    onHealthLog: async (metric, words) => { logged.push([metric, words]); return "logged: calories 650 kcal — chicken bowl"; },
    onChat: async () => "should not be reached",
  });
  await Bun.sleep(50);
  server.stop();
  expect(handled).toBe(true);
  expect(logged).toEqual([["calories", ["650", "chicken", "bowl"]]]);
  expect(calls.map((c) => c.body.text)).toEqual(["🩺 logged: calories 650 kcal — chicken bowl"]);
});

test("'call me' texts trigger the dial-back handler, not a chat turn", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  let rang = 0;
  const handled = await handleTelegramUpdate({
    message: privateMessage(12, "Call me!"),
  }, confirmationBrain(), { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
    onCallMe: async () => { rang++; return "Ringing you now."; },
    onChat: async () => "should not be reached",
  });
  await Bun.sleep(50);
  server.stop();
  expect(handled).toBe(true);
  expect(rang).toBe(1);
  expect(calls.map((c) => c.body.text)).toEqual(["Ringing you now."]);
});

test("'have <name> call me' routes the dial-back to that persona", async () => {
  const server = Bun.serve({ port: 0, fetch: async () => Response.json({ ok: true }) });
  const cases: Array<[string, string | undefined]> = [
    ["have sage call me", "sage"],
    ["Have the coder call me", "coder"],
    ["ask remy to call me", "remy"],
    ["tell ada to call me back", "ada"],
    ["onyx, ring me", "onyx"],
    ["hey jarvis, have sage call me!", "sage"],
    // "nobody in particular" names ring as usual — no lane routing
    ["have someone call me", undefined],
    ["jarvis call me", undefined],
    ["call me back", undefined],
  ];
  for (const [text, expected] of cases) {
    const whos: Array<string | undefined> = [];
    const handled = await handleTelegramUpdate({
      message: privateMessage(15, text),
    }, confirmationBrain(), { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
      onCallMe: async (who) => { whos.push(who); return "Ringing you now."; },
      onChat: async () => "should not be reached",
    });
    expect(handled).toBe(true);
    expect(whos).toEqual([expected]);
  }
  server.stop();
});

test("'call me' embedded in a sentence stays a chat turn, not a dial-back", async () => {
  const server = Bun.serve({ port: 0, fetch: async () => Response.json({ ok: true }) });
  const brain = confirmationBrain();
  brain.hasPendingConfirmation = () => false;
  for (const text of ["call me when you're done", "don't call me tonight", "have sage call me tomorrow at nine"]) {
    const asked: string[] = [];
    await handleTelegramUpdate({
      message: privateMessage(16, text),
    }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
      onCallMe: async () => { throw new Error("should not ring"); },
      onChat: async (t) => { asked.push(t); return "ok"; },
    });
    expect(asked).toEqual([text]);
  }
  server.stop();
});

test("other texts are chat turns; long replies split at the Telegram cap", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const asked: string[] = [];
  const brain = confirmationBrain();
  brain.hasPendingConfirmation = () => false;
  const handled = await handleTelegramUpdate({
    message: privateMessage(13, "what's on the board today"),
  }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
    onChat: async (text) => { asked.push(text); return "x".repeat(4500); },
  });
  server.stop();
  expect(handled).toBe(true);
  expect(asked).toEqual(["what's on the board today"]);
  expect(calls.length).toBe(2); // 4500 chars → two messages
  expect((calls[0].body.text as string).length).toBe(4000);
  expect((calls[1].body.text as string).length).toBe(500);
});

test("a pending gate still wins for yes/no, and chat is NOT consulted for them", async () => {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      calls.push({ path: new URL(req.url).pathname, body: jsonObject(await req.json()) });
      return Response.json({ ok: true });
    },
  });
  const brain = confirmationBrain();
  const handled = await handleTelegramUpdate({
    message: privateMessage(14, "yes"),
  }, brain, { token: "tok", chat_id: 42 }, `http://localhost:${server.port}`, {
    onChat: async () => { throw new Error("chat must not see a gate answer"); },
  });
  await Bun.sleep(50);
  server.stop();
  expect(handled).toBe(true);
  expect(brain.hasPendingConfirmation?.()).toBe(false);
  expect(calls.map((c) => c.body.text)).toEqual(["✅ Approved."]);
});

test("without an onChat handler, unmatched text stays ignored (legacy non-chat bot)", async () => {
  const brain = confirmationBrain();
  brain.hasPendingConfirmation = () => false;
  const handled = await handleTelegramUpdate({
    message: privateMessage(15, "hello there"),
  }, brain, { token: "tok", chat_id: 42 }, "http://localhost:9");
  expect(handled).toBe(false);
});

test("classifyCallIntent: semantic dial-back fallback", async () => {
  const { classifyCallIntent } = await import("../../src/notify/telegram");
  const roster = ["coder", "sage"];
  // classifier verdicts are consumed as strict labels
  expect(await classifyCallIntent("get ada on the horn", async () => "call:coder", roster)).toEqual({ who: "coder" });
  expect(await classifyCallIntent("I want you on the phone", async () => "call", roster)).toEqual({});
  expect(await classifyCallIntent("did anyone call today?", async () => "none", roster)).toBeNull();
  // junk labels and classifier failures degrade to a chat turn
  expect(await classifyCallIntent("phone stuff", async () => "sure, calling now!", roster)).toBeNull();
  expect(await classifyCallIntent("ring the changes", async () => { throw new Error("down"); }, roster)).toBeNull();
  // non-call-ish text never pays the classifier round trip
  let asked = 0;
  expect(await classifyCallIntent("what's for dinner", async () => { asked++; return "call"; }, roster)).toBeNull();
  expect(asked).toBe(0);
});

test("the poller passes handlers through — typed chat reaches onChat end-to-end", async () => {
  const { startTelegramUpdatePoller } = await import("../../src/notify/telegram");
  // Fake bot API: the first queued command is stale and must be discarded;
  // the next long poll serves the live typed message.
  const updateQueries: URL[] = [];
  const sent: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      try {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/getUpdates")) {
          updateQueries.push(url);
          if (updateQueries.length === 1) {
            return Response.json({ ok: true, result: [
              { update_id: 6, message: privateMessage(1, "stale command") },
            ] });
          }
          if (updateQueries.length === 2) {
            return Response.json({ ok: true, result: [
              { update_id: 7, message: privateMessage(2, "what's up") },
            ] });
          }
          await Bun.sleep(200);
          return Response.json({ ok: true, result: [] });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          sent.push(String(jsonObject(await req.json()).text ?? ""));
          return Response.json({ ok: true });
        }
        return Response.json({ ok: true });
      } catch (err: unknown) {
        return Response.json({ ok: false, description: String(err) }, { status: 400 });
      }
    },
  });
  const asked: string[] = [];
  const brain = confirmationBrain();
  brain.hasPendingConfirmation = () => false;
  const stop = startTelegramUpdatePoller(
    { token: "tok", chat_id: 42 }, brain, `http://localhost:${server.port}`, 50,
    { onChat: async (text) => { asked.push(text); return "not much"; } },
  );
  const deadline = Date.now() + 3000;
  while (asked.length === 0 && Date.now() < deadline) await Bun.sleep(20);
  stop();
  await Bun.sleep(50);
  server.stop(true);
  expect(asked).toEqual(["what's up"]);   // the regression: handlers were dropped here
  expect(sent).toEqual(["not much"]);
  expect(updateQueries[0].searchParams.get("offset")).toBe("-1");
  expect(updateQueries[0].searchParams.get("limit")).toBe("1");
  expect(updateQueries[0].searchParams.get("timeout")).toBe("0");
  expect(updateQueries[1].searchParams.get("offset")).toBe("7");
  expect(updateQueries[1].searchParams.get("timeout")).toBe("20");
});

test("stopping the poller aborts an active long poll instead of waiting for Telegram", async () => {
  const { startTelegramUpdatePoller } = await import("../../src/notify/telegram");
  let longPollStarted = false;
  let longPollAborted = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      try {
        const url = new URL(req.url);
        if (url.searchParams.get("offset") === "-1") {
          return Response.json({ ok: true, result: [] });
        }
        longPollStarted = true;
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = (aborted: boolean): void => {
            clearTimeout(timer);
            req.signal.removeEventListener("abort", onAbort);
            longPollAborted ||= aborted;
            resolve();
          };
          const onAbort = (): void => finish(true);
          timer = setTimeout(() => finish(false), 2000);
          req.signal.addEventListener("abort", onAbort, { once: true });
          if (req.signal.aborted) onAbort();
        });
        return Response.json({ ok: true, result: [] });
      } catch (err: unknown) {
        return Response.json({ ok: false, description: String(err) }, { status: 500 });
      }
    },
  });
  try {
    const stop = startTelegramUpdatePoller(
      { token: "tok", chat_id: 42 },
      confirmationBrain(false),
      `http://localhost:${server.port}`,
      10,
      undefined,
      { requestDeadlineMs: 5000 },
    );
    const startDeadline = Date.now() + 1000;
    while (!longPollStarted && Date.now() < startDeadline) await Bun.sleep(10);
    expect(longPollStarted).toBe(true);
    stop();
    const abortDeadline = Date.now() + 750;
    while (!longPollAborted && Date.now() < abortDeadline) await Bun.sleep(10);
    expect(longPollAborted).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("poll responses are capped before JSON parsing and retried as bootstrap failures", async () => {
  const { startTelegramUpdatePoller } = await import("../../src/notify/telegram");
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests++;
      return Response.json({ ok: true, result: [], padding: "x".repeat(512) });
    },
  });
  try {
    const stop = startTelegramUpdatePoller(
      { token: "tok", chat_id: 42 },
      confirmationBrain(false),
      `http://localhost:${server.port}`,
      10,
      undefined,
      { requestDeadlineMs: 500, maxResponseBytes: 64 },
    );
    const deadline = Date.now() + 1000;
    while (requests < 2 && Date.now() < deadline) await Bun.sleep(10);
    stop();
    expect(requests).toBeGreaterThanOrEqual(2);
  } finally {
    server.stop(true);
  }
});

test("Telegram API failures redact bot tokens from bounded error logs", async () => {
  const secret = "123456:ABCDEF-secret";
  const output: string[] = [];
  const originalLog = console.log;
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(
      `failure while requesting https://api.telegram.org/bot${secret}/sendMessage token=${secret}`,
      { status: 400 },
    ),
  });
  console.log = (...values: unknown[]): void => {
    output.push(values.map(String).join(" "));
  };
  try {
    expect(await sendTelegramText(
      { token: secret, chat_id: 42 },
      "hello",
      `http://localhost:${server.port}`,
    )).toBe(false);
  } finally {
    console.log = originalLog;
    server.stop(true);
  }
  expect(output.join("\n")).not.toContain(secret);
  expect(output.join("\n")).toContain("[redacted]");
});
