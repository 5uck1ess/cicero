import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairPhone, selectPairingUrl } from "../../src/cli/pair";
import type { PairingState } from "../../src/web-voice/pairing-state";

const state: PairingState = {
  scheme: "https",
  port: 9443,
  lanHost: "192.168.1.50",
  tunnelProvider: "tailscale",
  tunnelUrl: "https://cicero.tailnet.ts.net",
  startedAt: "2026-07-18T12:00:00.000Z",
  pid: 1234,
};

describe("cicero pair", () => {
  test("selects tunnel, then LAN, then the documented placeholder", () => {
    expect(selectPairingUrl(state).baseUrl).toBe("https://cicero.tailnet.ts.net/");
    expect(selectPairingUrl({ ...state, tunnelUrl: null }).baseUrl).toBe("https://192.168.1.50:9443/");
    expect(selectPairingUrl(null, { scheme: "http", port: 8090 })).toEqual({
      baseUrl: "http://<this-box-ip>:8090/",
      note: "No live pairing state is available; replace <this-box-ip> with this machine's LAN IP after the daemon starts.",
    });
  });

  test("generates a stable token with a targeted atomic config edit that preserves comments", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-pair-command-"));
    const configPath = join(home, "config.yaml");
    const generated = "generated-stable-token-1234567890";
    writeFileSync(configPath, [
      "# operator comment",
      "web_voice:",
      "  enabled: true # keep this",
      "  port: 8090",
      "",
    ].join("\n"));
    try {
      const result = await pairPhone({}, {
        home,
        generateToken: () => generated,
        readState: () => state,
        renderQr: (value, options) => Promise.resolve(`QR(${options.small}):${value}`),
      });
      const saved = readFileSync(configPath, "utf8");
      expect(saved).toContain("# operator comment");
      expect(saved).toContain("enabled: true # keep this");
      expect(saved).toContain(`  token: ${JSON.stringify(generated)}`);
      expect(result.tokenGenerated).toBe(true);
      expect(result.output).toContain("Restart the Cicero daemon to load the new stable token.");
      expect(result.output).toContain(`https://cicero.tailnet.ts.net/?token=${generated}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs an invalid configured token and does not put it in the QR with --no-token-in-qr", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-pair-no-token-qr-"));
    const generated = "replacement-stable-token-123456";
    writeFileSync(join(home, "config.yaml"), [
      "web_voice:",
      "  enabled: true",
      "  token: too-short",
      "  tunnel: { provider: tailscale }",
      "",
    ].join("\n"));
    try {
      const result = await pairPhone({ tokenInQr: false }, {
        home,
        generateToken: () => generated,
        readState: () => state,
        renderQr: (value) => Promise.resolve(`QR:${value}`),
      });
      expect(result.qrValue).toBe("https://cicero.tailnet.ts.net/");
      expect(result.output).toContain("QR:https://cicero.tailnet.ts.net/");
      expect(result.output).not.toContain(`QR:https://cicero.tailnet.ts.net/?token=${generated}`);
      expect(result.output).toContain(`Token (type this on the phone): ${generated}`);
      expect(result.output).toContain("The QR omits the credential.");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("updates the documented flow-style web_voice block without dropping comments", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-pair-flow-config-"));
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, [
      "# minimal setup comment",
      "web_voice: { enabled: true, port: 8090 } # phone surface",
      "brain: { backend: ollama } # keep brain note",
      "",
    ].join("\n"));
    try {
      await pairPhone({}, {
        home,
        generateToken: () => "flow-style-stable-token-123456",
        readState: () => state,
        renderQr: () => Promise.resolve("QR"),
      });
      const saved = readFileSync(configPath, "utf8");
      expect(saved).toContain("# minimal setup comment");
      expect(saved).toContain("# phone surface");
      expect(saved).toContain("# keep brain note");
      expect(saved).toContain("token: flow-style-stable-token-123456");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("prints exact tunnel guidance without silently adding the tunnel block", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-pair-tunnel-guidance-"));
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, [
      "web_voice:",
      "  enabled: true",
      "  token: already-stable-token-123456789",
      "",
    ].join("\n"));
    try {
      const result = await pairPhone({}, {
        home,
        readState: () => ({ ...state, tunnelProvider: null, tunnelUrl: null }),
        renderQr: () => Promise.resolve("QR"),
      });
      expect(result.output).toContain("Add this line under web_voice: for a daemon-owned tunnel:\n  tunnel: { provider: auto }");
      expect(readFileSync(configPath, "utf8")).not.toContain("tunnel:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails actionably before writing when web voice is disabled", async () => {
    const home = mkdtempSync(join(tmpdir(), "cicero-pair-disabled-"));
    const path = join(home, "config.yaml");
    writeFileSync(path, "web_voice:\n  enabled: false\n");
    try {
      await expect(pairPhone({}, { home })).rejects.toThrow(/Set web_voice.enabled: true/);
      expect(readFileSync(path, "utf8")).not.toContain("token:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
