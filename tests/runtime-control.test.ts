import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../src/backends/hot-swap";
import { MANAGED_STARTUP_TIMEOUT_MS, PROVIDER_TIMEOUT_MS } from "../src/backends/http-transfer";
import { CONTROL_TIMEOUT_MS, requestRuntimeSwap, startRuntimeControl, type RuntimeControlHandle } from "../src/runtime-control";

let handle: RuntimeControlHandle | null = null;
let dir = "";
afterEach(async () => {
  await handle?.stop().catch(() => {});
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("runtime swap control", () => {
  test("publishes a private descriptor and returns the daemon result", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    const requests: unknown[] = [];
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async (request) => {
        requests.push(request);
        return { ...request, status: "active" };
      },
    });

    const result = await requestRuntimeSwap(
      { role: "tts", backend: "kokoro", model: "model-a" },
      { descriptorPath },
    );

    expect(result).toEqual({ role: "tts", backend: "kokoro", model: "model-a", status: "active" });
    expect(requests).toEqual([{ role: "tts", backend: "kokoro", model: "model-a" }]);
  });

  test("the swap handler receives the request's cancellation signal", async () => {
    // Without this the daemon could not tell that the client had given up, so a
    // swap whose CLI had already printed a failure still committed.
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    let observed: AbortSignal | undefined;
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async (request, options) => {
        observed = options?.signal;
        return { ...request, status: "active" };
      },
    });

    await requestRuntimeSwap({ role: "tts", backend: "kokoro" }, { descriptorPath });

    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed?.aborted).toBe(false);
  });

  test("the client deadline outlasts a whole supported swap transaction", () => {
    // Not just the cold start: the swap runs start → warmup → health → persist →
    // retired-generation cleanup back to back, and the abort is only honoured
    // BEFORE persistence. A deadline that covers only startup still lets the CLI
    // report failure for a swap that commits — 290s start + 35s warmup + 2s health
    // + 5s drain overran the earlier 330s value. Each phase is bounded elsewhere,
    // so the client budget must be at least their sum.
    const worstCaseTransactionMs = MANAGED_STARTUP_TIMEOUT_MS
      + Math.max(PROVIDER_TIMEOUT_MS.tts, PROVIDER_TIMEOUT_MS.stt)
      + PROVIDER_TIMEOUT_MS.health
      + DEFAULT_CLEANUP_TIMEOUT_MS;
    expect(CONTROL_TIMEOUT_MS).toBeGreaterThan(worstCaseTransactionMs);
  });

  test("propagates actionable rollback errors", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async () => { throw new Error("candidate warmup failed; old provider retained"); },
    });

    await expect(requestRuntimeSwap(
      { role: "stt", backend: "faster-whisper" },
      { descriptorPath },
    )).rejects.toThrow("candidate warmup failed; old provider retained");
  });

  test("rejects callers without the descriptor token", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async (request) => ({ ...request, status: "active" }),
    });

    const response = await fetch(`${handle.url}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "stt", backend: "wyoming" }),
    });
    expect(response.status).toBe(401);
  });

  test("serializes swaps across STT and TTS", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async (request) => {
        signalEntered();
        await gate;
        return { ...request, status: "active" };
      },
    });

    const first = requestRuntimeSwap({ role: "stt", backend: "wyoming" }, { descriptorPath });
    // Wait for the first swap to actually be in-flight rather than yielding a
    // fixed number of ticks: under load the request had not reached the handler
    // yet, so the second was admitted, blocked on the same gate, and the assertion
    // below deadlocked until the test timeout instead of failing.
    await entered;
    await expect(requestRuntimeSwap(
      { role: "tts", backend: "wyoming" },
      { descriptorPath },
    )).rejects.toThrow("another provider swap is already in progress");

    release();
    await expect(first).resolves.toMatchObject({ role: "stt", backend: "wyoming", status: "active" });
  });

  test("releases the control socket and descriptor even when a swap misses the drain deadline", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const control = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      drainTimeoutMs: 25, // a hung swap must not stall shutdown for the full 10s
      onSwap: async (request) => { signalEntered(); await gate; return { ...request, status: "active" }; },
    });
    handle = control;

    // Fire a swap that blocks in onSwap, and wait until it is actually in-flight
    // (registered as active work) so the drain below genuinely has to wait.
    void requestRuntimeSwap({ role: "tts", backend: "kokoro" }, { descriptorPath, timeoutMs: 5_000 }).catch(() => {});
    await entered;
    expect(existsSync(descriptorPath)).toBe(true);

    // Let the swap finish only AFTER the 25ms drain deadline has passed, so the
    // timeout branch is exercised. stop() surfaces the bounded-drain timeout, but
    // ONLY after releasing the owned socket + descriptor — a swap that overruns
    // the deadline can never strand the control plane.
    const lateRelease = setTimeout(() => release(), 120);
    await expect(control.stop()).rejects.toThrow("did not drain within 25ms");
    clearTimeout(lateRelease);
    release();
    expect(existsSync(descriptorPath)).toBe(false);
    const probe = await fetch(`${control.url}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: JSON.stringify({ role: "tts", backend: "kokoro" }),
    }).then(() => "reachable", () => "released");
    expect(probe).toBe("released");

    handle = null; // already stopped; afterEach must not double-stop
  });
  test("strips terminal control sequences out of a candidate provider's error text", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    // A candidate TTS/STT server is untrusted: its HTTP error body can carry
    // escape sequences, they survive JSON transport intact, and `cicero swap`
    // prints the message straight to a terminal.
    const hostile = "warmup failed: \u001b[2J\u001b]0;pwned\u0007 \u009bH still text";
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async () => { throw new Error(hostile); },
    });

    const failure = await requestRuntimeSwap(
      { role: "tts", backend: "kokoro" },
      { descriptorPath },
    ).then(() => null, (error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    // The human-readable part survives; only the control bytes are removed.
    expect(failure!.message).toContain("warmup failed:");
    expect(failure!.message).toContain("still text");
    expect(failure!.message).not.toContain("pwned\u0007");
  });

  test("bounds an enormous provider error instead of relaying it whole", async () => {
    dir = mkdtempSync(join(tmpdir(), "cicero-control-"));
    const descriptorPath = join(dir, "runtime-control.json");
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async () => { throw new Error("x".repeat(50_000)); },
    });

    const failure = await requestRuntimeSwap(
      { role: "stt", backend: "faster-whisper" },
      { descriptorPath },
    ).then(() => null, (error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message.length).toBeLessThanOrEqual(501);
  });
});
