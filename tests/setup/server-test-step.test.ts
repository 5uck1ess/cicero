import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROBES } from "../../src/setup/probes";
import { startSetupServer } from "../../src/setup/server";

async function harness(probes: Partial<typeof PROBES>, probeTimeoutMs = 50) {
  let handler: (req: Request) => Response | Promise<Response> = () => new Response();
  const serve = ((o: { fetch: typeof handler }) => { handler = o.fetch; return { port: 9999, stop() {} }; }) as unknown as typeof Bun.serve;
  const home = mkdtempSync(join(tmpdir(), "cicero-test-step-"));
  const server = await startSetupServer({ home, serve, output: () => {}, probes, probeTimeoutMs,
    systemDeps: { platform: () => "linux", arch: () => "x64", release: () => "6.8", which: () => null, exists: () => true, statfs: () => ({ bavail: 1, bsize: 1 }) as ReturnType<typeof import("node:fs")["statfsSync"]> },
    pickerDeps: { which: () => null, exists: () => false, probePort: async () => false, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch } });
  const send = async (path: string, body?: object) => (await handler(new Request(`http://127.0.0.1:9999${path}`, { method: body ? "POST" : "GET", headers: { host: "127.0.0.1:9999", "x-cicero-setup-token": server.token, ...(body ? { "x-cicero-setup-csrf": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined }))).json() as Promise<{ tests: Record<string, { state: string }>; testsCleared: boolean; error?: string }>;
  return { send, done: async () => { await server.stop(); rmSync(home, { recursive: true, force: true }); } };
}

test("a probe that never answers hits its deadline and reports timeout", async () => {
  // PROBES wraps the work in the deadline; a raw override must use the same wrapper, so drive the real helper probe against a hanging endpoint.
  const { send, done } = await harness({ helper: (config, o) => PROBES.helper({ ...config, web_voice: { tldr: { summarizer_url: "http://127.0.0.1:1/v1", summarizer_model: "m" } } }, { ...o, deps: { probePort: async () => true, fetcher: (async () => new Promise(() => {})) as typeof fetch } }) });
  try { expect((await send("/api/test", { probe: "helper" })).tests.helper.state).toBe("timeout"); }
  finally { await done(); }
});

test("cancel aborts the running probe and it reports cancelled", async () => {
  const { send, done } = await harness({ helper: (config, o) => PROBES.helper({ ...config, web_voice: { tldr: { summarizer_url: "http://127.0.0.1:1/v1", summarizer_model: "m" } } }, { ...o, deps: { probePort: async () => true, fetcher: (async () => new Promise(() => {})) as typeof fetch } }) }, 5000);
  try {
    const running = send("/api/test", { probe: "helper" });
    await new Promise((r) => setTimeout(r, 10));
    await send("/api/test/cancel", { probe: "helper" });
    expect((await running).tests.helper.state).toBe("cancelled");
    expect((await send("/api/test", { probe: "nope" })).error).toBe("Unknown probe");
  } finally { await done(); }
});

test("a choice made after a probe finished removes its result from the view", async () => {
  const { send, done } = await harness({ memory: async () => ({ id: "memory", state: "ok", message: "fine" }) });
  try {
    expect((await send("/api/test", { probe: "memory" })).tests.memory.state).toBe("ok");
    expect((await send("/api/state")).tests.memory.state).toBe("ok");
    await send("/api/step", { id: "privacy" });
    await send("/api/choice", { id: "privacy", choice: { mode: "cloud" } });
    const after = await send("/api/state");
    expect(after.tests.memory).toBeUndefined();
    expect(after.testsCleared).toBe(true);
  } finally { await done(); }
});
