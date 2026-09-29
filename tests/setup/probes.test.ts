import { expect, test } from "bun:test";
import type { STTProvider } from "../../src/backends/stt/provider";
import type { BoundedCommandOptions } from "../../src/process/bounded-command";
import { attributeMemory, parseComputeApps, parseListeners, probeFrontDesk, probeHear, probeHelper, probeMemory, runHeadlessProbes, wordOverlap } from "../../src/setup/probes";

const signal = () => new AbortController().signal;
const open = { probePort: async () => true };
const stt = (text: string): STTProvider => ({ name: "fixture", transcribe: async () => text, transcribeResult: async () => ({ kind: "transcript", text }), health: async () => true } as unknown as STTProvider);
const out = (text: string, exitCode = 0) => ({ command: [], exitCode, durationMs: 1, stdout: { text, receivedBytes: text.length, capturedBytes: text.length, limitBytes: 65536, truncated: false }, stderr: { text: "", receivedBytes: 0, capturedBytes: 0, limitBytes: 1024, truncated: false }, combined: { receivedBytes: text.length, capturedBytes: text.length, limitBytes: 66560, truncated: false } });

test("Hear: the bundled WAV must come back as its text (word overlap >= 0.6)", async () => {
  const config = { stt: { backend: "audiocpp", port: 8092 } };
  expect(await probeHear(config, { signal: signal(), deps: { ...open, buildStt: () => stt("Cicero, what time is it in Tokyo") } })).toMatchObject({ id: "hear", state: "ok" });
  const bad = await probeHear(config, { signal: signal(), deps: { ...open, buildStt: () => stt(`banana ${"x".repeat(400)}`) } });
  expect(bad.state).toBe("failed");
  expect(bad.message).toContain("banana");
  expect(bad.message.length).toBeLessThanOrEqual(200);
  expect(await probeHear(config, { signal: signal(), deps: { probePort: async () => false } })).toMatchObject({ state: "not running", startCommand: "scripts/provision-audiocpp.sh" });
  expect(wordOverlap("Cicero, what time is it in Tokyo?", "cicero what time is it")).toBeCloseTo(5 / 7, 5);
});

test("Front desk: an agent is never run; its install and credential are reported", async () => {
  let spawned = 0;
  const result = await probeFrontDesk({ brain: { backend: "claude-code", mode: "subprocess" } }, { signal: signal(), deps: {
    which: (b) => b === "claude" ? "/usr/bin/claude" : null, env: {}, readFile: () => null, homeDir: () => "/fixture/home",
    runCommand: (async (command: readonly string[]) => { spawned += 1; expect(command.slice(1)).toEqual(["auth", "status"]); return out('{"loggedIn":true,"authMethod":"claude.ai"}'); }) as never,
  } });
  expect(result).toMatchObject({ state: "installed; tested on first call" });
  expect(result.message).toContain("subscription");
  expect(spawned).toBe(1); // the read-only status command only
  expect((await probeFrontDesk({ brain: { backend: "codex" } }, { signal: signal(), deps: { which: () => null } })).state).toBe("failed");
});

test("Front desk: an ACP adapter's credential follows its provider and the configured unset_env", async () => {
  const deps = {
    which: (b: string) => `/usr/bin/${b}`, env: { ANTHROPIC_API_KEY: "synthetic-anthropic-marker" }, readFile: () => null, homeDir: () => "/fixture/home",
    runCommand: (async (command: readonly string[]) => command[0]!.endsWith("claude") ? out('{"loggedIn":true,"authMethod":"claude.ai"}') : out("{}", 1)) as never,
  };
  const brain = { backend: "acp", binary: "bunx", binary_args: ["@agentclientprotocol/claude-agent-acp@0.84.0"] };
  expect((await probeFrontDesk({ brain }, { signal: signal(), deps })).data).toEqual({ credential: "per-token key" });
  expect((await probeFrontDesk({ brain: { ...brain, unset_env: ["ANTHROPIC_API_KEY"] } }, { signal: signal(), deps })).data).toEqual({ credential: "subscription" });
  const esc = await probeFrontDesk({ brain: { backend: "ollama", ollama_model: "m", escalate: { ...brain, unset_env: ["ANTHROPIC_API_KEY"] } } }, { signal: signal(), deps: { ...deps, probePort: async () => false } });
  expect(esc.message).toContain("credential subscription");
});

