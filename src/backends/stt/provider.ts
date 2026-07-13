import { isLocalHost } from "../net";

export interface STTProviderConfig {
  backend?: string;
  host?: string; // for network backends (e.g. wyoming)
  port?: number;
  model?: string;
  compute_type?: string; // CTranslate2 quantization (faster-whisper): float16 | int8_float16 | int8; server default "auto"
  /** Absolute per-transcription deadline in milliseconds (default 90 seconds). */
  timeout_ms?: number;
}

/**
 * Diagnostic transcription outcome used by compositors such as the fallback
 * provider. `empty` is deliberately distinct from `failure`: Whisper can
 * legitimately hear no speech, and treating silence as an outage produces
 * misleading degradation warnings (and can amplify a fallback hallucination).
 */
export type STTTranscriptionResult =
  | { kind: "transcript"; text: string }
  | { kind: "empty" }
  | { kind: "failure"; reason: string };

export interface STTProvider {
  readonly name: string;
  transcribe(audioFile: string): Promise<string | null>;
  /**
   * Quiet, structured form of {@link transcribe}. Direct callers retain the
   * historical null-and-log behavior; fallback composition uses this method
   * to emit one bounded warning for an outage episode instead of one warning
   * from the concrete provider on every turn.
   */
  transcribeResult?(audioFile: string): Promise<STTTranscriptionResult>;
  health(): Promise<boolean>;
  /**
   * Health of the configured primary when this provider composes fallbacks.
   * Startup policy uses this instead of aggregate health so a live fallback
   * cannot hide an explicitly configured primary that never came online.
   */
  requiredHealth?(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  /** Load the model now (one throwaway inference) so the first real utterance isn't cold. */
  warmup?(): Promise<void>;
}

export const STT_DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({
  "mlx-whisper": 8083,
  "faster-whisper": 8083,
  audiocpp: 8092,
  wyoming: 10300,
});

export function sttDefaultPort(backend: string | undefined): number | undefined {
  return backend ? STT_DEFAULT_PORTS[backend] : undefined;
}

/** Canonical network seat used to reject a fallback wired to its own primary. */
export function sttEndpointKey(config: STTProviderConfig): string | null {
  const port = config.port ?? sttDefaultPort(config.backend);
  if (port === undefined) return null;
  const host = canonicalSttHost(config.host);
  return `${host}:${port}`;
}

function canonicalSttHost(host: string | undefined): string {
  if (isLocalHost(host)) return "local";
  const unbracketed = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const dnsCanonical = unbracketed.replace(/\.$/, "");
  if (dnsCanonical === "localhost") return "local";

  const zoneIndex = dnsCanonical.indexOf("%");
  const address = zoneIndex === -1 ? dnsCanonical : dnsCanonical.slice(0, zoneIndex);
  const zone = zoneIndex === -1 ? "" : dnsCanonical.slice(zoneIndex);
  if (address.includes(":")) {
    try {
      const canonical = new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, "");
      if (canonical === "::1" || canonical === "::") return "local";
      return `${canonical}${zone}`;
    } catch { /* malformed hosts are rejected by the eventual provider connection */ }
  }
  return dnsCanonical;
}
