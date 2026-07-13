import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { log } from "../logger";

export interface TlsMaterial {
  cert: string; // PEM
  key: string;  // PEM
}

export interface EnsureTlsOptions {
  dir: string;
  certFile?: string;
  keyFile?: string;
  signal?: AbortSignal;
  /** Test/packaging override; production defaults to the openssl on PATH. */
  opensslBinary?: string;
  /** Test override for deterministic subprocess failure and concurrency cases. */
  generatorCommand?: (keyPath: string, certPath: string) => string[];
  /** Absolute generation deadline. Production defaults to 15 seconds. */
  generationTimeoutMs?: number;
}

interface GeneratedTlsManifest {
  version: 1;
  certFile: string;
  keyFile: string;
}

interface GeneratorResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

const GENERATED_TLS_MANIFEST = ".tls-pair.json";
const DEFAULT_GENERATION_TIMEOUT_MS = 15_000;
const STDERR_TAIL_BYTES = 16 * 1024;
const MAX_GENERATED_TLS_FILE_BYTES = 1024 * 1024;
const STALE_ARTIFACT_AGE_MS = 60 * 60 * 1000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CERT_FILE_PATTERN = new RegExp(`^\\.tls-cert-(${UUID_PATTERN})\\.pem$`, "i");
const KEY_FILE_PATTERN = new RegExp(`^\\.tls-key-(${UUID_PATTERN})\\.pem$`, "i");
const GENERATED_ARTIFACT_PATTERN = new RegExp(
  `^\\.tls-(?:cert|key)-${UUID_PATTERN}\\.pem$|^\\.tls-manifest-${UUID_PATTERN}\\.tmp$`,
  "i",
);
const LEGACY_TEMP_PATTERN = /^\.(?:cert|key)-[0-9a-f-]+\.tmp$/i;

class TlsGenerationAbortedError extends Error {
  constructor(reason?: unknown) {
    super("web-voice TLS generation aborted", reason === undefined ? undefined : { cause: reason });
    this.name = "TlsGenerationAbortedError";
  }
}

/** Every non-internal IPv4 address on this host — so the self-signed cert's SAN
 *  matches whatever LAN IP the browser uses to reach a headless box. */
function localIPv4s(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const address of addrs ?? []) {
      if (address.family === "IPv4" && !address.internal) out.push(address.address);
    }
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function loadPair(certPath: string, keyPath: string): Promise<TlsMaterial> {
  try {
    const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
    if (!cert.includes("-----BEGIN CERTIFICATE-----")) throw new Error("certificate file is not PEM");
    if (!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(key)) throw new Error("private-key file is not PEM");
    return { cert, key };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not load TLS certificate pair: ${detail}`, { cause: err });
  }
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`TLS directory must be a real directory: ${dir}`);
    }
    await chmod(dir, 0o700);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not secure TLS directory ${dir}: ${detail}`, { cause: err });
  }
}

async function assertOwnedRegularPair(certPath: string, keyPath: string): Promise<void> {
  try {
    const [certInfo, keyInfo] = await Promise.all([lstat(certPath), lstat(keyPath)]);
    if (!certInfo.isFile() || certInfo.isSymbolicLink() || !keyInfo.isFile() || keyInfo.isSymbolicLink()) {
      throw new Error("generated TLS paths must be regular files, not links or directories");
    }
    if (certInfo.size > MAX_GENERATED_TLS_FILE_BYTES || keyInfo.size > MAX_GENERATED_TLS_FILE_BYTES) {
      throw new Error("generated TLS files exceed the 1 MiB safety limit");
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`unsafe generated TLS pair: ${detail}`, { cause: err });
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function generationArgs(keyPath: string, certPath: string): string[] {
  const sans = ["DNS:localhost", "IP:127.0.0.1", ...localIPv4s().map((ip) => `IP:${ip}`)];
  return [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-days", "825", "-subj", "/CN=cicero-voice",
    "-addext", `subjectAltName=${sans.join(",")}`,
  ];
}

function throwIfGenerationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TlsGenerationAbortedError(signal.reason);
}

async function captureStderrTail(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  let tail = new Uint8Array(0);
  const cancelRead = () => {
    void reader.cancel(signal.reason).catch(() => { /* a forced close may already have released the pipe */ });
  };
  signal.addEventListener("abort", cancelRead, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value.byteLength >= STDERR_TAIL_BYTES) {
        tail = value.slice(value.byteLength - STDERR_TAIL_BYTES);
        continue;
      }
      const keep = Math.min(tail.byteLength, STDERR_TAIL_BYTES - value.byteLength);
      const next = new Uint8Array(keep + value.byteLength);
      next.set(tail.subarray(tail.byteLength - keep));
      next.set(value, keep);
      tail = next;
    }
  } catch {
    // A forced process exit can close the pipe abruptly. The retained tail is
    // still useful and, unlike Response.text(), is always memory-bounded.
  } finally {
    signal.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
  return new TextDecoder().decode(tail);
}

