import { buildTTSProvider } from "../backends/registry";
import { ttsDefaultPort, type TTSProvider, type TTSProviderConfig } from "../backends/tts/provider";
import { engineVenvHint } from "../cli/doctor";
import { defaultPortProbe, type PickerDeps } from "./pickers";

/**
 * One sentence spoken by a TTS engine that is already running. It never
 * calls start(), so it never launches an engine; a closed port is reported
 * as "not running" with the command that installs it.
 */
export const SAMPLE_SENTENCE = "Hello, I'm Cicero. This is how I sound.";
export const SAMPLE_MAX_BYTES = 2 * 1024 * 1024;

export type SynthResult =
  | { ok: true; audio: Uint8Array; mime: "audio/wav" }
  | { ok: false; state: "not running" | "failed" | "timeout" | "cancelled"; message: string; startCommand?: string };

export interface SampleOptions {
  signal: AbortSignal;
  timeoutMs: number;
  deps?: PickerDeps;
  maxBytes?: number;
  /** Test seam: builds the provider; defaults to the runtime registry. */
  build?: (tts: TTSProviderConfig) => TTSProvider;
}

function bounded(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300);
}

export function engineStartCommand(backend: string): string | undefined {
  if (backend === "audiocpp") return "scripts/provision-audiocpp.sh";
  return engineVenvHint(backend);
}

export async function synthesizeSample(tts: TTSProviderConfig, opts: SampleOptions): Promise<SynthResult> {
  const backend = String(tts.backend ?? "");
  if (backend === "elevenlabs") return { ok: false, state: "failed", message: "Sample unavailable for this engine: it is a cloud voice, and setup sends nothing off this machine." };
  const host = tts.host ?? (backend === "wyoming" ? "127.0.0.1" : "localhost");
  const port = tts.port ?? ttsDefaultPort(backend);
  if (!port) return { ok: false, state: "failed", message: "Sample unavailable for this engine" };
  if (opts.signal.aborted) return { ok: false, state: "cancelled", message: "Sample cancelled" };
  if (!(await (opts.deps?.probePort ?? defaultPortProbe)(host, port))) {
    const startCommand = engineStartCommand(backend);
    return { ok: false, state: "not running", message: `Nothing is listening on ${host}:${port}. Cicero starts this engine when it runs; install it first if needed.`, ...(startCommand ? { startCommand } : {}) };
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = AbortSignal.any([opts.signal, timeout]);
  let stopWaiting!: () => void;
  // Providers honor the signal, but the deadline must hold even if one does not.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
    stopWaiting = () => signal.removeEventListener("abort", fail);
  });
  aborted.catch(() => {});
  try {
    const provider = (opts.build ?? ((config) => buildTTSProvider(config, "tts.backend")))(tts);
    const audio = await Promise.race([provider.generateAudio(SAMPLE_SENTENCE, undefined, { signal }), aborted]);
    if (audio.byteLength > (opts.maxBytes ?? SAMPLE_MAX_BYTES)) return { ok: false, state: "failed", message: "The sample was larger than expected; the engine may be misconfigured" };
    return { ok: true, audio: new Uint8Array(audio), mime: "audio/wav" };
  } catch (error) {
    if (opts.signal.aborted) return { ok: false, state: "cancelled", message: "Sample cancelled" };
    if (timeout.aborted) return { ok: false, state: "timeout", message: `No sample within ${Math.round(opts.timeoutMs / 1000)} s` };
    return { ok: false, state: "failed", message: bounded(error instanceof Error ? error.message : String(error)) };
  } finally {
    stopWaiting();
  }
}
