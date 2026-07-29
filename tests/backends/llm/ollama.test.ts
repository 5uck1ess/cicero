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
