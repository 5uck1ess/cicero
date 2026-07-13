import { join, dirname } from "node:path";
import type { TurnDetector, TurnDetectorConfig, TurnPrediction } from "./provider";
import { httpBase, isLocalHost } from "../net";
import { startManagedServer, stopManagedServer, type ManagedProcess } from "../managed-server";
import {
  findVenvPython,
  resolveVenvPython,
  type PythonResolverOptions,
} from "../../platform/python";
import {
  PROVIDER_TIMEOUT_MS,
  discardResponseBody,
  providerSignal,
  readBoundedJson,
  requestTimeout,
  responseIsOk,
  sidecarInferenceTimeoutSeconds,
} from "../http-transfer";

export const SMART_TURN_MIGRATION_COMMAND =
  "uv venv .venv-turn --python 3.11 && uv pip install --python .venv-turn -r requirements/turn.txt";

const SMART_TURN_VENVS = [".venv-turn", ".venv-stt", ".venv"] as const;
export const SMART_TURN_MIN_SAMPLE_RATE = 8_000;
export const SMART_TURN_MAX_SAMPLE_RATE = 96_000;
export const SMART_TURN_WINDOW_SECONDS = 8;
export const SMART_TURN_MAX_MODEL_CHARS = 4_096;
export const SMART_TURN_MAX_JSON_FLOAT32_BYTES = 25;
export const SMART_TURN_JSON_ENVELOPE_BYTES = 64 * 1024;
/** Exact ceiling shared with servers/sidecar_limits.py for Cicero's canonical
 * JSON.stringify(Float32Array) request. The extra byte per sample is its comma. */
export const SMART_TURN_MAX_JSON_BYTES = (
  SMART_TURN_MAX_SAMPLE_RATE
  * SMART_TURN_WINDOW_SECONDS
  * (SMART_TURN_MAX_JSON_FLOAT32_BYTES + 1)
  + SMART_TURN_JSON_ENVELOPE_BYTES
);

export interface SmartTurnRuntime {
  python: string;
  venv: (typeof SMART_TURN_VENVS)[number];
  found: boolean;
  legacy: boolean;
}

/**
 * Resolve Smart-Turn without breaking installations that historically kept it
 * in the shared STT or project environment. New installs always prefer the
 * isolated environment; legacy matches remain visible so callers can warn.
 */
export function resolveSmartTurnRuntime(
  projectRoot: string,
  options: PythonResolverOptions = {},
): SmartTurnRuntime {
  for (const venv of SMART_TURN_VENVS) {
    const python = findVenvPython(join(projectRoot, venv), options);
    if (python) {
      return { python, venv, found: true, legacy: venv !== ".venv-turn" };
    }
  }

  return {
    python: resolveVenvPython(join(projectRoot, ".venv-turn"), options),
    venv: ".venv-turn",
    found: false,
    legacy: false,
  };
}

function buildSmartTurnServerCommand(
  python: string,
  projectRoot: string,
  port: number,
  model: string,
  inferenceTimeoutSeconds: number,
): string[] {
  const script = join(projectRoot, "servers", "turn_server.py");
  return [
    python,
    script,
    "--port", port.toString(),
    "--host", "127.0.0.1",
    "--model", model,
    "--inference-timeout", inferenceTimeoutSeconds.toString(),
  ];
}

/** Resolve the isolated Smart-Turn runtime and server command. */
export function smartTurnServerCommand(
  projectRoot: string,
  port: number,
  model: string,
  options: PythonResolverOptions = {},
): string[] {
  const { python } = resolveSmartTurnRuntime(projectRoot, options);
  return buildSmartTurnServerCommand(
    python,
    projectRoot,
    port,
    model,
    sidecarInferenceTimeoutSeconds(PROVIDER_TIMEOUT_MS.turn),
  );
}

