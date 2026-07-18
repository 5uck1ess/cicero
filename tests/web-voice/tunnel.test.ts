import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../src/config";
import { validateRuntimeConfig } from "../../src/config-validation";
import {
  startWebVoiceTunnel,
  type TunnelProcess,
  type TunnelRuntime,
} from "../../src/web-voice/tunnel";

const PUBLIC_URL = "https://cicero-test.example.ts.net";
const CLOUDFLARE_URL = "https://plain-bird-123.trycloudflare.com";

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function pendingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start() {} });
}

function fakeProcess(output: {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
} = {}): TunnelProcess {
  return {
    pid: 4242,
    exited: new Promise<number>(() => {}),
    kill: () => {},
    stdout: output.stdout ?? stream(),
    stderr: output.stderr ?? stream(),
  };
}

function runtime(overrides: Partial<TunnelRuntime> = {}): TunnelRuntime {
  return {
    which: () => "/usr/bin/tailscale",
    spawn: () => fakeProcess({ stdout: stream(`Available at ${PUBLIC_URL}/\n`) }),
    terminate: () => Promise.resolve(),
    log: () => {},
    ...overrides,
  };
}

describe("web voice tunnel config", () => {
  test("accepts the provider block and rejects unknown nested keys", () => {
    const valid = structuredClone(DEFAULT_CONFIG);
    valid.web_voice = { tunnel: { provider: "auto" } };
    expect(() => validateRuntimeConfig(valid, "test config")).not.toThrow();

    const unknown = structuredClone(DEFAULT_CONFIG) as typeof DEFAULT_CONFIG & {
      web_voice: { tunnel: { provider: "auto"; surprise: boolean } };
    };
    unknown.web_voice = { tunnel: { provider: "auto", surprise: true } };
    expect(() => validateRuntimeConfig(unknown, "test config"))
      .toThrow(/web_voice\.tunnel\.surprise is not supported/);

    const invalid = structuredClone(DEFAULT_CONFIG);
    invalid.web_voice = { tunnel: { provider: "other" as "auto" } };
    expect(() => validateRuntimeConfig(invalid, "test config"))
      .toThrow(/web_voice\.tunnel\.provider/);
  });
});

