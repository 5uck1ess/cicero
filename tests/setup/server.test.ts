import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateLanIPv4s, setupHandoff, startSetupServer, trustedSetupRequest, type SetupServer } from "../../src/setup/server";
import { createDraft } from "../../src/setup/draft";
import { writeDraft } from "../../src/setup/write";

const servers: SetupServer[] = [];
const homes: string[] = [];
const home = () => { const value = mkdtempSync(join(tmpdir(), "cicero-setup-server-")); homes.push(value); return value; };
const systemDeps = { platform: () => "linux", arch: () => "x64", release: () => "6.8", homeDir: () => "/fixture", checkout: "/fixture", exists: () => true, statfs: () => ({ bavail: 100, bsize: 4096 }) as ReturnType<typeof import("node:fs")["statfsSync"]>, totalmem: () => 1e9, freemem: () => 5e8, which: () => null };
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("setup server auth", () => {
  test("default home keeps the start command; custom homes show OS-specific copy commands", () => {
    const dir = home();
    const normal = setupHandoff(dir, dir, "linux", true);
    expect(normal.customHome).toBe(false);
    expect(normal.startCommand).toBe("cicero start");
    expect(normal.copyCommand).toBeUndefined();
    const trial = setupHandoff(join(dir, "trial home"), dir, "linux", false);
    expect(trial.customHome).toBe(true);
    expect(trial.startCommand).toBe("bun run src/index.ts start");
    expect(trial.sourceConfigPath).toBe(join(dir, "trial home", "config.yaml"));
    expect(trial.defaultConfigPath).toBe(join(dir, "config.yaml"));
    expect(trial.copyCommand).toContain("cp -n");
    expect(trial.copyCommand).toContain(`'${trial.sourceConfigPath}'`);
    const windows = setupHandoff("C:\\trial home", "C:\\Users\\operator\\.cicero", "win32", true);
    expect(windows.customHome).toBe(true);
    expect(windows.copyCommand).toContain("Copy-Item -LiteralPath 'C:\\trial home\\config.yaml'");
    expect(windows.copyCommand).toContain("-Destination 'C:\\Users\\operator\\.cicero\\config.yaml'");
  });
  test("server state carries the custom-home hand-off paths", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 9999, stop: () => {} }; }) as unknown as typeof Bun.serve;
    const defaultHome = home();
    const trialHome = home();
    const server = await startSetupServer({ home: trialHome, defaultHome, platform: "linux", cliAvailable: true, systemDeps, output: () => {}, serve });
    servers.push(server);
    const response = await handler(new Request(`http://127.0.0.1:${server.port}/api/state`, {
      headers: { host: `127.0.0.1:${server.port}`, "x-cicero-setup-token": server.token },
    }));
    const state = await response.json() as { handoff: { customHome: boolean; sourceConfigPath: string; defaultConfigPath: string; copyCommand: string } };
    expect(state.handoff.customHome).toBe(true);
    expect(state.handoff.sourceConfigPath).toBe(join(trialHome, "config.yaml"));
    expect(state.handoff.defaultConfigPath).toBe(join(defaultHome, "config.yaml"));
    expect(state.handoff.copyCommand).toContain("cp -n");
  });
  test("actions.yaml errors are shown without offering a config backup", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 9999, stop: () => {} }; }) as unknown as typeof Bun.serve;
    const dir = home();
    writeDraft(dir, createDraft("local-cpu", "e".repeat(64)));
    writeFileSync(join(dir, "actions.yaml"), "actionz: {}\nactions: {}\n", { mode: 0o600 });
    const server = await startSetupServer({ home: dir, systemDeps, output: () => {}, serve });
    servers.push(server);
    const headers = { host: `127.0.0.1:${server.port}`, "x-cicero-setup-token": server.token };
    const stateResponse = await handler(new Request(`http://127.0.0.1:${server.port}/api/state`, { headers }));
    const state = await stateResponse.json() as { existing: { status: string; error: string }; canWrite: boolean };
    expect(state.existing.status).toBe("other-file-error");
    expect(state.existing.error).toContain("actionz is not supported");
    expect(state.canWrite).toBe(false);
    const backup = await handler(new Request(`http://127.0.0.1:${server.port}/api/backup`, {
      method: "POST", headers: { ...headers, "x-cicero-setup-csrf": "1" }, body: "{}",
    }));
    expect(backup.status).toBe(400);
  });
  test("loopback rejects missing/wrong token, foreign Host/Origin, and missing CSRF", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => {
      handler = options.fetch;
      return { port: 9999, stop: () => {} };
    }) as unknown as typeof Bun.serve;
    const server = await startSetupServer({ home: home(), port: 0, systemDeps, output: () => {}, serve }); servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const send = (path: string, init?: RequestInit) => handler(new Request(`${base}${path}`, { ...init, headers: { host: `127.0.0.1:${server.port}`, ...init?.headers } }));
    expect((await send("/api/state")).status).toBe(401);
    expect((await send("/api/state", { headers: { "x-cicero-setup-token": "wrong" } })).status).toBe(401);
    const auth = { "x-cicero-setup-token": server.token };
    expect((await send("/api/state", { headers: { ...auth, host: `evil.test:${server.port}` } })).status).toBe(403);
    expect((await send("/api/state", { headers: { ...auth, origin: "https://evil.test" } })).status).toBe(403);
    expect((await send("/api/step", { method: "POST", headers: auth, body: JSON.stringify({ id: "system" }) })).status).toBe(403);
    expect((await send("/api/step", { method: "POST", headers: { ...auth, "x-cicero-setup-csrf": "1" }, body: JSON.stringify({ id: "system" }) })).status).toBe(200);
  });
  test("LAN server accepts a SAN LAN Host and rejects a foreign Host", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => {
      handler = options.fetch;
      return { port: 9999, stop: () => {} };
    }) as unknown as typeof Bun.serve;
    const server = await startSetupServer({ home: home(), port: 0, lan: true, lanAddresses: ["192.168.1.44"], tls: async () => ({ cert: "fixture", key: "fixture" }), systemDeps, output: () => {}, serve });
    servers.push(server);
    const headers = { "x-cicero-setup-token": server.token };
    const good = new Request("https://192.168.1.44:9999/api/state", { headers: { ...headers, host: "192.168.1.44:9999", origin: "https://192.168.1.44:9999" } });
    const bad = new Request("https://192.168.1.44:9999/api/state", { headers: { ...headers, host: "evil.test:9999" } });
    expect((await handler(good)).status).toBe(200);
    expect((await handler(bad)).status).toBe(403);
  });
  test("LAN Host gate requires the Origin to match Host", () => {
    const good = new Request("https://192.168.1.44:9999/", { headers: { host: "192.168.1.44:9999", origin: "https://192.168.1.44:9999" } });
    const bad = new Request("https://192.168.1.44:9999/", { headers: { host: "192.168.1.44:9999", origin: "https://127.0.0.1:9999" } });
    expect(trustedSetupRequest(good, { lan: true, port: 9999, lanAddresses: ["192.168.1.44"] })).toBe(true);
    expect(trustedSetupRequest(bad, { lan: true, port: 9999, lanAddresses: ["192.168.1.44"] })).toBe(false);
  });
  test("default HTTP port 80 accepts a Host without an explicit port", () => {
    const req = new Request("http://localhost/api/state", { headers: { host: "localhost", origin: "http://localhost" } });
    expect(trustedSetupRequest(req, { lan: false, port: 80, lanAddresses: [] })).toBe(true);
    expect(trustedSetupRequest(req, { lan: false, port: 8080, lanAddresses: [] })).toBe(false);
  });
  test("default HTTPS port 443 accepts a LAN Host without an explicit port", () => {
    const req = new Request("https://192.168.1.44/api/state", { headers: { host: "192.168.1.44", origin: "https://192.168.1.44" } });
    expect(trustedSetupRequest(req, { lan: true, port: 443, lanAddresses: ["192.168.1.44"] })).toBe(true);
    expect(trustedSetupRequest(req, { lan: true, port: 8443, lanAddresses: ["192.168.1.44"] })).toBe(false);
  });
  test("LAN Host allow-list uses the same IPv4 SANs as the TLS certificate", () => {
    const cert = readFileSync(join(import.meta.dir, "lan-cert.pem"), "utf8");
    expect(certificateLanIPv4s(cert)).toEqual(["192.168.1.44"]);
  });
  test("LAN server derives its Host allow-list from the injected certificate", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => {
      handler = options.fetch;
      return { port: 9999, stop: () => {} };
    }) as unknown as typeof Bun.serve;
    const cert = readFileSync(join(import.meta.dir, "lan-cert.pem"), "utf8");
    const server = await startSetupServer({ home: home(), port: 0, lan: true, tls: async () => ({ cert, key: "fixture" }), systemDeps, output: () => {}, serve });
    servers.push(server);
    const request = (host: string) => new Request(`https://${host}:9999/api/state`, {
      headers: { host: `${host}:9999`, "x-cicero-setup-token": server.token },
    });
    expect(server.url).toStartWith("https://192.168.1.44:9999/");
    expect((await handler(request("192.168.1.44"))).status).toBe(200);
    expect((await handler(request("192.168.1.45"))).status).toBe(403);
  });
  test("LAN startup refuses a null TLS result", async () => {
    await expect(startSetupServer({ home: home(), lan: true, lanAddresses: ["192.168.1.44"], tls: async () => null, systemDeps, output: () => {} })).rejects.toThrow("setup --lan requires TLS");
  });
  test("runtime failures require acknowledgement before Write and hand-off timer has one owner", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    let stopCalls = 0;
    let scheduled = 0;
    let cancelled = 0;
    const serve = ((options: { fetch: typeof handler }) => {
      handler = options.fetch;
      return { port: 9999, stop: () => { stopCalls += 1; } };
    }) as unknown as typeof Bun.serve;
    const dir = home();
    const server = await startSetupServer({
      home: dir, port: 0, systemDeps, output: () => {}, serve,
      check: async () => [
        { name: "config", level: "ok", detail: "valid" },
        { name: "stt (faster-whisper)", level: "fail", detail: "venv missing", hint: "install STT" },
        { name: "llm (ollama)", level: "fail", detail: "not running", hint: "start Ollama" },
      ],
      scheduleStop: () => { scheduled += 1; return 42; },
      cancelScheduledStop: () => { cancelled += 1; },
    });
    servers.push(server);
    const send = (path: string, body: object) => handler(new Request(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers: { host: `127.0.0.1:${server.port}`, "x-cicero-setup-token": server.token, "x-cicero-setup-csrf": "1" }, body: JSON.stringify(body),
    }));
    const checked = await send("/api/check", {});
    expect(checked.status).toBe(200);
    const state = await checked.json() as { canWrite: boolean; checkGroups: { notReady: unknown[]; blocking: unknown[] } };
    expect(state.canWrite).toBe(true);
    expect(state.checkGroups.notReady).toHaveLength(2);
    expect(state.checkGroups.blocking).toHaveLength(0);
    const denied = await send("/api/write", {});
    expect(denied.status).toBe(409);
    expect((await denied.json() as { error: string }).error).toContain("Acknowledge");
    expect((await send("/api/write", { acknowledgeNotReady: true })).status).toBe(200);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toContain("headless: true");
    expect((await send("/api/handoff", {})).status).toBe(200);
    expect((await send("/api/handoff", {})).status).toBe(200);
    expect(scheduled).toBe(1);
    await server.stop();
    await server.stop();
    expect(cancelled).toBe(1);
    expect(stopCalls).toBe(1);
  });
  test("a Check finishing after a draft choice cannot authorize Write", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 9999, stop: () => {} }; }) as unknown as typeof Bun.serve;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    let finishOldCheck!: (checks: { name: string; level: "ok"; detail: string }[]) => void;
    let checkCalls = 0;
    const server = await startSetupServer({
      home: home(), systemDeps, output: () => {}, serve,
      check: async () => {
        checkCalls += 1;
        if (checkCalls > 1) return [{ name: "config", level: "ok", detail: "new draft" }];
        checkStarted();
        return new Promise((resolve) => { finishOldCheck = resolve; });
      },
    });
    servers.push(server);
    const headers = { host: `127.0.0.1:${server.port}`, "x-cicero-setup-token": server.token, "x-cicero-setup-csrf": "1" };
    const send = (path: string, body: object) => handler(new Request(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers, body: JSON.stringify(body),
    }));
    const pending = send("/api/check", {});
    await started;
    expect((await send("/api/choice", { id: "system", choice: "local-mlx" })).status).toBe(200);
    finishOldCheck([{ name: "config", level: "ok", detail: "old draft" }]);
    expect((await pending).status).toBe(409);
    const rejected = await send("/api/write", {});
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as { error: string }).error).toContain("Run Check again");
    const checked = await send("/api/check", {});
    const state = await checked.json() as { tier: string; canWrite: boolean; checks: { detail: string }[] };
    expect(state.tier).toBe("local-mlx");
    expect(state.canWrite).toBe(true);
    expect(state.checks[0]?.detail).toBe("new draft");
  });
  test("config validity failures still block Write even with acknowledgement", async () => {
    let handler: (request: Request) => Response | Promise<Response> = () => new Response("missing");
    const serve = ((options: { fetch: typeof handler }) => { handler = options.fetch; return { port: 9999, stop: () => {} }; }) as unknown as typeof Bun.serve;
    const server = await startSetupServer({ home: home(), port: 0, systemDeps, output: () => {}, serve, check: async () => [{ name: "web_voice TLS", level: "fail", detail: "missing TLS" }] });
    servers.push(server);
    const send = (path: string, body: object) => handler(new Request(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST", headers: { host: `127.0.0.1:${server.port}`, "x-cicero-setup-token": server.token, "x-cicero-setup-csrf": "1" }, body: JSON.stringify(body),
    }));
    const checked = await send("/api/check", {});
    expect((await checked.json() as { canWrite: boolean }).canWrite).toBe(false);
    expect((await send("/api/write", { acknowledgeNotReady: true })).status).toBe(409);
  });
});