test("Front desk: a model answers one completion; a closed runtime port is 'not running'", async () => {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(JSON.parse(String(init?.body)).model).toBe("gemma4:e4b-it-qat");
    return Response.json({ choices: [{ message: { content: "Ready." } }] });
  }) as typeof fetch;
  expect(await probeFrontDesk({ brain: { backend: "ollama", ollama_model: "gemma4:e4b-it-qat" } }, { signal: signal(), deps: { ...open, fetcher } })).toMatchObject({ state: "ok" });
  expect((await probeFrontDesk({ brain: { backend: "openai-compatible", base_url: "http://127.0.0.1:8080/v1", model: "m" } }, { signal: signal(), deps: { probePort: async () => false } })).state).toBe("not running");
  const huge = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(70_000) } }] }))) as typeof fetch;
  expect((await probeFrontDesk({ brain: { backend: "ollama", ollama_model: "m" } }, { signal: signal(), deps: { ...open, fetcher: huge } })).state).toBe("failed");
});

test("a stopped model runtime names its start command for the front desk and helper", async () => {
  const closed = { probePort: async () => false };
  const fd = await probeFrontDesk({ brain: { backend: "ollama", ollama_model: "gemma4:e4b-it-qat" } }, { signal: signal(), deps: closed });
  expect(fd).toMatchObject({ state: "not running", startCommand: "ollama serve" });
  const helper = await probeHelper({ web_voice: { tldr: { summarizer_url: "http://127.0.0.1:1234/v1", summarizer_model: "m" } } }, { signal: signal(), deps: closed });
  expect(helper).toMatchObject({ state: "not running", startCommand: "lms server start" });
  const swap = await probeHelper({ web_voice: { tldr: { summarizer_url: "http://127.0.0.1:8080/v1", summarizer_model: "m" } } }, { signal: signal(), deps: closed });
  expect(swap.startCommand).toContain("--port 8080");
  const other = await probeHelper({ web_voice: { tldr: { summarizer_url: "http://127.0.0.1:9999/v1", summarizer_model: "m" } } }, { signal: signal(), deps: closed });
  expect(other.startCommand).toBeUndefined();
});

test("Helper: skipped without a helper; one summary of the bundled long reply with one", async () => {
  expect(await probeHelper({}, { signal: signal() })).toMatchObject({ state: "skipped" });
  let prompt = "";
  const fetcher = (async (_i: RequestInfo | URL, init?: RequestInit) => { prompt = JSON.parse(String(init?.body)).messages[0].content; return Response.json({ choices: [{ message: { content: "I fixed the retry deadline." } }] }); }) as typeof fetch;
  const ok = await probeHelper({ web_voice: { tldr: { summarizer_url: "http://127.0.0.1:11434/v1", summarizer_model: "gemma4:e4b-it-qat" } } }, { signal: signal(), deps: { ...open, fetcher } });
  expect(ok.state).toBe("ok");
  expect(prompt).toContain("retry helper");
});

