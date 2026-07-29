import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OllamaProvider } from "../../../src/backends/llm/ollama";

let lastBody: Record<string, unknown> = {};

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    try {
      lastBody = (await request.json()) as Record<string, unknown>;
      return Response.json({ message: { content: "ready" } });
    } catch (error: unknown) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  },
});

afterAll(() => server.stop(true));

test("Ollama request model uses the same whitespace normalization as doctor", async () => {
  const provider = new OllamaProvider({
    backend: "ollama",
    host: "localhost",
    port: server.port,
    model: "  qwen3.5:0.8b  ",
  });

  expect(await provider.chatCompletion([{ role: "user", content: "hello" }])).toBe("ready");
  expect(lastBody.model).toBe("qwen3.5:0.8b");
});

// Round 6 (Codex): `ollama serve` takes no port argument — it binds OLLAMA_HOST,
// default 127.0.0.1:11434. A second Ollama role (a classifier on its own port)
// therefore spawned a server aimed at the FIRST role's port, which was already
// bound; the child exited and that role was silently unavailable for the run.
// The fake binary here records the environment it was launched with.
test.skipIf(process.platform === "win32")("a managed ollama is told its port through OLLAMA_HOST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-ollama-env-test-"));
  const recorded = join(dir, "env.txt");
  const fake = join(dir, "ollama");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$OLLAMA_HOST" > ${JSON.stringify(recorded)}\nexit 0\n`);
  chmodSync(fake, 0o755);

  // Reserve a port, then free it: a real free port that is NOT ollama's default.
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  await Promise.resolve(reservation.stop(true));

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    const provider = new OllamaProvider({ backend: "ollama", host: "127.0.0.1", port, model: "m" });
    // The fake exits immediately, so start() gives up on readiness — the point
    // is what it put in the child's environment before that.
    await provider.start();
    expect(existsSync(recorded)).toBe(true);
    expect(readFileSync(recorded, "utf8")).toBe(`127.0.0.1:${port}`);
    expect(port).not.toBe(11434);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// Round 7 (Codex): every tier preset configures Ollama WITHOUT a host, and
// interpolating it raw produced the literal `OLLAMA_HOST=undefined:11434` —
// a hostname Ollama tries to bind rather than its localhost default. The
// previous regression only covered an explicitly configured host, so it passed.
test.skipIf(process.platform === "win32")("an omitted host resolves to localhost, never the string 'undefined'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-ollama-nohost-test-"));
  const recorded = join(dir, "env.txt");
  const fake = join(dir, "ollama");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$OLLAMA_HOST" > ${JSON.stringify(recorded)}\nexit 0\n`);
  chmodSync(fake, 0o755);

  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  await Promise.resolve(reservation.stop(true));

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath ?? ""}`;
  try {
    // No `host` — exactly what deployment: local-cpu expands to.
    await new OllamaProvider({ backend: "ollama", port, model: "m" }).start();
    const recordedHost = readFileSync(recorded, "utf8");
    expect(recordedHost).not.toContain("undefined");
    // And it names the same endpoint the health probe will use.
    expect(recordedHost).toBe(`localhost:${port}`);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// Callers describe a schema the OpenAI way -- {name, strict, schema} -- because
// every other backend here takes that envelope. Ollama's native /api/chat wants
// the BARE schema, so passing the envelope through sends a document whose only
// top-level keys are name/strict/schema: the constraint is silently not applied
// and the model is free to answer with anything.
test("a json_schema envelope is unwrapped to the bare schema ollama expects", async () => {
  const schema = {
    type: "object",
    properties: { directed: { type: "boolean" }, confidence: { type: "number" } },
    required: ["directed", "confidence"],
  };
  let sent: Record<string, unknown> | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      sent = await request.json() as Record<string, unknown>;
      return Response.json({ message: { content: '{"directed":true,"confidence":1}' } });
    },
  });
  try {
    const provider = new OllamaProvider({ backend: "ollama", host: "127.0.0.1", port: server.port });
    await provider.chatCompletion([{ role: "user", content: "hi" }], {
      responseFormat: { type: "json_schema", json_schema: { name: "verdict", strict: true, schema } },
    });
  } finally {
    await server.stop(true);
  }
  expect(sent?.format).toEqual(schema);
});

test("a bare schema is still accepted unchanged", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  let sent: Record<string, unknown> | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      sent = await request.json() as Record<string, unknown>;
      return Response.json({ message: { content: "{}" } });
    },
  });
  try {
    const provider = new OllamaProvider({ backend: "ollama", host: "127.0.0.1", port: server.port });
    await provider.chatCompletion([{ role: "user", content: "hi" }], {
      responseFormat: { type: "json_schema", json_schema: schema },
    });
  } finally {
    await server.stop(true);
  }
  expect(sent?.format).toEqual(schema);
});
