import { log } from "../logger";
import {
  spawnOwnedProcess,
  terminateOwnedProcessTree,
  type OwnedProcess,
} from "../process/owned-process";
import type { WebVoiceTunnelConfig } from "../types";

export type TunnelProvider = Exclude<WebVoiceTunnelConfig["provider"], "auto">;

export interface TunnelProcess extends OwnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface TunnelRuntime {
  which: (binary: TunnelProvider) => string | null;
  spawn: (command: readonly string[]) => TunnelProcess;
  terminate: (proc: TunnelProcess) => Promise<void>;
  log: (level: "ok" | "warn", message: string) => void;
}

export interface StartWebVoiceTunnelOptions {
  config: WebVoiceTunnelConfig;
  localScheme: "http" | "https";
  /** Configured listener host. Wildcard binds are reached through loopback. */
  localHost?: string;
  localPort: number;
  /** Absolute budget for obtaining the provider URL. Defaults to 30 seconds. */
  deadlineMs?: number;
  /** Combined stdout/stderr byte limit while discovering the public URL. */
  outputLimitBytes?: number;
  /** Daemon lifecycle cancellation; an in-progress launch is cleaned up. */
  signal?: AbortSignal;
  /** Publish cleanup ownership synchronously in the same turn as spawn. */
  onOwned?: (owner: Pick<WebVoiceTunnelHandle, "stop">) => void;
  runtime?: TunnelRuntime;
}

export interface WebVoiceTunnelHandle {
  provider: TunnelProvider;
  /** Public origin only. Credentials, query strings, and paths are discarded. */
  publicUrl: string;
  stop: () => Promise<void>;
}

const DEFAULT_URL_DEADLINE_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

const defaultRuntime: TunnelRuntime = {
  which: (binary) => Bun.which(binary),
  spawn: (command) => spawnOwnedProcess(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    windowsHide: true,
  }) as TunnelProcess,
  terminate: (proc) => terminateOwnedProcessTree(proc),
  log: (level, message) => log(level, message),
};

class TunnelStartupError extends Error {
  constructor(readonly reason: "deadline" | "output-limit" | "exited" | "output-closed" | "cancelled") {
    const detail = reason === "deadline"
      ? "URL discovery deadline expired"
      : reason === "output-limit"
        ? "subprocess output limit exceeded"
        : reason === "exited"
          ? "provider process exited before publishing a URL"
          : reason === "cancelled"
            ? "tunnel startup was cancelled"
            : "provider output closed before publishing a URL";
    super(detail);
    this.name = "TunnelStartupError";
  }
}

interface OutputWatcher {
  ready: Promise<string>;
  cancel: () => Promise<void>;
}

/**
 * Start one daemon-owned reachability process. Missing configured binaries are
 * configuration/startup errors. Failures after a child is spawned are cleaned
 * up and degrade to the local web-voice listener.
 */
export async function startWebVoiceTunnel(
  options: StartWebVoiceTunnelOptions,
): Promise<WebVoiceTunnelHandle | null> {
  const runtime = options.runtime ?? defaultRuntime;
  const deadlineMs = positiveInteger(options.deadlineMs ?? DEFAULT_URL_DEADLINE_MS, "deadlineMs");
  const outputLimitBytes = positiveInteger(
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    "outputLimitBytes",
  );
  const localPort = port(options.localPort);
  options.signal?.throwIfAborted();
  const { provider, binary } = resolveProvider(options.config.provider, runtime.which);
  const localUrl = localTargetUrl(options.localScheme, options.localHost, localPort);
  const command = tunnelCommand(provider, binary, localUrl, options.localScheme === "https");

  let proc: TunnelProcess;
  try {
    proc = runtime.spawn(command);
  } catch {
    runtime.log("warn", `web-voice ${provider} tunnel could not start; continuing with local web voice`);
    return null;
  }

  let watcher!: OutputWatcher;
  let stopTask: Promise<void> | null = null;
  let stopping = false;
  const stop = (): Promise<void> => {
    if (stopTask) return stopTask;
    stopping = true;
    const task = runtime.terminate(proc).finally(() => watcher.cancel());
    const tracked = task.catch((error: unknown) => {
      if (stopTask === tracked) stopTask = null;
      throw error;
    });
    stopTask = tracked;
    return tracked;
  };
  watcher = watchForPublicUrl({
    proc,
    provider,
    deadlineMs,
    outputLimitBytes,
    signal: options.signal,
  });
  try {
    options.onOwned?.({ stop });
  } catch {
    await stop();
    throw new Error(`web-voice ${provider} tunnel ownership could not be published`);
  }

  const exitedBeforeReady = proc.exited.then(
    () => Promise.reject(new TunnelStartupError("exited")),
    () => Promise.reject(new TunnelStartupError("exited")),
  );

  let publicUrl: string;
  try {
    publicUrl = await Promise.race([watcher.ready, exitedBeforeReady]);
  } catch (error: unknown) {
    try {
      await stop();
    } catch (cleanupError: unknown) {
      throw new Error(`web-voice ${provider} tunnel failed and its owned process cleanup was not confirmed`, {
        cause: cleanupError,
      });
    }
    const reason = error instanceof TunnelStartupError ? error.message : "provider startup failed";
    runtime.log("warn", `web-voice ${provider} tunnel failed: ${reason}; continuing with local web voice`);
    return null;
  }

  // Observe the long-lived child for its whole lifetime. The output watcher
  // enforces the discovery byte cap, then drains without retaining provider
  // output so the child cannot block on a full pipe.
  void proc.exited.then(
    () => {
      if (!stopping) runtime.log("warn", `web-voice ${provider} tunnel process exited`);
    },
    () => {
      if (!stopping) runtime.log("warn", `web-voice ${provider} tunnel exit observation failed`);
    },
  );
  runtime.log("ok", `web-voice ${provider} tunnel ready at ${publicUrl}`);
  return { provider, publicUrl, stop };
}

