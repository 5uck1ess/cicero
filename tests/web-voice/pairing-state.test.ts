import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPairingState,
  removePairingState,
  writePairingState,
  type PairingState,
} from "../../src/web-voice/pairing-state";

const STATE: PairingState = {
  scheme: "https",
  port: 8090,
  lanHost: "192.168.1.23",
  tunnelProvider: "cloudflared",
  tunnelUrl: "https://random.trycloudflare.com",
  startedAt: "2026-07-18T12:00:00.000Z",
  pid: 4242,
};

describe("web-voice pairing state", () => {
  test("writes private bounded JSON with no credential and reads only a live PID", () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-pairing-state-"));
    const path = join(root, "web-voice", "pairing.json");
    const liveToken = "synthetic-live-token-must-never-be-serialized";
    try {
      writePairingState({ ...STATE, tunnelUrl: `${STATE.tunnelUrl}/?token=${liveToken}` }, path);
      const bytes = readFileSync(path, "utf8");
      expect(bytes).not.toContain(liveToken);
      expect(bytes).not.toContain("token");
      if (process.platform !== "win32") expect(lstatSync(path).mode & 0o777).toBe(0o600);

      expect(readPairingState(path, { pidAlive: (pid) => pid === STATE.pid })).toEqual(STATE);
      expect(readPairingState(path, { pidAlive: () => false })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses symlink state paths and only removes state owned by the stopping PID", () => {
    const root = mkdtempSync(join(tmpdir(), "cicero-pairing-state-safe-"));
    const target = join(root, "target.json");
    const link = join(root, "pairing.json");
    try {
      writeFileSync(target, JSON.stringify(STATE));
      symlinkSync(target, link);
      expect(() => readPairingState(link, { pidAlive: () => true })).toThrow(/unsafe private file path/);
      expect(() => writePairingState(STATE, link)).toThrow(/unsafe private file path/);
      expect(readFileSync(target, "utf8")).toBe(JSON.stringify(STATE));

      rmSync(link);
      writePairingState(STATE, link);
      removePairingState(link, STATE.pid + 1);
      expect(readPairingState(link, { pidAlive: () => true })).toEqual(STATE);
      removePairingState(link, STATE.pid);
      expect(readPairingState(link, { pidAlive: () => true })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
