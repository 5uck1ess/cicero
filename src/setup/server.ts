import { randomBytes, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { join, posix, win32 } from "node:path";
import { readRequestJsonLimited, RequestBodyTooLargeError, RequestBodyTimeoutError } from "../http-request-body";
import { assertWebTlsPolicy, ensureTls, type TlsMaterial } from "../web-voice/tls";
import { ensurePrivateDirectorySync } from "../platform/secure-storage";
import { checkDraft, createDraft, renderDraft, type SetupDraft } from "./draft";
import { classifySetupChecks } from "./checks";
import { setupPage } from "./page";
import { SETUP_STEPS } from "./steps";
import { detectSystem, type SystemDeps, type SystemFacts, type Tier } from "./system";
import { backupInvalidConfig, inspectExistingConfig, writeDraft } from "./write";
import type { Check, DoctorCheckOptions } from "../cli/doctor";
import { redactSnapshotSecrets } from "../operational-state";
import { ciceroHome } from "../platform/paths";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const TIERS = new Set<Tier>(["local-mlx", "local-cuda", "local-cpu"]);

export interface SetupHandoff {
  startCommand: string;
  customHome: boolean;
  sourceConfigPath: string;
  defaultConfigPath: string;
  copyCommand?: string;
}

/** The daemon has one fixed home; --home is an isolated setup trial. */
export function setupHandoff(
  home: string,
  defaultHome: string = ciceroHome(),
  platform: string = process.platform,
  cliAvailable: boolean = Boolean(Bun.which("cicero")),
): SetupHandoff {
  const path = platform === "win32" ? win32 : posix;
  const sourceHome = path.resolve(home);
  const daemonHome = path.resolve(defaultHome);
  const sameHome = platform === "win32"
    ? sourceHome.toLowerCase() === daemonHome.toLowerCase()
    : sourceHome === daemonHome;
  const sourceConfigPath = path.join(sourceHome, "config.yaml");
  const defaultConfigPath = path.join(daemonHome, "config.yaml");
  const quote = platform === "win32"
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const copyCommand = sameHome ? undefined : platform === "win32"
    ? `New-Item -ItemType Directory -Force -Path ${quote(daemonHome)} | Out-Null; if (Test-Path -LiteralPath ${quote(defaultConfigPath)}) { throw 'Destination config already exists' }; Copy-Item -LiteralPath ${quote(sourceConfigPath)} -Destination ${quote(defaultConfigPath)}`
    : `mkdir -p ${quote(daemonHome)} && cp -n ${quote(sourceConfigPath)} ${quote(defaultConfigPath)}`;
  return {
    startCommand: cliAvailable ? "cicero start" : "bun run src/index.ts start",
    customHome: !sameHome,
    sourceConfigPath,
    defaultConfigPath,
    ...(copyCommand ? { copyCommand } : {}),
  };
}

/** Read the exact LAN IPs the browser certificate covers, including reused pairs. */
export function certificateLanIPv4s(cert: string): string[] {
  const sans = new X509Certificate(cert).subjectAltName ?? "";
  const ips = [...sans.matchAll(/(?:^|,\s*)IP Address:([0-9.]+)(?=,|$)/g)]
    .map((match) => match[1]!)
    .filter((ip) => isIP(ip) === 4 && !ip.startsWith("127."));
  return [...new Set(ips)];
}

export function trustedSetupRequest(req: Request, options: { lan: boolean; port: number; lanAddresses: readonly string[] }): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  if (/[\\/?#@\s]/.test(host) || host.endsWith(":")) return false;
  let parsed: URL;
  try { parsed = new URL(`${options.lan ? "https" : "http"}://${host}/`); }
  catch { return false; }
  const port = parsed.port === "" ? (options.lan ? 443 : 80) : Number(parsed.port);
  if (parsed.username || parsed.password || port !== options.port) return false;
  const allowed = options.lan ? new Set([...LOOPBACK, ...options.lanAddresses]) : LOOPBACK;
  if (!allowed.has(parsed.hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const source = new URL(origin);
      if (options.lan) {
        if (source.origin !== parsed.origin) return false;
      } else if (!LOOPBACK.has(source.hostname)) return false;
    } catch { return false; }
  }
  return true;
}

export interface SetupServerOptions {
  home: string;
  lan?: boolean;
  port?: number;
  systemDeps?: SystemDeps;
  doctorOptions?: DoctorCheckOptions;
  /** Test-only check runner; production runs the real loadConfig + doctor path. */
  check?: typeof checkDraft;
  lanAddresses?: string[];
  tls?: () => Promise<TlsMaterial | null>;
  token?: string;
  output?: (line: string) => void;
  now?: () => number;
  /** Test-only host binding override; the Host gate still uses lanAddresses. */
  hostname?: string;
  /** Test-only listener factory; permits handler tests without opening a socket. */
  serve?: typeof Bun.serve;
  /** Test-only timer injection for the hand-off shutdown path. */
  scheduleStop?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> | number;
  cancelScheduledStop?: (timer: ReturnType<typeof setTimeout> | number) => void;
  /** Test overrides for deterministic hand-off paths and command selection. */
  defaultHome?: string;
  platform?: string;
  cliAvailable?: boolean;
}

export interface SetupServer {
  url: string;
  port: number;
  token: string;
  closed: AbortSignal;
  stop(): Promise<void>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export async function startSetupServer(options: SetupServerOptions): Promise<SetupServer> {
  const home = options.home;
  ensurePrivateDirectorySync(home);
  const lan = options.lan === true;
  const tls = lan ? await (options.tls ?? (() => ensureTls({ dir: join(home, "setup-tls") })))() : null;
  if (lan) {
    if (!tls) throw new Error("setup --lan requires TLS; certificate generation returned no certificate");
    assertWebTlsPolicy("0.0.0.0", tls, false);
  }
  // The cert itself is the source of truth: tls.ts puts its non-internal IPv4
  // addresses in SANs, and a reused certificate may cover fewer current IPs.
  const addresses = options.lanAddresses ?? (tls ? certificateLanIPv4s(tls.cert) : []);
  const token = options.token ?? randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{32,}$/.test(token)) throw new Error("setup token must contain at least 128 random bits in hexadecimal form");
  const system: SystemFacts = await detectSystem(options.systemDeps);
  let draft: SetupDraft = createDraft(system.recommendedTier);
  let draftRevision = 0;
  let current = "system";
  let detected: unknown = await SETUP_STEPS[0]!.detect({ system, draft }, options.systemDeps);
  let checks: Check[] | null = null;
  let checksRevision: number | null = null;
  let written = false;
  let finished = false;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let handoffTimer: ReturnType<typeof setTimeout> | number | null = null;
  const closed = new AbortController();
  const handoff = setupHandoff(home, options.defaultHome, options.platform, options.cliAvailable);

  const view = () => {
    const checkGroups = checks === null || checksRevision !== draftRevision ? null : classifySetupChecks(checks);
    const existing = inspectExistingConfig(home);
    return {
      steps: SETUP_STEPS.map(({ id, title, explain, pipeline, available }) => ({ id, title, explain, pipeline, available })),
      current, detected, system, tier: draft.deployment, checks: checkGroups ? checks : null, checkGroups, yaml: renderDraft(draft),
      existing, written, finished, startCommand: handoff.startCommand, handoff,
      canWrite: !written && checkGroups !== null && checkGroups.blocking.length === 0 && existing.status === "missing",
      requiresNotReadyAcknowledgement: (checkGroups?.notReady.length ?? 0) > 0,
    };
  };
  let server: ReturnType<typeof Bun.serve>;
  server = (options.serve ?? Bun.serve)({
    hostname: options.hostname ?? (lan ? "0.0.0.0" : "127.0.0.1"),
    port: options.port ?? 0,
    ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
    async fetch(req) {
      try {
        if (!trustedSetupRequest(req, { lan, port: server.port ?? 0, lanAddresses: addresses })) return json({ error: "Untrusted Host or Origin" }, 403);
        const url = new URL(req.url);
        const firstPage = req.method === "GET" && url.pathname === "/";
        const suppliedToken = firstPage ? url.searchParams.get("token") ?? req.headers.get("x-cicero-setup-token") : req.headers.get("x-cicero-setup-token");
        if (suppliedToken !== token) return json({ error: "Setup token required" }, 401);
        if (req.method !== "GET" && req.headers.get("x-cicero-setup-csrf") !== "1") return json({ error: "CSRF header required" }, 403);
        if (firstPage) return new Response(setupPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
        if (req.method === "GET" && url.pathname === "/api/state") return json(view());
        if (req.method !== "POST") return json({ error: "Not found" }, 404);
        const body = await readRequestJsonLimited(req, { maxBytes: 2048, timeoutMs: 5000 });
        if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Expected JSON object" }, 400);
        const data = body as Record<string, unknown>;
        if (url.pathname === "/api/step") {
          const step = SETUP_STEPS.find((item) => item.id === data.id);
          if (!step) return json({ error: "Unknown step" }, 400);
          detected = await step.detect({ system, draft }, options.systemDeps);
          current = step.id;
        } else if (url.pathname === "/api/choice") {
          if (written) return json({ error: "Config already written" }, 409);
          const step = SETUP_STEPS.find((item) => item.id === data.id && item.available);
          if (!step || step.id !== "system" || typeof data.choice !== "string" || !TIERS.has(data.choice as Tier)) return json({ error: "Unknown setup choice" }, 400);
          draft = { ...draft, ...step.contribute({ system, draft }, data.choice) } as SetupDraft;
          draftRevision += 1;
          checks = null;
          checksRevision = null;
        } else if (url.pathname === "/api/check") {
          const revision = draftRevision;
          const checkedDraft = draft;
          checks = null;
          checksRevision = null;
          const result = await (options.check ?? checkDraft)(checkedDraft, options.doctorOptions);
          if (revision !== draftRevision) return json({ error: "Draft changed during Check. Run Check again" }, 409);
          checks = result;
          checksRevision = revision;
          current = "check";
        } else if (url.pathname === "/api/backup") {
          backupInvalidConfig(home, options.now);
          current = "write";
        } else if (url.pathname === "/api/write") {
          if (checks === null || checksRevision !== draftRevision) return json({ error: "Run Check again before writing" }, 409);
          const groups = classifySetupChecks(checks);
          if (groups.blocking.length > 0) return json({ error: "Resolve config validity failures before writing" }, 409);
          if (groups.notReady.length > 0 && data.acknowledgeNotReady !== true) {
            return json({ error: "Acknowledge that runtime components are not ready yet before writing" }, 409);
          }
          writeDraft(home, draft);
          written = true;
          current = "handoff";
        } else if (url.pathname === "/api/handoff") {
          if (!written) return json({ error: "Write config first" }, 409);
          finished = true;
          current = "handoff";
          if (handoffTimer === null) {
            handoffTimer = (options.scheduleStop ?? setTimeout)(() => {
              handoffTimer = null;
              void stop();
            }, 500);
          }
        } else return json({ error: "Not found" }, 404);
        return json(view());
      } catch (error) {
        const status = error instanceof RequestBodyTooLargeError ? 413 : error instanceof RequestBodyTimeoutError ? 408 : 400;
        return json({ error: redactSnapshotSecrets(error instanceof Error ? error.message : "Setup request failed") }, status);
      }
    },
  });
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (stopped) return;
      stopped = true;
      if (handoffTimer !== null) {
        (options.cancelScheduledStop ?? clearTimeout)(handoffTimer);
        handoffTimer = null;
      }
      try { await Promise.resolve(server.stop(true)); }
      finally { closed.abort(); }
    })();
    return stopPromise;
  }
  const displayHost = lan ? (addresses[0] ?? "127.0.0.1") : "127.0.0.1";
  const url = `${lan ? "https" : "http"}://${displayHost}:${server.port}/?token=${token}`;
  (options.output ?? console.log)(url);
  return { url, port: server.port ?? 0, token, closed: closed.signal, stop };
}
