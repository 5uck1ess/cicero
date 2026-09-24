import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certificateLanIPv4s, startSetupServer, trustedSetupRequest, type SetupServer } from "../../src/setup/server";

const servers: SetupServer[] = [];
const homes: string[] = [];
const home = () => { const value = mkdtempSync(join(tmpdir(), "cicero-setup-server-")); homes.push(value); return value; };
const systemDeps = { platform: () => "linux", arch: () => "x64", release: () => "6.8", homeDir: () => "/fixture", checkout: "/fixture", exists: () => true, statfs: () => ({ bavail: 100, bsize: 4096 }) as ReturnType<typeof import("node:fs")["statfsSync"]>, totalmem: () => 1e9, freemem: () => 5e8, which: () => null };
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("setup server auth", () => {
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