describe("startWebVoiceTunnel", () => {
  test("auto selects tailscale first without probing cloudflared", async () => {
    const probes: string[] = [];
    const commands: string[][] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "auto" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({
        which: (binary) => {
          probes.push(binary);
          return binary === "tailscale" ? "/opt/tailscale" : "/opt/cloudflared";
        },
        spawn: (command) => {
          commands.push([...command]);
          return fakeProcess({ stdout: stream(`Available at ${PUBLIC_URL}/\n`) });
        },
      }),
    });

    expect(probes).toEqual(["tailscale"]);
    expect(commands[0]?.[0]).toBe("/opt/tailscale");
    expect(handle?.provider).toBe("tailscale");
    expect(handle?.publicUrl).toBe(PUBLIC_URL);
    await handle?.stop();
  });

  test("auto falls back to cloudflared only when tailscale is absent", async () => {
    const probes: string[] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "auto" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({
        which: (binary) => {
          probes.push(binary);
          return binary === "cloudflared" ? "/opt/cloudflared" : null;
        },
        spawn: () => fakeProcess({ stderr: stream(`${CLOUDFLARE_URL}\n`) }),
      }),
    });

    expect(probes).toEqual(["tailscale", "cloudflared"]);
    expect(handle?.provider).toBe("cloudflared");
    await handle?.stop();
  });

  test("an explicitly selected missing provider is an actionable startup error", async () => {
    await expect(startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({ which: () => null }),
    })).rejects.toThrow(/cloudflared.*not found.*install.*PATH/i);
  });

  test("auto errors actionably when neither supported binary exists", async () => {
    await expect(startWebVoiceTunnel({
      config: { provider: "auto" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({ which: () => null }),
    })).rejects.toThrow(/neither tailscale nor cloudflared.*install.*PATH/i);
  });

  test("tailscale uses the configured target and insecure HTTPS upstream mode", async () => {
    const commands: string[][] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "tailscale" },
      localScheme: "https",
      localHost: "192.0.2.10",
      localPort: 8443,
      runtime: runtime({
        which: () => "/opt/tailscale",
        spawn: (command) => {
          commands.push([...command]);
          return fakeProcess({ stdout: stream(PUBLIC_URL) });
        },
      }),
    });

    expect(commands[0]).toEqual([
      "/opt/tailscale",
      "serve",
      "--https=443",
      "https+insecure://192.0.2.10:8443",
    ]);
    await handle?.stop();
  });

  test("parses a cloudflared quick-tunnel URL from bounded stderr", async () => {
    const commands: string[][] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "https",
      localPort: 8443,
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: (command) => {
          commands.push([...command]);
          return fakeProcess({ stderr: stream(`noise\n${CLOUDFLARE_URL}/path?q=ignored\n`) });
        },
      }),
    });

    expect(handle?.publicUrl).toBe(CLOUDFLARE_URL);
    expect(commands[0]).toContain("--no-tls-verify");
    expect(commands[0]).toContain("https://127.0.0.1:8443");
    await handle?.stop();
  });

  test("an output flood is capped, cleaned up, and degrades to local service", async () => {
    let terminations = 0;
    const logs: string[] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      outputLimitBytes: 32,
      deadlineMs: 1_000,
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: () => fakeProcess({ stderr: stream("x".repeat(64)) }),
        terminate: async () => { terminations += 1; },
        log: (_level, message) => { logs.push(message); },
      }),
    });

    expect(handle).toBeNull();
    expect(terminations).toBe(1);
    expect(logs.join("\n")).toMatch(/output limit/i);
    expect(logs.join("\n").length).toBeLessThan(500);
  });

  test("URL discovery has an absolute deadline and degrades to local service", async () => {
    let terminations = 0;
    const logs: string[] = [];
    const started = performance.now();
    const handle = await startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      deadlineMs: 20,
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: () => fakeProcess({ stdout: pendingStream(), stderr: pendingStream() }),
        terminate: async () => { terminations += 1; },
        log: (_level, message) => { logs.push(message); },
      }),
    });

    expect(handle).toBeNull();
    expect(terminations).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
    expect(logs.join("\n")).toMatch(/deadline/i);
  });

  test("stop terminates the exact owned tree once", async () => {
    let terminations = 0;
    const proc = fakeProcess({ stderr: stream(CLOUDFLARE_URL) });
    const handle = await startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: () => proc,
        terminate: async (target) => {
          expect(target).toBe(proc);
          terminations += 1;
        },
      }),
    });

    await Promise.all([handle!.stop(), handle!.stop()]);
    await handle!.stop();
    expect(terminations).toBe(1);
  });

  test("publishes ownership immediately and keeps a failed cleanup retryable", async () => {
    let owner: Pick<NonNullable<Awaited<ReturnType<typeof startWebVoiceTunnel>>>, "stop"> | undefined;
    let terminations = 0;
    const launching = startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      deadlineMs: 10,
      onOwned: (next) => { owner = next; },
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: () => fakeProcess({ stdout: pendingStream(), stderr: pendingStream() }),
        terminate: async () => {
          terminations += 1;
          if (terminations === 1) throw new Error("synthetic reap failure");
        },
      }),
    });

    expect(owner).toBeDefined();
    await expect(launching).rejects.toThrow(/cleanup was not confirmed/);
    await owner!.stop();
    expect(terminations).toBe(2);
  });

  test("untrusted subprocess output never reaches tunnel logs", async () => {
    const secret = "synthetic-token-that-must-not-be-logged";
    const logs: string[] = [];
    const handle = await startWebVoiceTunnel({
      config: { provider: "cloudflared" },
      localScheme: "http",
      localPort: 8090,
      runtime: runtime({
        which: () => "/opt/cloudflared",
        spawn: () => fakeProcess({
          stderr: stream(`token=${secret}\n${CLOUDFLARE_URL}/?token=${secret}\n`),
        }),
        log: (_level, message) => { logs.push(message); },
      }),
    });

    expect(handle?.publicUrl).toBe(CLOUDFLARE_URL);
    expect(logs.join("\n")).not.toContain(secret);
    await handle?.stop();
  });
});