async function runGenerator(
  command: string[],
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<GeneratorResult> {
  throwIfGenerationAborted(externalSignal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`web-voice TLS generation timeout must be positive, got ${timeoutMs}`);
  }

  const controller = new AbortController();
  let stopReason: "timeout" | "abort" | null = null;
  const onAbort = () => {
    if (stopReason) return;
    stopReason = "abort";
    controller.abort(externalSignal?.reason);
  };
  externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    if (stopReason) return;
    stopReason = "timeout";
    controller.abort(new Error(`openssl timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const proc = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: controller.signal,
      // A cooperative SIGTERM is not an absolute deadline. OpenSSL owns no
      // persistent state, so cancellation and timeout use an immediate kill.
      killSignal: "SIGKILL",
    });
    const stderrPending = captureStderrTail(proc.stderr, controller.signal);
    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } catch (err: unknown) {
      const stderr = await stderrPending;
      if (stopReason === "abort") throw new TlsGenerationAbortedError(externalSignal?.reason);
      if (stopReason === "timeout") return { exitCode: -1, stderr, timedOut: true };
      throw err;
    }
    const stderr = await stderrPending;
    if (stopReason === "abort") throw new TlsGenerationAbortedError(externalSignal?.reason);
    return { exitCode, stderr, timedOut: stopReason === "timeout" };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function parseGeneratedManifest(raw: unknown): GeneratedTlsManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("TLS pair manifest must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || typeof record.certFile !== "string" || typeof record.keyFile !== "string") {
    throw new Error("TLS pair manifest has an unsupported or incomplete format");
  }
  const certMatch = CERT_FILE_PATTERN.exec(record.certFile);
  const keyMatch = KEY_FILE_PATTERN.exec(record.keyFile);
  if (!certMatch || !keyMatch || certMatch[1]?.toLowerCase() !== keyMatch[1]?.toLowerCase()) {
    throw new Error("TLS pair manifest contains unsafe or mismatched file names");
  }
  return { version: 1, certFile: record.certFile, keyFile: record.keyFile };
}

async function loadGeneratedPair(dir: string): Promise<{ material: TlsMaterial; manifest: GeneratedTlsManifest }> {
  const manifestPath = join(dir, GENERATED_TLS_MANIFEST);
  try {
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4096) {
      throw new Error("TLS pair manifest must be a small regular file");
    }
    const manifest = parseGeneratedManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    const certPath = join(dir, manifest.certFile);
    const keyPath = join(dir, manifest.keyFile);
    await assertOwnedRegularPair(certPath, keyPath);
    await chmod(keyPath, 0o600);
    return { material: await loadPair(certPath, keyPath), manifest };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not load generated TLS pair: ${detail}`, { cause: err });
  }
}

async function loadLegacyGeneratedPair(dir: string): Promise<TlsMaterial | undefined> {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const [certExists, keyExists] = await Promise.all([pathExists(certPath), pathExists(keyPath)]);
  if (certExists !== keyExists) {
    throw new Error(
      `generated web-voice TLS pair is incomplete under ${dir}; move the remaining file aside and restart. ` +
      "Cicero will not overwrite existing certificate material",
    );
  }
  if (!certExists) return undefined;
  await assertOwnedRegularPair(certPath, keyPath);
  await chmod(keyPath, 0o600);
  return loadPair(certPath, keyPath);
}