test("timeout and cancel end a probe that never answers", async () => {
  const hang = (async (_i: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const config = { web_voice: { tldr: { summarizer_url: "http://127.0.0.1:11434/v1", summarizer_model: "m" } } };
  expect(await probeHelper(config, { signal: signal(), timeoutMs: 50, deps: { ...open, fetcher: hang } })).toMatchObject({ state: "timeout" });
  const controller = new AbortController();
  const pending = probeHelper(config, { signal: controller.signal, deps: { ...open, fetcher: (async () => new Promise(() => {})) as typeof fetch } });
  setTimeout(() => controller.abort(), 5);
  expect(await pending).toMatchObject({ state: "cancelled" });
});

test("Memory: per-process GPU use is attributed to engine ports, directly or via the parent process", async () => {
  expect(parseComputeApps("4242, 4012\n777, 3480\n")).toEqual(new Map([[4242, 4012], [777, 3480]]));
  expect(parseListeners('LISTEN 0 16 127.0.0.1:8092 0.0.0.0:* users:(("audiocpp_server",pid=777,fd=37))\nLISTEN 0 4096 *:8080 *:* users:(("llama-swap",pid=100,fd=7))')).toEqual(new Map([[8092, 777], [8080, 100]]));
  const stat = (pid: number) => pid === 4242 ? "4242 (llama-server) S 100 4242" : pid === 55 ? "55 (python) S 1 55" : null;
  const measured = attributeMemory(new Map([[4242, 4012], [777, 3480], [55, 1024]]), new Map([[8092, 777], [8080, 100]]), new Map([[8092, "Hear + Speak"], [8080, "Front desk model"]]), (path) => stat(Number(path.split("/")[2])));
  expect(measured.engines).toEqual([{ label: "Front desk model", port: 8080, gb: 3.9 }, { label: "Hear + Speak", port: 8092, gb: 3.4 }]);
  expect(measured.otherGb).toBe(1);
  const run = (async (command: readonly string[]) => command[1] === "-ltnpH"
    ? out('LISTEN 0 16 127.0.0.1:8092 0.0.0.0:* users:(("audiocpp_server",pid=777,fd=37))')
    : out("777, 3480\n")) as never;
  const result = await probeMemory({ stt: { backend: "audiocpp", port: 8092 }, tts: { backend: "audiocpp", port: 8092 } }, { signal: signal(), platform: "linux", deps: { which: (b) => `/usr/bin/${b}`, gpuRunner: run, readFile: () => null } });
  expect(result.state).toBe("ok");
  expect(result.message).toContain("Hear + Speak (audiocpp) 3.4 GB");
  expect((await probeMemory({}, { signal: signal(), platform: "darwin" })).message).toContain("Mac measurement is deferred");
});

test("Memory: cancel reaches the running nvidia-smi and no later command starts", async () => {
  const calls: string[] = [];
  let signalled: AbortSignal | undefined;
  let finish = () => {};
  const run = ((command: readonly string[], options?: BoundedCommandOptions) => {
    calls.push(command[0]!);
    if (command[0] === "/usr/bin/nvidia-smi") { signalled = options?.signal; return new Promise((resolve) => { finish = () => resolve(out("777, 3480\n")); }); }
    return Promise.resolve(out(""));
  }) as never;
  const controller = new AbortController();
  const pending = probeMemory({}, { signal: controller.signal, platform: "linux", deps: { which: (b) => `/usr/bin/${b}`, gpuRunner: run, readFile: () => null } });
  await Bun.sleep(5);
  controller.abort();
  expect(await pending).toMatchObject({ state: "cancelled" });
  expect(signalled?.aborted).toBe(true);
  finish();
  await Bun.sleep(5);
  expect(calls).toEqual(["/usr/bin/nvidia-smi"]);
});

test("Front desk: cancel reaches the pending login check and no later account command starts", async () => {
  const calls: string[] = [];
  let signalled: AbortSignal | undefined;
  let finish = () => {};
  const runCommand = ((command: readonly string[], options?: BoundedCommandOptions) => {
    calls.push(command.join(" "));
    if (command[1] === "auth") { signalled = options?.signal; return new Promise((resolve) => { finish = () => resolve(out('{"loggedIn":true,"authMethod":"claude.ai"}')); }); }
    return Promise.resolve(out("{}"));
  }) as never;
  const controller = new AbortController();
  const pending = probeFrontDesk({ brain: { backend: "claude-code", mode: "subprocess" } }, { signal: controller.signal, deps: { which: (b) => `/usr/bin/${b}`, env: {}, readFile: () => null, homeDir: () => "/fixture/home", runCommand } });
  await Bun.sleep(5);
  controller.abort();
  expect(await pending).toMatchObject({ state: "cancelled" });
  expect(signalled?.aborted).toBe(true);
  finish();
  await Bun.sleep(5);
  expect(calls).toEqual(["/usr/bin/claude auth status"]);
});

test("headless probes include the browser-only Speak row as skipped", async () => {
  const results = await runHeadlessProbes({}, { signal: signal(), timeoutMs: 100, deps: { probePort: async () => false, which: () => null, platform: "linux" } });
  expect(results.map((r) => r.id)).toEqual(["hear", "frontdesk", "helper", "memory", "speak"]);
  expect(results.at(-1)).toEqual({ id: "speak", state: "skipped", message: "skipped (no browser)" });
});
