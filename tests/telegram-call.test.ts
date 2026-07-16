import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordParkedBriefingVoiceOutcome, writeProactiveCallback } from "../src/daemon";
import {
  CALLBACK_SPOOL_PATH,
  LISTENER_HEARTBEAT_PATH,
  TELEGRAM_CALL_DIR,
  TELEGRAM_SESSION_PATH,
  callbackConsumerAlive,
  writeCallbackSpool,
} from "../src/telegram-call";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A heartbeat file whose mtime is `ageMs` in the past (negative = future). */
function heartbeat(ageMs: number): string {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-"));
  roots.push(root);
  const path = join(root, "listener.alive");
  writeFileSync(path, "");
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

test("shared call paths live under ~/.cicero/telegram-call", () => {
  expect(TELEGRAM_CALL_DIR).toBe(join(homedir(), ".cicero", "telegram-call"));
  expect(CALLBACK_SPOOL_PATH).toBe(join(TELEGRAM_CALL_DIR, "callback.request"));
  expect(LISTENER_HEARTBEAT_PATH).toBe(join(TELEGRAM_CALL_DIR, "listener.alive"));
  expect(TELEGRAM_SESSION_PATH).toBe(join(TELEGRAM_CALL_DIR, "cicero.session"));
});

test("a fresh heartbeat means the dial-back consumer is alive", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(2_000))).toBe(true);
});

test("a heartbeat inside the window (a deferring listener) still reads alive", async () => {
  // The 30s grace tolerates brief scheduler stalls without flapping the line.
  expect(await callbackConsumerAlive(Date.now(), heartbeat(25_000))).toBe(true);
});

test("an expired modern heartbeat after clean shutdown blocks the legacy session fallback", async () => {
  const path = heartbeat(Date.now());
  writeFileSync(join(dirname(path), "cicero.session"), "legacy session");
  expect(await callbackConsumerAlive(Date.now(), path)).toBe(false);
});

test("an absent heartbeat without a legacy session fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-"));
  roots.push(root);
  expect(await callbackConsumerAlive(Date.now(), join(root, "listener.alive"))).toBe(false);
});

test("a never-created heartbeat falls back to the legacy cicero session", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-"));
  roots.push(root);
  writeFileSync(join(root, "cicero.session"), "legacy session");
  expect(await callbackConsumerAlive(Date.now(), join(root, "listener.alive"))).toBe(true);
});

test("a heartbeat symlink never proves the callback consumer is alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-"));
  roots.push(root);
  const target = join(root, "frequently-updated");
  writeFileSync(target, "unrelated");
  symlinkSync(target, join(root, "listener.alive"));
  writeFileSync(join(root, "cicero.session"), "legacy session");
  expect(await callbackConsumerAlive(Date.now(), join(root, "listener.alive"))).toBe(false);
});

test("a small clock skew (near-future mtime) still reads alive", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(-3_000))).toBe(true);
});

test("an absurd future mtime fails closed rather than reading alive forever", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(-1_000_000_000_000))).toBe(false);
});

test("a kanban callback skips its spool write when no consumer is alive", async () => {
  let writes = 0;
  const queued = await writeProactiveCallback(
    async () => { writes += 1; },
    async () => false,
  );
  expect(queued).toBe(false);
  expect(writes).toBe(0);
});

test("a parked briefing records failed callback when no consumer is alive", async () => {
  const channels = { voice: "accepted" };
  let writes = 0;
  await recordParkedBriefingVoiceOutcome(
    new AbortController().signal,
    channels,
    async () => { writes += 1; },
    async () => false,
  );
  expect(channels).toEqual({ voice: "accepted", callback: "failed" });
  expect(writes).toBe(0);
});

test("abort after a matching callback write compensates by unlinking and reports aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-spool-abort-"));
  roots.push(root);
  const spool = join(root, "callback.request");
  const content = JSON.stringify({ reason: "matching", at: 1 });
  const controller = new AbortController();
  const channels = { voice: "accepted" };

  await recordParkedBriefingVoiceOutcome(
    controller.signal,
    channels,
    () => writeCallbackSpool(content, controller.signal, spool, async (path, value) => {
      await Bun.write(path, value);
      controller.abort(new Error("turn aborted after write"));
    }),
    async () => true,
  );

  expect(channels).toEqual({ voice: "aborted", callback: "aborted" });
  expect(existsSync(spool)).toBe(false);
});

test("abort compensation preserves a newer mismatching callback spool", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-spool-race-"));
  roots.push(root);
  const spool = join(root, "callback.request");
  const content = JSON.stringify({ reason: "old", at: 1 });
  const newer = JSON.stringify({ reason: "new", at: 2 });
  const controller = new AbortController();

  const published = await writeCallbackSpool(content, controller.signal, spool, async (path, value) => {
    await Bun.write(path, value);
    controller.abort(new Error("old turn aborted"));
    await Bun.write(path, newer);
  });

  expect(published).toBe(false);
  expect(readFileSync(spool, "utf8")).toBe(newer);
});
