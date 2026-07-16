import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CALLBACK_SPOOL_PATH,
  LISTENER_HEARTBEAT_PATH,
  TELEGRAM_CALL_DIR,
  callbackConsumerAlive,
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
});

test("a fresh heartbeat means the dial-back consumer is alive", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(2_000))).toBe(true);
});

test("a heartbeat inside the window (a deferring listener) still reads alive", async () => {
  // 25s old: a listener that is mid-call / has an empty allowlist but whose
  // poll loop is still ticking. The spool file alone could not distinguish
  // this from a dead sidecar; the heartbeat can.
  expect(await callbackConsumerAlive(Date.now(), heartbeat(25_000))).toBe(true);
});

test("a stale heartbeat means no live consumer", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(60_000))).toBe(false);
});

test("an absent heartbeat fails closed (no consumer)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cicero-call-"));
  roots.push(root);
  expect(await callbackConsumerAlive(Date.now(), join(root, "listener.alive"))).toBe(false);
});

test("a small clock skew (near-future mtime) still reads alive", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(-3_000))).toBe(true);
});

test("an absurd future mtime fails closed rather than reading alive forever", async () => {
  expect(await callbackConsumerAlive(Date.now(), heartbeat(-1_000_000_000_000))).toBe(false);
});