/**
 * Smart-Turn v2/v3 end-of-turn classifier served over HTTP (Cicero's
 * Python-ML-over-HTTP convention, like the STT/TTS/LLM providers). POSTs a mono
 * PCM speech window and reads back `{prediction|is_complete, probability}`.
 *
 * On ANY error (server down, bad status, parse failure) it returns an incomplete
 * prediction so the silence-timeout fallback governs — a model hiccup must never
 * block the conversation.
 *
 * Assumed wire contract: `POST /predict {model, sample_rate, audio:number[]}` →
 * `{prediction:0|1, probability:number}` (or `{is_complete:boolean, probability}`).
 */
export class SmartTurnProvider implements TurnDetector {
  readonly name = "smart-turn";
  private host?: string;
  private port: number;
  private model: string;
  private readonly timeoutMs: number;
  private managed: ManagedProcess | null = null;

  constructor(config: TurnDetectorConfig = {}) {
    this.host = config.host;
    // 8087 by default — 8086 is the localhost dashboard's port.
    this.port = config.port ?? 8087;
    this.model = config.model ?? "pipecat-ai/smart-turn-v3";
    if (this.model.length > SMART_TURN_MAX_MODEL_CHARS) {
      throw new RangeError(`smart-turn model id exceeds ${SMART_TURN_MAX_MODEL_CHARS} characters`);
    }
    this.timeoutMs = requestTimeout(config.timeout_ms, PROVIDER_TIMEOUT_MS.turn);
  }

  async predict(samples: Float32Array, sampleRate: number): Promise<TurnPrediction> {
    try {
      if (
        !Number.isInteger(sampleRate)
        || sampleRate < SMART_TURN_MIN_SAMPLE_RATE
        || sampleRate > SMART_TURN_MAX_SAMPLE_RATE
      ) {
        throw new RangeError(
          `smart-turn sample rate must be an integer between ${SMART_TURN_MIN_SAMPLE_RATE} and ${SMART_TURN_MAX_SAMPLE_RATE}`,
        );
      }
      if (samples.length === 0) throw new RangeError("smart-turn audio is empty");
      // The server/model only examines the final eight seconds. Crop before
      // JSON serialization so a long recording cannot become an unbounded
      // request allocation and upload.
      const maxSamples = sampleRate * SMART_TURN_WINDOW_SECONDS;
      const window = samples.length > maxSamples
        ? samples.subarray(samples.length - maxSamples)
        : samples;
      for (const sample of window) {
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
          throw new RangeError("smart-turn audio samples must be finite values between -1 and 1");
        }
      }
      const res = await fetch(`${httpBase(this.host, this.port)}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          sample_rate: sampleRate,
          audio: Array.from(window),
        }),
        signal: providerSignal(this.timeoutMs),
      });
      if (!res.ok) {
        await discardResponseBody(res);
        throw new Error(`smart-turn server returned ${res.status}`);
      }
      const data = await readBoundedJson<{
        prediction?: number;
        probability?: number;
        is_complete?: boolean;
      }>(res);
      const probability = typeof data.probability === "number" ? data.probability : 0;
      const complete = data.is_complete ?? data.prediction === 1;
      return { complete, probability };
    } catch (err: unknown) {
      const { log } = await import("../../logger");
      log("info", `smart-turn predict failed (${err instanceof Error ? err.message : String(err)}) — deferring to silence fallback`);
      return { complete: false, probability: 0 };
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
      log("info", `smart-turn: using remote server at ${httpBase(this.host, this.port)}`);
      return;
    }
    // Smart-Turn now has its own ONNX stack. Migration fallbacks keep existing
    // installs alive while making the shared environment visible and temporary.
    const projectRoot = dirname(dirname(dirname(import.meta.dir)));
    const runtime = resolveSmartTurnRuntime(projectRoot);
    if (runtime.legacy) {
      log(
        "warn",
        `smart-turn: using deprecated ${runtime.venv} compatibility environment; run from ${projectRoot}: ${SMART_TURN_MIGRATION_COMMAND}`,
      );
    }

    this.managed = await startManagedServer({
      name: "smart-turn",
      port: this.port,
      command: buildSmartTurnServerCommand(
        runtime.python,
        projectRoot,
        this.port,
        this.model,
        sidecarInferenceTimeoutSeconds(this.timeoutMs),
      ),
      healthUrl: `${httpBase(this.host, this.port)}/health`,
      timeoutMs: 60000,
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