async function removeArtifact(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile() || info.isSymbolicLink()) await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", `web-voice: could not clean stale TLS artifact ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function cleanupStaleArtifacts(dir: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    throw new Error(`could not inspect TLS directory ${dir}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const now = Date.now();
  for (const name of entries) {
    if (keep.has(name)) continue;
    if (name === ".tls-generation.lock" || LEGACY_TEMP_PATTERN.test(name)) {
      await removeArtifact(join(dir, name));
      continue;
    }
    if (!GENERATED_ARTIFACT_PATTERN.test(name)) continue;
    try {
      const info = await lstat(join(dir, name));
      if (now - info.mtimeMs >= STALE_ARTIFACT_AGE_MS) await removeArtifact(join(dir, name));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log("warn", `web-voice: could not inspect stale TLS artifact ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** True only for hosts whose HTTP traffic never leaves this machine. */
export function isLoopbackWebHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  const firstOctet = Number(normalized.split(".", 1)[0]);
  return firstOctet === 127;
}

/**
 * A failed automatic certificate setup may degrade to HTTP only on loopback.
 * Setting `web_voice.tls.enabled: false` is the explicit insecure-mode opt-in.
 */
export function assertWebTlsPolicy(host: string, tls: TlsMaterial | null, explicitlyDisabled: boolean): void {
  if (tls || explicitlyDisabled || isLoopbackWebHost(host)) return;
  throw new Error(
    `web_voice TLS setup failed for non-loopback host ${host}; refusing to expose the authenticated API over HTTP. ` +
    "Fix certificate generation, configure both tls.cert_file and tls.key_file, or explicitly set tls.enabled: false.",
  );
}

/**
 * Load an explicit certificate pair, or generate a self-signed pair in a
 * Cicero-owned directory. Explicit paths are read-only inputs: an incomplete
 * or missing pair is an error and is never overwritten. Generated cert/key
 * files use unique names; one hard-linked manifest atomically selects the
 * complete pair without a crash-prone persistent generation lock.
 */
export async function ensureTls(opts: EnsureTlsOptions): Promise<TlsMaterial | null> {
  const explicit = opts.certFile !== undefined || opts.keyFile !== undefined;
  if (explicit) {
    if (!opts.certFile || !opts.keyFile) {
      throw new Error("web_voice.tls.cert_file and web_voice.tls.key_file must be configured together");
    }
    const [certExists, keyExists] = await Promise.all([pathExists(opts.certFile), pathExists(opts.keyFile)]);
    if (!certExists || !keyExists) {
      throw new Error(
        `explicit web-voice TLS pair is incomplete (cert: ${certExists ? "found" : "missing"}, key: ${keyExists ? "found" : "missing"}); ` +
        "Cicero will not generate into or overwrite explicit paths",
      );
    }
    return loadPair(opts.certFile, opts.keyFile);
  }

  throwIfGenerationAborted(opts.signal);
  await ensurePrivateDirectory(opts.dir);
  const legacyPair = await loadLegacyGeneratedPair(opts.dir);
  if (legacyPair) {
    await cleanupStaleArtifacts(opts.dir);
    return legacyPair;
  }

  const manifestPath = join(opts.dir, GENERATED_TLS_MANIFEST);
  if (await pathExists(manifestPath)) {
    const generated = await loadGeneratedPair(opts.dir);
    await cleanupStaleArtifacts(opts.dir, new Set([generated.manifest.certFile, generated.manifest.keyFile]));
    return generated.material;
  }
  await cleanupStaleArtifacts(opts.dir);

  const nonce = crypto.randomUUID();
  const certName = `.tls-cert-${nonce}.pem`;
  const keyName = `.tls-key-${nonce}.pem`;
  const manifestTempName = `.tls-manifest-${nonce}.tmp`;
  const certPath = join(opts.dir, certName);
  const keyPath = join(opts.dir, keyName);
  const manifestTempPath = join(opts.dir, manifestTempName);
  let published = false;
  try {
    const command = opts.generatorCommand
      ? opts.generatorCommand(keyPath, certPath)
      : [opts.opensslBinary ?? "openssl", ...generationArgs(keyPath, certPath)];
    let result: GeneratorResult;
    try {
      result = await runGenerator(command, opts.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS, opts.signal);
    } catch (err: unknown) {
      if (err instanceof TlsGenerationAbortedError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      log("warn", `web-voice: could not launch openssl for TLS generation: ${detail}`);
      return null;
    }
    if (result.timedOut) {
      log("warn", `web-voice: openssl TLS generation timed out after ${opts.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS}ms${result.stderr ? `: ${result.stderr.slice(-160)}` : ""}`);
      return null;
    }
    if (result.exitCode !== 0) {
      log("warn", `web-voice: openssl cert generation failed (exit ${result.exitCode}): ${result.stderr.slice(-160)}`);
      return null;
    }

    try {
      await assertOwnedRegularPair(certPath, keyPath);
      await loadPair(certPath, keyPath);
    } catch (err: unknown) {
      log("warn", `web-voice: generated TLS material was invalid: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o644);
    await Promise.all([syncFile(keyPath), syncFile(certPath)]);
    throwIfGenerationAborted(opts.signal);

    // An older Cicero or an operator may have installed the legacy pair while
    // OpenSSL ran. Prefer it and leave it untouched rather than publishing a
    // second active source of certificate material.
    const racedLegacyPair = await loadLegacyGeneratedPair(opts.dir);
    if (racedLegacyPair) return racedLegacyPair;

    const manifest: GeneratedTlsManifest = { version: 1, certFile: certName, keyFile: keyName };
    const manifestHandle = await open(manifestTempPath, "wx", 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    throwIfGenerationAborted(opts.signal);

    try {
      // The manifest is complete and durable before its one-step publication.
      // link() never replaces a winner chosen by another process.
      await link(manifestTempPath, manifestPath);
      published = true;
      log("ok", `web-voice: generated self-signed TLS cert (${certPath})`);
      return (await loadGeneratedPair(opts.dir)).material;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return (await loadGeneratedPair(opts.dir)).material;
    }
  } finally {
    await unlink(manifestTempPath).catch(() => { /* absent before manifest creation or after cleanup */ });
    if (!published) {
      await unlink(certPath).catch(() => { /* absent after failed openssl */ });
      await unlink(keyPath).catch(() => { /* absent after failed openssl */ });
    }
  }
}