function resolveProvider(
  configured: WebVoiceTunnelConfig["provider"],
  which: TunnelRuntime["which"],
): { provider: TunnelProvider; binary: string } {
  if (configured === "auto") {
    const tailscale = which("tailscale");
    if (tailscale) return { provider: "tailscale", binary: tailscale };
    const cloudflared = which("cloudflared");
    if (cloudflared) return { provider: "cloudflared", binary: cloudflared };
    throw new Error(
      "web_voice.tunnel provider 'auto' found neither tailscale nor cloudflared; install one and ensure it is on PATH",
    );
  }
  const binary = which(configured);
  if (!binary) {
    throw new Error(
      `web_voice.tunnel provider '${configured}' was explicitly configured but ${configured} was not found; install ${configured} and ensure it is on PATH`,
    );
  }
  return { provider: configured, binary };
}

function tunnelCommand(
  provider: TunnelProvider,
  binary: string,
  localUrl: string,
  insecureTlsUpstream: boolean,
): string[] {
  if (provider === "tailscale") {
    const target = insecureTlsUpstream
      ? localUrl.replace(/^https:/, "https+insecure:")
      : localUrl;
    return [binary, "serve", "--https=443", target];
  }
  const command = [binary, "tunnel", "--no-autoupdate", "--url", localUrl];
  if (insecureTlsUpstream) command.push("--no-tls-verify");
  return command;
}

function watchForPublicUrl(options: {
  proc: TunnelProcess;
  provider: TunnelProvider;
  deadlineMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}): OutputWatcher {
  const readers = [options.proc.stdout.getReader(), options.proc.stderr.getReader()];
  const retained = ["", ""];
  let totalBytes = 0;
  let closedReaders = 0;
  let readySettled = false;
  let limitHandled = false;
  let resolveReady!: (url: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new TunnelStartupError("deadline"));
  }, options.deadlineMs);
  const onAbort = (): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(timer);
    rejectReady(new TunnelStartupError("cancelled"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const inspect = (chunk: Uint8Array, readerIndex: number, decoder: TextDecoder): void => {
    // Once the origin is known, drain and discard all later output so the
    // long-lived child cannot block on a full pipe and no untrusted bytes are
    // retained or logged.
    if (readySettled) return;
    if (limitHandled) return;
    totalBytes += chunk.byteLength;
    if (totalBytes > options.outputLimitBytes) {
      limitHandled = true;
      readySettled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rejectReady(new TunnelStartupError("output-limit"));
      return;
    }
    retained[readerIndex] += decoder.decode(chunk, { stream: true });
    const url = extractPublicOrigin(retained[readerIndex], options.provider);
    if (!url) return;
    readySettled = true;
    retained[0] = "";
    retained[1] = "";
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    resolveReady(url);
  };

  readers.forEach((reader, readerIndex) => {
    const decoder = new TextDecoder();
    void (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          inspect(next.value, readerIndex, decoder);
          if (limitHandled) break;
        }
      } catch {
        // Stream errors are represented as a controlled closed-output failure;
        // raw provider text and stream errors are never interpolated into logs.
      } finally {
        closedReaders += 1;
        if (closedReaders === readers.length && !readySettled) {
          readySettled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          rejectReady(new TunnelStartupError("output-closed"));
        }
      }
    })();
  });

  let cancelTask: Promise<void> | null = null;
  return {
    ready,
    cancel: () => cancelTask ??= Promise.allSettled(readers.map((reader) => reader.cancel())).then(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }),
  };
}

function localTargetUrl(scheme: "http" | "https", configuredHost: string | undefined, localPort: number): string {
  const rawHost = configuredHost?.trim() || "127.0.0.1";
  const host = rawHost === "0.0.0.0"
    ? "127.0.0.1"
    : rawHost === "::" || rawHost === "[::]"
      ? "[::1]"
      : rawHost.includes(":") && !rawHost.startsWith("[")
        ? `[${rawHost}]`
        : rawHost;
  try {
    const url = new URL(`${scheme}://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("unsafe host");
    url.port = String(localPort);
    return url.origin;
  } catch {
    throw new Error("web_voice.host cannot be used as a tunnel upstream host");
  }
}

function extractPublicOrigin(text: string, provider: TunnelProvider): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      const hostname = url.hostname.toLowerCase();
      const valid = provider === "cloudflared"
        ? hostname.endsWith(".trycloudflare.com")
        : hostname.endsWith(".ts.net");
      if (valid) return url.origin;
    } catch {
      // Keep scanning the bounded provider output for a valid URL.
    }
  }
  return null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("localPort must be an integer between 1 and 65535");
  }
  return value;
}
