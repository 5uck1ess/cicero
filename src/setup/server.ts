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
import { detectSystem, type SystemDeps, type SystemFacts } from "./system";
import { probeRemoteProviderModels, type PickerDeps, type ProviderModelList } from "./pickers";
import { backupInvalidConfig, inspectExistingConfig, writeDraft } from "./write";
import type { Check, DoctorCheckOptions } from "../cli/doctor";
import { redactSnapshotSecrets } from "../operational-state";
import { ciceroHome } from "../platform/paths";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
export function mergeDraft<T extends Record<string, unknown>>(base: T, contribution: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(contribution)) {
    const previous = merged[key];
    merged[key] = value && typeof value === "object" && !Array.isArray(value) && previous && typeof previous === "object" && !Array.isArray(previous)
      ? mergeDraft(previous as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return merged as T;
}

function publicDraft(draft: SetupDraft): SetupDraft {
  const copy = structuredClone(draft);
  function mask(value: Record<string, unknown>): void {
    for (const [key, child] of Object.entries(value)) {
      if (["apiKey", "api_key", "token"].includes(key) && typeof child === "string") value[key] = "set";
      else if (child && typeof child === "object" && !Array.isArray(child)) mask(child as Record<string, unknown>);
    }
  }
  mask(copy);
  return copy;
}

function draftSecrets(draft: SetupDraft): string[] {
  const secrets: string[] = [];
  function collect(value: Record<string, unknown>): void {
    for (const [key, child] of Object.entries(value)) {
      if (["apiKey", "api_key", "token"].includes(key) && typeof child === "string") secrets.push(child);
      else if (child && typeof child === "object" && !Array.isArray(child)) collect(child as Record<string, unknown>);
    }
  }
  collect(draft);
  return secrets;
}

function redactStateValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "<redacted>") : text, value);
  if (Array.isArray(value)) return value.map((item) => redactStateValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStateValue(item, secrets)]));
  return value;
}

function publicChecks(checks: Check[] | null, draft: SetupDraft): Check[] | null {
  if (!checks) return null;
  const secrets = draftSecrets(draft);
  const hide = (line: string | undefined) => line === undefined ? undefined : secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "<redacted>") : text, line);
  return checks.map((check) => ({ ...check, name: hide(check.name)!, detail: hide(check.detail)!, ...(check.hint ? { hint: hide(check.hint) } : {}) }));
}

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
  pickerDeps?: PickerDeps;
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
  const choices = new Map<string, unknown>();
  let providerModels: ProviderModelList | null = null;
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
    const safeChecks = checks === null || checksRevision !== draftRevision ? null : publicChecks(checks, draft);
    const checkGroups = safeChecks === null ? null : classifySetupChecks(safeChecks);
    const existing = inspectExistingConfig(home);
    return redactStateValue({
      steps: SETUP_STEPS.map(({ id, title, explain, pipeline, available }) => ({ id, title, explain, pipeline, available })),
      current, detected, system, tier: draft.deployment, providerModels, selectedChoices: Object.fromEntries([...choices].map(([id, choice]) => [id, typeof choice === "string" ? choice : (choice as { id?: string }).id])), storedSecrets: Object.fromEntries([...choices].map(([id, choice]) => [id, Boolean(choice && typeof choice === "object" && ((choice as Record<string, unknown>).apiKey || (choice as Record<string, unknown>).api_key))])), checks: safeChecks, checkGroups, yaml: renderDraft(publicDraft(draft)),
      existing, written, finished, startCommand: handoff.startCommand, handoff,
      canWrite: !written && checkGroups !== null && checkGroups.blocking.length === 0 && existing.status === "missing",
      requiresNotReadyAcknowledgement: (checkGroups?.notReady.length ?? 0) > 0,
    }, draftSecrets(draft));
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
        if (url.pathname === "/api/provider-models") {
          const prior = choices.get("provider") as { id?: string; apiKey?: string } | undefined;
          const raw = data.choice && typeof data.choice === "object" && !Array.isArray(data.choice) ? data.choice as Record<string, unknown> : null;
          const savedKey = prior && raw && raw.id === prior.id && !raw.apiKey ? prior.apiKey : undefined;
          providerModels = await probeRemoteProviderModels(savedKey && raw ? { ...raw, apiKey: savedKey } : data.choice, options.pickerDeps);
          return json({ models: providerModels.models });
        } else if (url.pathname === "/api/step") {
          const step = SETUP_STEPS.find((item) => item.id === data.id);
          if (!step) return json({ error: "Unknown step" }, 400);
          detected = await step.detect({ system, draft }, options.pickerDeps);
          current = step.id;
        } else if (url.pathname === "/api/choice") {
          if (written) return json({ error: "Config already written" }, 409);
          const step = SETUP_STEPS.find((item) => item.id === data.id && item.available && !["check", "write", "handoff"].includes(item.id));
          if (!step) return json({ error: "Unknown setup choice" }, 400);
          const prior = choices.get(step.id);
          let rawChoice = data.choice;
          if (rawChoice && typeof rawChoice === "object" && !Array.isArray(rawChoice)
            && prior && typeof prior === "object"
            && (rawChoice as { id?: string }).id === (prior as { id?: string }).id) {
            if (!(rawChoice as { companyId?: unknown }).companyId && typeof (prior as { companyId?: unknown }).companyId === "string")
              rawChoice = { ...(rawChoice as Record<string, unknown>), companyId: (prior as { companyId: string }).companyId };
            const priorKey = (prior as Record<string, unknown>).apiKey ?? (prior as Record<string, unknown>).api_key;
            if (!(rawChoice as { apiKey?: unknown }).apiKey && typeof priorKey === "string") rawChoice = { ...(rawChoice as Record<string, unknown>), apiKey: priorKey };
          }
          const parsed = step.parseChoice(rawChoice, { system, draft, ...(current === step.id ? { detected } : {}) }, { ...options.pickerDeps, allowedModels: providerModels });
          if (parsed && typeof parsed === "object" && prior && typeof prior === "object"
            && (parsed as { id?: string }).id === (prior as { id?: string }).id) {
            for (const key of ["apiKey", "api_key"] as const) {
              if (!(parsed as Record<string, unknown>)[key] && (prior as Record<string, unknown>)[key])
                (parsed as Record<string, unknown>)[key] = (prior as Record<string, unknown>)[key];
            }
          }
          let probe: { ok: boolean; message: string } | undefined;
          if (step.probeChoice) {
            probe = await step.probeChoice(parsed, options.pickerDeps);
            detected = { ...(detected && typeof detected === "object" ? detected : {}), probe };
          }
          if (probe?.ok === false) return json(view());
          choices.set(step.id, parsed);
          draft = createDraft((choices.get("system") as SetupDraft["deployment"] | undefined) ?? system.recommendedTier, draft.web_voice.token);
          for (const item of SETUP_STEPS) {
            if (!choices.has(item.id)) continue;
            draft = mergeDraft(draft, item.contribute({ system, draft }, choices.get(item.id))) as SetupDraft;
          }
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
        return json({ error: redactStateValue(redactSnapshotSecrets(error instanceof Error ? error.message : "Setup request failed"), draftSecrets(draft)) }, status);
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
