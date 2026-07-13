import { join, dirname } from "path";
import type { SerProvider, SerProviderConfig, ToneResult } from "./provider";
import { httpBase, isLocalHost } from "../net";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import { findVenvPython } from "../../platform/python";
import {
  PROVIDER_TIMEOUT_MS,
  discardResponseBody,
  providerSignal,
  readBoundedJson,
  requestTimeout,
  responseIsOk,
  sidecarInferenceTimeoutSeconds,
} from "../http-transfer";

/**
 * emotion2vec+ base speech-emotion classifier served over HTTP (Cicero's
 * Python-ML-over-HTTP convention — see servers/ser_server.py). POSTs the
 * utterance WAV bytes and reads back `{label, score}`.
 *
 * On ANY error (server down, bad status, parse failure) it returns null so
 * the turn proceeds untagged — a tone hiccup must never block conversation.
 */
export class Emotion2vecProvider implements SerProvider {
  readonly name = "emotion2vec";
  private host?: string;
  private port: number;
  private model: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: SerProviderConfig = {}) {
    this.host = config.host;
    // 8091 by default — 8090 is web-voice, 8087 the turn detector.
    this.port = config.port ?? 8091;
    this.model = config.model ?? "emotion2vec/emotion2vec_plus_base";
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.tone);
  }

  async classify(wav: ArrayBuffer | Uint8Array): Promise<ToneResult | null> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/infer`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        // Copy Uint8Array views into a plain ArrayBuffer — the one BodyInit
        // shape the dom+bun type stacks agree on.
        body: wav instanceof Uint8Array ? (new Uint8Array(wav).buffer as ArrayBuffer) : wav,
        signal: providerSignal(this.timeoutMs),
      });
      if (!res.ok) {
        await discardResponseBody(res);
        throw new Error(`SER server returned ${res.status}`);
      }
      const data = await readBoundedJson<{ label?: string; score?: number }>(res);
      if (typeof data.label !== "string" || typeof data.score !== "number") return null;
      return { label: data.label, score: data.score };
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `tone classify failed (${err instanceof Error ? err.message : String(err)}) — turn proceeds untagged`);
      return null;
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${httpBase(this.host, this.port)}/health`, {
        signal: providerSignal(PROVIDER_TIMEOUT_MS.health),
      });
      return await responseIsOk(res);
    } catch {
      return false; // unreachable = unhealthy
    }
  }

  async start(): Promise<void> {
    const { log } = await import("../../logger");
    if (!isLocalHost(this.host)) {
      log("info", `tone: using remote SER server at ${httpBase(this.host, this.port)}`);
      return;
    }
    // FunASR lives in its own venv so its ModelScope dep tree can't touch the
    // STT server's stack. No fallback python: launching emotion2vec from an
    // arbitrary interpreter would just crash-loop the supervisor.
    const projectRoot = join(dirname(dirname(dirname(import.meta.dir))));
    const python = findVenvPython(join(projectRoot, ".venv-ser"));
    if (!python) {
      log("warn", "tone: .venv-ser has no Python interpreter — SER sidecar not started (see `cicero doctor`)");
      return;
    }
    const script = join(projectRoot, "servers", "ser_server.py");

    this.managed = await startManagedServer({
      name: "ser",
      port: this.port,
      command: [
        python,
        script,
        "--port", this.port.toString(),
        "--host", "127.0.0.1",
        "--model", this.model,
        "--inference-timeout", sidecarInferenceTimeoutSeconds(this.timeoutMs).toString(),
      ],
      healthUrl: `${httpBase(this.host, this.port)}/health`,
      // Model load is ~12s warm; the first EVER start also downloads ~360MB.
      timeoutMs: 300000,
      supervise: true,
    });
  }

  async stop(): Promise<void> {
    if (this.managed) {
      const managed = this.managed;
      try {
        await stopManagedServer(managed);
      } finally {
        if (this.managed === managed) this.managed = null;
      }
    }
  }
}
