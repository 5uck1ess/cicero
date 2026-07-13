import type { RuntimeConfig } from "../config";
import { isLocalHost } from "../backends/net";
import {
  SUPPORTED_STT_BACKENDS,
  SUPPORTED_TTS_BACKENDS,
  supportedBackendHint,
} from "../backends/supported-backends";
import { MLX_MIN_MACOS_MAJOR, supportsCurrentMlx } from "../platform/python";

export type BackendRole = "stt" | "tts" | "llm";

export interface BackendStartupPolicy {
  /** Explicit STT and enabled TTS primaries must be usable before startup commits. */
  required: boolean;
  configKey: string;
  backend: string;
  validValues?: readonly string[];
  /** Deterministic capability failure for an explicitly required local backend. */
  blockedReason?: string;
  /** Explanation when startup continues because an explicit fallback is available. */
  startupNotice?: string;
  /** A platform-impossible implicit default is not started or health-probed. */
  skipReason?: string;
}

export type BackendStartupPolicies = Partial<Record<BackendRole, BackendStartupPolicy>>;

export interface BackendStartupPolicyOptions {
  /** False when an embedder supplies providers that need not match the built-in registry. */
  builtInProviders?: boolean;
  platform?: string;
  osRelease?: string;
}

export function createBackendStartupPolicies(
  config: RuntimeConfig,
  options: BackendStartupPolicyOptions = {},
): BackendStartupPolicies {
  const builtInProviders = options.builtInProviders ?? true;
  const stt = config.sttBackend;
  const tts = config.ttsBackend;
  const llm = config.llmBackend;

  return {
    stt: createPolicy({
      role: "stt",
      configKey: "stt.backend",
      backend: stt.backend,
      host: stt.host,
      explicit: config.raw.stt !== undefined,
      required: config.raw.stt !== undefined,
      hasConfiguredFallback: config.raw.stt_fallback !== undefined,
      validValues: builtInProviders ? SUPPORTED_STT_BACKENDS : undefined,
      builtInProviders,
      options,
    }),
    tts: createPolicy({
      role: "tts",
      configKey: "tts.backend",
      backend: tts.backend,
      host: tts.host,
      explicit: config.raw.tts !== undefined,
      required: config.raw.tts !== undefined && config.ttsEnabled,
      hasConfiguredFallback: config.raw.tts_fallback !== undefined,
      validValues: builtInProviders ? SUPPORTED_TTS_BACKENDS : undefined,
      builtInProviders,
      options,
    }),
    llm: createPolicy({
      role: "llm",
      configKey: "llm.backend",
      backend: llm.backend,
      host: llm.host,
      explicit: config.raw.llm !== undefined,
      required: false,
      hasConfiguredFallback: false,
      builtInProviders,
      options,
    }),
  };
}

interface PolicyInput {
  role: BackendRole;
  configKey: string;
  backend: string | undefined;
  host: string | undefined;
  explicit: boolean;
  required: boolean;
  hasConfiguredFallback: boolean;
  validValues?: readonly string[];
  builtInProviders: boolean;
  options: BackendStartupPolicyOptions;
}

function createPolicy(input: PolicyInput): BackendStartupPolicy {
  const backend = input.backend ?? "<missing>";
  const impossibleImplicitMlx = input.builtInProviders
    && !input.explicit
    && backend.startsWith("mlx-")
    && isLocalHost(input.host)
    && !supportsCurrentMlx(input.options.platform, input.options.osRelease);
  const impossibleRequiredMlx = input.builtInProviders
    && input.explicit
    && input.required
    && backend.startsWith("mlx-")
    && isLocalHost(input.host)
    && !supportsCurrentMlx(input.options.platform, input.options.osRelease);
  const implicitMlxReason = impossibleImplicitMlx
    ? implicitMlxSkipReason(input.role, input.configKey, backend, input.validValues)
    : undefined;
  const skipReason = implicitMlxReason && !input.hasConfiguredFallback
    ? implicitMlxReason
    : undefined;
  const startupNotice = implicitMlxReason && input.hasConfiguredFallback
    ? `${implicitMlxReason} The configured ${input.role}_fallback remains eligible for startup.`
    : undefined;

  return {
    required: input.required,
    configKey: input.configKey,
    backend,
    validValues: input.validValues,
    ...(impossibleRequiredMlx
      ? { blockedReason: `local MLX requires macOS ${MLX_MIN_MACOS_MAJOR} or newer on this platform` }
      : {}),
    ...(startupNotice ? { startupNotice } : {}),
    ...(skipReason ? { skipReason } : {}),
  };
}

function implicitMlxSkipReason(
  role: BackendRole,
  configKey: string,
  backend: string,
  validValues: readonly string[] | undefined,
): string {
  const alternatives = validValues
    ? ` Set ${configKey} or configure ${role}.host for a remote MLX server; ${supportedBackendHint(configKey, validValues)}.`
    : ` Configure an explicit platform-compatible ${configKey} or ${role}.host for a remote MLX server.`;
  return `Skipping implicit ${configKey}='${backend}': local MLX requires macOS ${MLX_MIN_MACOS_MAJOR} or newer.${alternatives}`;
}
