import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestRuntimeSwap, startRuntimeControl, type RuntimeControlHandle } from "../src/runtime-control";

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
    handle = await startRuntimeControl({
      token: "test-token",
      descriptorPath,
      onSwap: async (request) => {
        await gate;
        return { ...request, status: "active" };
      },
    });

    const first = requestRuntimeSwap({ role: "stt", backend: "wyoming" }, { descriptorPath });
    await Bun.sleep(0);
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
});
