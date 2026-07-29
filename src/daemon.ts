import { existsSync, readFileSync, rmSync, watch } from "fs";
import { join, dirname } from "path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { RuntimeConfig, updateConfigFields } from "./config";
import type { Listener, Router, Brain, BrainTurnOptions, Speaker, TerminalAdapter, RouterResult } from "./types";
import { registerKnownSecrets, clearKnownSecrets } from "./redact";
import { log, logStep, logError } from "./logger";
import { createListener, createConversationalListener, createDictationListener } from "./listener";
import { createIntentJudge } from "./listener/intent-judge";
import type { IntentJudge } from "./listener/intent-judge";
import type { DictationListener } from "./listener/dictation";
import { createRouter } from "./router";
import { createBrain, summarizerClassifier } from "./brain";
import { createHistoryCompactor, createSummarizerComplete } from "./brain/history-compactor";
import { setDefaultHistoryCompactor } from "./brain/turn-context";
import {
  waitForBrainReadiness,
  type BrainReadinessOptions,
} from "./brain/readiness";
import { createSpeaker, createStreamingSpeaker } from "./speaker";
import { createTerminalAdapter } from "./terminal";
import { ActionExecutor } from "./executor";
import {
  ServerManager,
  createBackendStartupPolicies,
  type BackendStartupPolicies,
} from "./servers";
import { ContextStore } from "./brain/context-store";
import type { ConversationalListener } from "./listener/conversational";
import { ClapListener } from "./listener/clap-listener";
import { createTurnDetector, decideEndOfTurn } from "./backends/turn";
import type { TurnDetector } from "./backends/turn/provider";
import { createSerProvider } from "./backends/ser";
import type { SerProvider } from "./backends/ser/provider";
import { toneTag, wavDurationMs, type ToneOptions } from "./web-voice/tone";
import { callbackConsumerAlive, writeCallbackSpool } from "./telegram-call";
import { StreamingTTSSpeaker } from "./speaker/streaming-tts";
import { speakable } from "./speaker/speakable";
import { canStreamBrain, canNarrateAgent, streamBrainToSpeaker, streamAgentNarration } from "./speaker/brain-stream";
import { pickThinkingFiller } from "./speaker/thinking-filler";
import { FillerBank } from "./speaker/filler-bank";
import { ciceroPath } from "./platform/paths";
import { warmupProvider } from "./backends/tts/warmup";
import { buildRecoveryContext } from "./speaker/recovery";
import { createProviders, createSTTProvider, createTTSProvider, type BackendProviders } from "./backends/registry";
import { ProviderSlot, SwappableSTTProvider, SwappableTTSProvider } from "./backends/hot-swap";
import { createLaneTts } from "./web-voice/lane-tts";
import type { STTProvider, STTProviderConfig } from "./backends/stt/provider";
import type { TTSProvider, TTSProviderConfig } from "./backends/tts/provider";
import { sttDefaultPort } from "./backends/stt/provider";
import { ttsDefaultPort } from "./backends/tts/provider";
import { isLocalHost } from "./backends/net";
import { startRuntimeControl, type RuntimeControlHandle, type SwapRequest, type SwapResult, type SwapRole } from "./runtime-control";
import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "./backends/llm/openai";
import type { LLMProviderConfig } from "./backends/llm/provider";
import {
  discardResponseBody,
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
} from "./backends/http-transfer";
import { startDashboard, type DashboardHandle, type VoiceControlAction } from "./dashboard/server";
import { dashBus } from "./dashboard/bus";
import { startWebVoiceServer, type WebVoiceHandle } from "./web-voice/server";
import {
  startWebVoiceTunnel,
  type WebVoiceTunnelHandle,
} from "./web-voice/tunnel";
import { ensureVadAssets } from "./web-voice/vad-assets";
import { assertWebTlsPolicy, ensureTls } from "./web-voice/tls";
import {
  assertHeadlessWebVoiceConfigured,
  assertHeadlessWebVoiceStarted,
  resolveWebVoiceToken,
} from "./web-voice/startup-policy";
import {
  bestEffortLanIPv4,
  removePairingState,
  webVoicePairingStatePath,
  writePairingState,
} from "./web-voice/pairing-state";
import { captureOperationalContext, DEFAULT_VOICE_CONTROL_STATE, isLocalFastPath, processWebTurn, streamWebTurn, streamWebTextTurn, type VoiceControlState, type WebReplySink } from "./web-voice/turn";
import { makeSpeculator } from "./web-voice/speculative";
import { MAX_TURN_AUDIO_BYTES } from "./web-voice/protocol";
import { TurnHistory } from "./web-voice/history";
import { classifyCallIntent, sendTelegramVoice, sendTelegramText, startTelegramUpdatePoller, telegramToken } from "./notify/telegram";
import { briefingTurnContext, notificationTurnContext } from "./notify/context";
import { KanbanWatcher, listViaCli, nudgeLine, spokenLine, taskLinkViaCli, taskParentsViaCli, type KanbanTask } from "./notify/kanban-watch";
import { inQuietHours, composeBriefing, composeBriefingDigest, chunkBriefingDigest, minutesPrompt, worthMinutes, callMinutesThresholdMs, dayOf } from "./notify/briefing";
import { PromptScheduler, scheduleLabel } from "./notify/schedules";
import {
  BriefingScheduler,
  BriefingStatusStore,
  type BriefingRunResult,
} from "./notify/briefing-scheduler";
import { OvernightStore } from "./notify/overnight-store";
import { brainExecutesTools, sendUnattended } from "./brain/capabilities";
import { buildResumePrimer, buildRosterNote } from "./web-voice/resume";
import { HealthStore, briefLine } from "./health/store";
import {
  render as renderOperationalState,
  snapshot as snapshotOperationalState,
  type CachedHealthSummary,
} from "./operational-state";
import { ActionConfigReloader } from "./actions-reload";
import { healthLog } from "./cli/health";

export interface RecordedWebTurn {
  sink: WebReplySink;
  drain: () => Promise<void>;
}

export type BriefingTelegramDeliveryOutcome = "accepted" | "failed" | "aborted";

/** Send every digest chunk in order and expose one scheduler-facing outcome. */
export async function deliverBriefingTelegramChunks(
  digest: string,
  send: (chunk: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<BriefingTelegramDeliveryOutcome> {
  for (const chunk of chunkBriefingDigest(digest)) {
    if (signal?.aborted) return "aborted";
    try {
      if (!await send(chunk)) return signal?.aborted ? "aborted" : "failed";
    } catch {
      return signal?.aborted ? "aborted" : "failed";
    }
  }
  return signal?.aborted ? "aborted" : "accepted";
}

/** Mirror a delivered briefing into the brain's one-shot turn context. */
export function injectDeliveredBriefingContext(
  injectContext: (context: string) => void,
  digest: string,
  delivered: boolean,
  at: Date,
): void {
  if (delivered) injectContext(briefingTurnContext(digest, at));
}

export interface OperatorChatTurnDeps {
  brain: Pick<Brain, "send" | "activeLane">;
  history: Pick<TurnHistory, "append">;
  operationalContext?: (signal?: AbortSignal) => Promise<string | null>;
}

/** Shared text-surface turn boundary: capture once, invoke once, then persist. */
export async function runOperatorChatTurn(
  text: string,
  deps: OperatorChatTurnDeps,
  signal?: AbortSignal,
): Promise<string> {
  const systemContext = await captureOperationalContext(deps.operationalContext, signal);
  signal?.throwIfAborted();
  const reply = await deps.brain.send(text, {
    signal,
    systemContext: systemContext ?? undefined,
  });
  signal?.throwIfAborted();
  await deps.history.append({
    t: Date.now(),
    user: text,
    reply,
    lane: deps.brain.activeLane?.() ?? undefined,
  });
  signal?.throwIfAborted();
  return reply;
}

/** Proxy a {@link WebReplySink} and expose the exact persistence drain it owns. */
export function createRecordedWebTurn(
  sink: WebReplySink,
  history: Pick<TurnHistory, "append">,
  onRecorded?: () => void,
  laneOf?: () => string | null | undefined,
): RecordedWebTurn {
  let transcript = "";
  const sentences: string[] = [];
  let finished = false;
  let persistence = Promise.resolve();
  const recordedSink: WebReplySink = {
    transcript: (t) => { transcript = t; sink.transcript(t); },
    sentence: (t) => { sentences.push(t); sink.sentence(t); },
    audio: (b) => sink.audio(b),
    control: (m) => sink.control(m),
    done: () => {
      sink.done();
      if (!finished) {
        finished = true;
      } else {
        return;
      }
      if (!sink.aborted() && (transcript || sentences.length)) {
        // Attribute the reply to whoever is pinned when it finishes — the
        // resume primer must know which turns were a colleague's, not Cicero's.
        persistence = history
          .append({ t: Date.now(), user: transcript, reply: sentences.join(" "), lane: laneOf?.() ?? undefined })
          .catch((error: unknown) => {
            log("warn", `web history append failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        onRecorded?.();
      }
    },
    error: (m) => sink.error(m),
    aborted: () => sink.aborted(),
  };
  return { sink: recordedSink, drain: () => persistence };
}

export async function recordParkedBriefingVoiceOutcome(
  signal: AbortSignal,
  channels: NonNullable<BriefingRunResult["channels"]>,
  writeCallback: () => Promise<unknown>,
  consumerAlive: () => Promise<boolean> = async () => true,
): Promise<void> {
  if (signal.aborted) {
    channels.voice = "aborted";
    channels.callback = "aborted";
    return;
  }
  try {
    const queued = await writeProactiveCallback(async () => {
      signal.throwIfAborted();
      return writeCallback();
    }, consumerAlive);
    if (signal.aborted) {
      channels.voice = "aborted";
      channels.callback = "aborted";
      return;
    }
    channels.callback = queued ? "accepted" : "failed";
  } catch {
    channels.callback = signal.aborted ? "aborted" : "failed";
    if (signal.aborted) channels.voice = "aborted";
  }
}

/** Proactive callback producers must not create a spool unless a consumer is
 *  currently alive. Explicit user dial-backs intentionally keep their own
 *  queue-for-later behavior. */
export async function writeProactiveCallback(
  writeCallback: () => Promise<unknown>,
  consumerAlive: () => Promise<boolean> = callbackConsumerAlive,
): Promise<boolean> {
  if (!await consumerAlive()) return false;
  return await writeCallback() !== false;
}
import { createAudioPlayer, createAudioRecorder } from "./platform/audio";
import { AecAudioHub, aecAvailable } from "./platform/aec-hub";
import { isVagueTabName, expandAliases as expandAliasesFn } from "./tab-parser";
import { stripFillers } from "./text-utils";
import { summarizeForTTS } from "./summarizer";
import { isLocalComputeTarget, parseActionRequest, runVoiceAction } from "./compute";
import { StartupCancelledByShutdownError } from "./process-lifecycle";
import { claimDaemonPidFile, type DaemonPidLease } from "./daemon-pid";

interface BackgroundTaskHandle {
  task: Promise<void>;
  settled: boolean;
}

interface BackgroundTaskOptions {
  /** Only cooperative work belongs in the shutdown drain. */
  drainOnShutdown?: boolean;
}

export interface DaemonOptions {
  skipServers?: boolean;
  /** Dependency injection hook for embedding/tests. Defaults to createProviders. */
  providerFactory?: typeof createProviders;
  /** Candidate factories for live swaps. Defaults to the built-in registry. */
  sttProviderFactory?: (config: RuntimeConfig) => STTProvider;
  ttsProviderFactory?: (config: RuntimeConfig) => TTSProvider;
  /** Override persistence and runtime-control publication for tests/embedders. */
  configPath?: string;
  runtimeControlDescriptorPath?: string;
  /** Optional speech-emotion provider injection for lifecycle tests/embedders. */
  serProviderFactory?: typeof createSerProvider;
  /** Optional TLS setup injection for lifecycle tests/embedders. */
  tlsEnsurer?: typeof ensureTls;
  /** Optional web listener injection for lifecycle tests/embedders. */
  webVoiceServerStarter?: typeof startWebVoiceServer;
  /** Override the process marker location for embedding/tests. */
  pidFile?: string;
  /** Override the credential-free phone-pairing publication for embedding/tests. */
  pairingStateFile?: string;
  /** Bound cancelled local-command drain before returning a retryable failure. */
  shutdownDrainTimeoutMs?: number;
  /** Override the bounded brain startup retry policy for tests/embedders. */
  brainReadiness?: BrainReadinessOptions;
}

/**
 * Whether this daemon may run the local dictation listener. Headless means no
 * local microphone at all — the hotkey, clap, and conversational capture are
 * already skipped for it — and a dictation toggle spawns a recorder on this very
 * box. Enabling both used to build the listener anyway, so the one configuration
 * that promises never to touch the microphone was the one that opened it.
 */
export function dictationRunnable(config: RuntimeConfig): boolean {
  return Boolean(config.dictation.enabled) && !config.headless;
}

const DEFAULT_DAEMON_SHUTDOWN_DRAIN_TIMEOUT_MS = 95_000;
/** Bounded retries when the loopback allocator repeats a port already staged. */
const STAGING_PORT_ATTEMPTS = 8;
/**
 * Backends that serve ONE fixed model and never read a configured one.
 *
 * Round 12 (Codex): a swap carried `request.model` into the persisted selection
 * for every backend, so `cicero swap tts kokoro acme/OtherKokoro` warmed,
 * persisted, and reported that model as active while the server went on serving
 * hexgrad/Kokoro-82M — the launch command has no model argument and the sidecar
 * hard-codes it. Reporting a model that is not loaded is worse than refusing:
 * the operator has no way to see it did not take.
 *
 * A DENYLIST, not an allowlist, on purpose. These three are known to ignore the
 * field (verified against their launch commands and request bodies). A backend
 * this daemon does not ship — a company plugin — may well honour a model, and
 * refusing it on a guess would break a supported extension path for no evidence.
 */
const FIXED_MODEL_BACKENDS: Readonly<Record<SwapRole, ReadonlySet<string>>> = {
  stt: new Set(["wyoming"]),
  tts: new Set(["kokoro", "pocket-tts", "wyoming"]),
};

const MANAGED_STT_BACKENDS = new Set(["mlx-whisper", "faster-whisper", "audiocpp"]);
const MANAGED_TTS_BACKENDS = new Set(["mlx-audio", "kokoro", "audiocpp", "pocket-tts", "vibevoice"]);

export interface VoiceProviderSwapPlan {
  selection: STTProviderConfig | TTSProviderConfig;
  fallback?: STTProviderConfig | TTSProviderConfig;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("could not allocate a loopback provider port");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
  }
}

function managedVoiceEndpoint(role: SwapRole, selection: STTProviderConfig | TTSProviderConfig): string | null {
  const managed = role === "stt" ? MANAGED_STT_BACKENDS : MANAGED_TTS_BACKENDS;
  if (!selection.backend || !managed.has(selection.backend) || !isLocalHost(selection.host)) return null;
  const port = selection.port ?? (role === "stt"
    ? sttDefaultPort(selection.backend)
    : ttsDefaultPort(selection.backend));
  return port === undefined ? null : `local:${port}`;
}

export async function planVoiceProviderSwap(
  config: RuntimeConfig,
  request: SwapRequest,
  allocatePort: () => Promise<number> = availableLoopbackPort,
): Promise<VoiceProviderSwapPlan> {
  if (request.model !== undefined && FIXED_MODEL_BACKENDS[request.role].has(request.backend)) {
    throw new Error(
      `the ${request.backend} ${request.role} backend serves one fixed model and ignores a configured one, `
      + `so '${request.model}' would be persisted and reported active without ever being loaded. `
      + `Swap without a model, or use a backend that selects one.`,
    );
  }
  const explicitSelection = request.role === "stt" ? config.raw.stt : config.raw.tts;
  const currentSelection = explicitSelection
    ?? (request.role === "stt" ? config.sttBackend : config.ttsBackend);
  // A cross-backend swap starts from whatever block already configures that
  // backend — in practice the fallback, which the operator has usually set up
  // in full. Building a bare {backend} instead discarded everything the
  // provider needs beyond its name, which made some backends unreachable as a
  // swap target entirely: `swap tts elevenlabs` dropped the configured voice ID
  // and key and then failed warmup asking for the voice ID it had just thrown
  // away. The role's own selection still wins when it already names the
  // requested backend; the model override is applied last either way.
  const configuredElsewhere = request.role === "stt"
    ? config.raw.stt_fallback as STTProviderConfig | undefined
    : config.raw.tts_fallback as TTSProviderConfig | undefined;
  const base = currentSelection?.backend === request.backend
    ? currentSelection
    : configuredElsewhere?.backend === request.backend
      ? configuredElsewhere
      : undefined;
  const selection: STTProviderConfig | TTSProviderConfig = base
    ? { ...base, ...(request.model ? { model: request.model } : {}) }
    : { backend: request.backend, ...(request.model ? { model: request.model } : {}) };
  // The provider being retired may OWN a managed server the other role is only
  // borrowing — one audio.cpp process serving both STT and TTS on a single port
  // is a supported and common single-seat setup. Retiring it stops that
  // process, and the untouched role is left pointing at a dead port while still
  // reporting itself active. Nothing here can transfer that ownership, so the
  // swap is refused rather than silently breaking the other half of the voice
  // stack. Give the operator the two ways out.
  const fallback = request.role === "stt" ? config.sttFallbackBackend : config.ttsFallbackBackend;
  // A role owns BOTH of its engines: the registry wraps primary and fallback in
  // one provider, and stopping that wrapper stops both. So every managed server
  // either half of the retiring role owns goes down with the swap, and every
  // managed server either half of the other role uses must survive it — a
  // configuration as ordinary as "TTS falls back to audio.cpp, STT uses
  // audio.cpp" collides on the fallback, not on the primary.
  const otherRole: SwapRole = request.role === "stt" ? "tts" : "stt";
  const otherEndpoints = new Set<string>();
  for (const provider of otherRole === "stt"
    ? [config.sttBackend, config.sttFallbackBackend]
    : [config.ttsBackend, config.ttsFallbackBackend]) {
    if (!provider) continue;
    const endpoint = managedVoiceEndpoint(otherRole, provider);
    if (endpoint) otherEndpoints.add(endpoint);
  }
  for (const retiring of [currentSelection, fallback]) {
    if (!retiring) continue;
    const endpoint = managedVoiceEndpoint(request.role, retiring);
    if (!endpoint || !otherEndpoints.has(endpoint)) continue;
    throw new Error(
      `${request.role.toUpperCase()} shares one managed ${retiring.backend} server with `
      + `${otherRole.toUpperCase()}, so swapping it would stop the process ${otherRole.toUpperCase()} is still using. `
      + `Give ${otherRole} its own port first, or swap both roles by editing config and restarting.`,
    );
  }

  const occupied = new Set<string>();
  for (const [role, provider] of [
    ["stt", config.sttBackend],
    ["stt", config.sttFallbackBackend],
    ["tts", config.ttsBackend],
    ["tts", config.ttsFallbackBackend],
  ] as const) {
    if (!provider) continue;
    const endpoint = managedVoiceEndpoint(role, provider);
    if (endpoint) occupied.add(endpoint);
  }

  const stage = async <T extends STTProviderConfig | TTSProviderConfig>(role: SwapRole, value: T): Promise<T> => {
    const staged = { ...value };
    let endpoint = managedVoiceEndpoint(role, staged);
    // The allocator binds a port, reads it, and closes again, so two calls can
    // legitimately hand back the SAME port — nothing is holding it in between.
    // Staging the selection and its fallback onto one endpoint puts two managed
    // servers on one port: STT rejects that outright, and TTS starts both
    // engines concurrently on it. Keep asking until the answer is actually free,
    // and refuse rather than stage a collision if it never is.
    for (let attempt = 0; endpoint && occupied.has(endpoint); attempt += 1) {
      if (attempt >= STAGING_PORT_ATTEMPTS) {
        throw new Error(
          `could not stage ${role.toUpperCase()} on a free loopback port after ${STAGING_PORT_ATTEMPTS} attempts; `
          + "the active provider and config are unchanged.",
        );
      }
      staged.port = await allocatePort();
      endpoint = managedVoiceEndpoint(role, staged);
    }
    if (endpoint) occupied.add(endpoint);
    return staged;
  };

  const stagedSelection = await stage(request.role, selection);
  if (!fallback) return { selection: stagedSelection };
  return {
    selection: stagedSelection,
    fallback: await stage(request.role, fallback),
  };
}

/** Wrap one finished string as a single-shot async stream for the streaming speaker. */
async function* asyncOnce(text: string): AsyncGenerator<string> {
  yield text;
}

export class CiceroDaemon {
  private config: RuntimeConfig;
  private options: DaemonOptions;
  private listener!: Listener;
  private router!: Router;
  private brain!: Brain;
  private speaker!: Speaker;
  private terminal!: TerminalAdapter;
  private executor!: ActionExecutor;
  private servers!: ServerManager;
  private startupPolicies: BackendStartupPolicies = {};
  private contextStore = new ContextStore();
  private providers!: BackendProviders;
  private sttSlot: ProviderSlot<STTProvider> | null = null;
  private ttsSlot: ProviderSlot<TTSProvider> | null = null;
  /**
   * Slots a shutdown could not confirm release for. A retained slot is the only
   * remaining handle on an unreaped child, and startup overwrites the two fields
   * above — so anything still unconfirmed moves here instead of being dropped,
   * and is retried on every later stop(). ProviderSlot.stop() is idempotent per
   * generation and clears its memo on failure, so retrying is safe and effective.
   */
  private unreleasedSlots: Array<{ role: "stt" | "tts"; stop: () => Promise<void> }> = [];
  /**
   * The web-voice filler bank, held so a live TTS swap can invalidate the clips it
   * primed on the retired provider. Undefined when thinking fillers are disabled.
   */
  private webFillerBank: FillerBank | undefined;
  private runtimeControl: RuntimeControlHandle | null = null;
  private voiceSwapRunning = false;
  /** Ready to accept turns; kept separate from the finer-grained lifecycle state. */
  private running = false;
  private lifecycle: "idle" | "starting" | "running" | "stopping" = "idle";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private lifecycleAbort = new AbortController();
  private backgroundTasks = new Set<Promise<void>>();
  private toneStartupTask: BackgroundTaskHandle | null = null;
  private actionsReloader: ActionConfigReloader | null = null;
  private conversational: ConversationalListener | null = null;
  private turnDetector: TurnDetector | null = null;
  private serProvider: SerProvider | null = null;
  private clapListener: ClapListener | null = null;
  private streamingSpeaker: StreamingTTSSpeaker | null = null;
  private lastFiller?: string; // last thinking-filler spoken, so the next one varies
  private aecHub: AecAudioHub | null = null;
  private voiceDesiredActive = false;
  /**
   * Dictation is holding the local microphone for a capture. Clap must not
   * re-arm underneath it and voice mode must not claim the device from under
   * it — on an exclusive capture device two recorders is a broken stream, not a
   * shared one.
   */
  private dictationHoldsMicrophone = false;
  private voiceTransition: Promise<void> = Promise.resolve();
  // Includes conversational recorder release, AEC direct-child reap, and any
  // conditional clap re-arm. Shutdown drains this exact barrier before touching
  // the audio owners again.
  private voiceInputHandoff: Promise<void> = Promise.resolve();
  private dashboard: DashboardHandle | null = null;
  private webVoice: WebVoiceHandle | null = null;
  private webVoiceTunnelOwner: Pick<WebVoiceTunnelHandle, "stop"> | null = null;
  private webVoiceTunnel: WebVoiceTunnelHandle | null = null;
  private webVoicePairingStartedAt: string | null = null;
  private kanbanWatcher: KanbanWatcher | null = null;
  private briefingScheduler: Pick<BriefingScheduler, "start" | "stop"> | null = null;
  private promptScheduler: PromptScheduler | null = null;
  private briefingStatusStore: BriefingStatusStore | null = null;
  private healthStore: HealthStore | null = null;
  /** Set at the exact lifecycle transition that begins accepting turns. */
  private startedAtMs: number | null = null;
  private minutesTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTelegramPoller: (() => void) | null = null;
  private pidLease: DaemonPidLease | null = null;

  /** Overnight queue for quiet-hours notifications, persisted across restarts. */
  private overnightStore: OvernightStore | null = null;
  private getOvernightStore(): OvernightStore {
    return this.overnightStore ??= new OvernightStore();
  }

  /**
   * Record a health log through the daemon's own store. The operational snapshot
   * reads the health record fresh from the store at capture time (see
   * operationalContext), so no cached summary needs refreshing here — the append
   * is immediately visible to the next turn on every surface.
   */
  private async logHealth(metric: string, words: string[]): Promise<string> {
    return healthLog(metric, words, this.healthStore ?? undefined);
  }

  /** Initialize snapshot sources independently of any operator transport. */
  private initializeOperationalState(): HealthStore {
    const healthStore = this.healthStore ??= new HealthStore();
    if (this.config.notify?.briefing?.at) {
      this.briefingStatusStore ??= new BriefingStatusStore(undefined, this.config.notify?.timezone);
    } else {
      this.briefingStatusStore = null;
    }
    const kw = this.config.notify?.kanban;
    if (!this.kanbanWatcher && kw && kw.enabled !== false && kw.command) {
      const listCommand = kw.command;
      this.kanbanWatcher = new KanbanWatcher({
        list: (signal) => listViaCli(listCommand, { signal }),
        announce: async (t, signal) => {
          if (!this.webVoice) return;
          // A lane-owned task announces itself in that employee's voice.
          const lane = t.assignee && this.config.brain.lanes?.[t.assignee] ? t.assignee : undefined;
          // Deliverable link (usually the PR) rides along for the screen;
          // the notify path keeps it out of the spoken audio.
          const link = kw.task_command ? await taskLinkViaCli(t.id, kw.task_command, { signal }) : null;
          if (signal.aborted) return;
          const line = link ? `${spokenLine(t, !!lane)} ${link}` : spokenLine(t, !!lane);
          const res = await this.webVoice?.notify(line, lane);
          if (signal.aborted) return;
          // Callback: nobody was listening (parked) — ring the phone.
          // The parked clip speaks the news the moment the call connects.
          // Blocked tasks never auto-ring (the user's call): their text
          // names the "have <name> call me" dial-back instead.
          if (res?.parked && kw.call_back && t.status !== "blocked") {
            const callbackRequest = JSON.stringify({ reason: line, at: Date.now() });
            const queued = await writeProactiveCallback(async () => {
              signal.throwIfAborted();
              return writeCallbackSpool(callbackRequest, signal);
            });
            if (signal.aborted) return;
            if (!queued) {
              log("info", "kanban watch: callback skipped — no live Telegram call consumer");
              return;
            }
            log("info", `kanban watch: callback requested — "${line.slice(0, 60)}"`);
          }
        },
        intervalMs: (kw.interval_seconds ?? 20) * 1000,
        // Unstarted tasks get one "nobody's picked this up" reminder —
        // text/voice only, never a ring; quiet hours defer it like any notify.
        nudge: async (t, waited, nth) => {
          await this.webVoice?.notify(nudgeLine(t, waited, nth));
        },
        nudgeAfterMs: (kw.nudge_after_minutes ?? 60) * 60_000,
        // Parents come from the per-task detail (the list feed omits them), so a
        // gated companion (e.g. a QA card parented to a not-yet-done work card)
        // is recognized as parked-behind-a-dependency, not "nobody picked it up".
        // Only wired when a task_command exists; without it, nudge on age alone.
        parents: kw.task_command
          ? (t, signal) => taskParentsViaCli(t.id, kw.task_command!, { signal })
          : undefined,
      });
      // Poll immediately only when no web voice surface will exist (Telegram-only
      // / host-mic-only), so the board snapshot is still populated there. When web
      // voice IS enabled, defer start() until this.webVoice is created (see the web
      // voice block): the watcher advances its delivery state as it polls, so an
      // announce/nudge consumed while this.webVoice is still null would be lost, not
      // replayed. start() is idempotent, so the deferred call is safe regardless.
      if (!this.config.web_voice?.enabled) {
        this.kanbanWatcher.start();
        log("ok", `📋 Kanban watch on — polling tasks every ${kw.interval_seconds ?? 20}s`);
      }
    }
    return healthStore;
  }

  /**
   * Start deferred board polling once web voice creation has been ATTEMPTED.
   *
   * On web deployments initializeOperationalState constructs the watcher but does
   * not start it (the watcher advances its delivery state as it polls, so an
   * announce/nudge consumed before this.webVoice exists would be lost). This runs
   * after the web voice block regardless of whether the server bound: an enabled
   * web voice that fails to bind (EADDRINUSE -> webVoice null) still leaves the
   * host-mic / Telegram surfaces working, and they need the board snapshot. Guarded
   * on `polling` so the non-web path (already started in init) neither double-starts
   * nor re-logs; start() is itself idempotent.
   */
  private startBoardPollingIfPending(): void {
    if (this.kanbanWatcher && !this.kanbanWatcher.polling) {
      this.kanbanWatcher.start();
      log("ok", `📋 Kanban watch on — polling tasks every ${this.config.notify?.kanban?.interval_seconds ?? 20}s`);
    }
  }

  private snapshotKnownSecrets(): string[] {
    const secrets = new Set<string>();
    // Record the trimmed form: consumers authenticate with it (web-voice startup
    // trims the configured token), so a padded config value would otherwise leave
    // the live credential unmatched. The trimmed form also substring-matches any
    // padded occurrence in board text.
    const add = (value: string | undefined) => {
      const trimmed = value?.trim();
      if (trimmed) secrets.add(trimmed);
    };
    // Credentials are commonly stored as an env-var NAME (api_key_env / token_env)
    // rather than inline, so the real secret is resolved from process.env at
    // runtime. Redact those resolved values too — an env-resolved key named in a
    // board title would otherwise egress uncredacted (shape rules can't catch an
    // all-letter key, and snapshotKnownSecrets never saw the literal).
    const addEnv = (name: string | undefined) => {
      if (name?.trim()) add(process.env[name]);
    };
    // Every configured header is SENT to the remote endpoint, so treat each value as
    // potentially sensitive — a custom auth header (X-Auth, X-Api-Token, ...) matches
    // no fixed name pattern. Redacting an occasional non-secret header value that also
    // appears verbatim in board text is safe-fail, the operator-approved direction.
    const addHeaderValues = (headers: Record<string, string> | undefined) => {
      for (const value of Object.values(headers ?? {})) add(value);
    };

    add(this.config.web_voice?.token);
    // Mirror telegramToken()'s runtime resolution (explicit token, else token_env,
    // else the default CICERO_TELEGRAM_TOKEN env var) so the default is redacted too.
    if (this.config.notify?.telegram) add(telegramToken(this.config.notify.telegram) ?? undefined);
    add(this.config.brain?.api_key);
    addEnv(this.config.brain?.api_key_env);
    addHeaderValues(this.config.brain?.headers);
    const brain = this.config.brain;
    if (brain && OPENAI_COMPATIBLE_BACKENDS.includes(brain.backend)) {
      const target: LLMProviderConfig = {
        backend: brain.backend,
        baseUrl: brain.base_url,
        model: brain.model,
        apiKey: brain.api_key,
        apiKeyEnv: brain.api_key_env,
      };
      add(target.apiKey);
      addEnv(resolveOpenAiTarget(target).apiKeyEnv);
    }

    // A configured endpoint URL may embed credentials the api-key fields never
    // see — userinfo or a signed/query token — and validation permits both.
    // Inventory each component value (searchParams are already decoded).
    const addUrlCredentials = (raw: string | undefined) => {
      if (!raw?.trim()) return;
      let url: URL;
      try { url = new URL(raw); } catch { return; }
      for (const part of [url.username, url.password]) {
        add(part);
        try { add(decodeURIComponent(part)); } catch { /* malformed escape — raw form is inventoried above */ }
      }
      for (const value of url.searchParams.values()) add(value);
    };
    addUrlCredentials(this.config.brain?.base_url);
    addUrlCredentials(this.config.llmBackend?.baseUrl);
    addUrlCredentials(this.config.classifierBackend?.baseUrl);

    // Lane agents receive their configured env maps verbatim (brain.lanes.*.env
    // and each fallback's env) — an ANTHROPIC_API_KEY placed there reaches the
    // lane process but never the credential fields above. Same safe-fail
    // direction as configured headers: redact every value.
    for (const lane of Object.values(this.config.brain?.lanes ?? {})) {
      for (const value of Object.values(lane.env ?? {})) add(value);
      for (const fallback of lane.fallbacks ?? []) {
        for (const value of Object.values(fallback.env ?? {})) add(value);
      }
    }

    const llm = this.config.llmBackend;
    add(llm?.apiKey);
    if (llm && OPENAI_COMPATIBLE_BACKENDS.includes(llm.backend ?? "")) {
      addEnv(resolveOpenAiTarget(llm).apiKeyEnv);
    }
    addHeaderValues(llm?.extraHeaders);
    // The classifier takes the same credential fields as the reply model, so it
    // needs the same inventory — a key here is no less a key.
    const classifier = this.config.classifierBackend;
    add(classifier?.apiKey);
    if (classifier && OPENAI_COMPATIBLE_BACKENDS.includes(classifier.backend ?? "")) {
      addEnv(resolveOpenAiTarget(classifier).apiKeyEnv);
    }
    addHeaderValues(classifier?.extraHeaders);
    add(this.config.ttsBackend?.apiKey);
    add(this.config.ttsFallbackBackend?.apiKey);
    // ElevenLabs resolves its key from ELEVENLABS_API_KEY when no inline key is
    // configured (src/backends/tts/elevenlabs.ts) — mirror that resolution so the
    // live credential is in the set either way.
    if (this.config.ttsBackend?.backend === "elevenlabs" || this.config.ttsFallbackBackend?.backend === "elevenlabs") {
      add(process.env.ELEVENLABS_API_KEY);
    }

    return [...secrets];
  }

  private async operationalContext(signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const briefing = this.config.notify?.briefing;
    let health: CachedHealthSummary | null = null;
    const healthStore = this.healthStore;
    if (healthStore) {
      try {
        const entries = await healthStore.since(Date.now() - 24 * 60 * 60 * 1_000, signal);
        signal?.throwIfAborted();
        const summary = briefLine(entries);
        const asOfMs = entries.length === 0
          ? Date.now()
          : entries.reduce((newest, entry) => Math.max(newest, entry.t), entries[0]!.t);
        health = { status: "ok", summary: summary?.slice(0, 500) ?? null, asOfMs };
      } catch (error) {
        if (signal?.aborted) throw error;
        health = { status: "unavailable", asOfMs: Date.now() };
      }
    }
    const secrets = this.snapshotKnownSecrets();
    const state = await snapshotOperationalState({
      startedAtMs: this.startedAtMs,
      secrets,
      timezone: this.config.notify?.timezone,
      briefing: briefing?.at && this.briefingStatusStore ? {
        at: briefing.at,
        catchUpMinutes: briefing.catch_up_minutes ?? 180,
        store: this.briefingStatusStore,
      } : undefined,
      overnightStore: this.getOvernightStore(),
      board: () => this.kanbanWatcher?.snapshot() ?? null,
      health: () => health,
      prompts: () => {
        if (this.promptScheduler) return this.promptScheduler.snapshot();
        if ((this.config.notify?.schedules?.length ?? 0) > 0) {
          throw new Error("configured prompt scheduler unavailable");
        }
        return null;
      },
    }, signal);
    signal?.throwIfAborted();
    return renderOperationalState(state, secrets);
  }
  /** Synthesize a notification clip: lane-or-raw voice resolution plus the
   * URL strip (bare links are for the text surfaces — the audio never reads
   * one out). Shared by the eager (onNotify) and lazy (onNotifyRender)
   * paths so the two can never drift. */
  private async renderNotifyClip(text: string, voice: string | undefined): Promise<ArrayBuffer> {
    // voice = a lane name (its configured voice is used) or a raw voice name
    // — an employee's news arrives in the employee's voice.
    const laneVoice = voice ? this.config.brain.lanes?.[voice]?.voice ?? voice : undefined;
    const spoken = text.replace(/https?:\/\/[^\s<>"')\]]+/g, "").replace(/\s{2,}/g, " ").trim()
      || "I sent you the link.";
    return await this.providers.tts.generateAudio(speakable(spoken), laneVoice);
  }
  private pendingRecovery: { spoken: string[] } | null = null;
  /** The addressed-to-me veto, when configured. Shared by the host mic and the browser. */
  private intentJudge: IntentJudge | null = null;
  /**
   * Rolling context for the browser's turns, kept apart from the host
   * listener's: the two are different rooms, and a web deployment is usually
   * headless, where the listener's rings are never filled at all. Bounded --
   * this is captured room audio and must not accumulate.
   */
  private readonly webRecentUtterances: string[] = [];
  private readonly webRecentAssistantSpeech: string[] = [];

  private activeLocalTurn: AbortController | null = null;
  /** Every local mic/dashboard command, including superseded turns winding down. */
  private localTurnTasks = new Set<Promise<void>>();
  private startupVoiceWarmups = new Map<SwapRole, BackgroundTaskHandle>();
  private dictation: DictationListener | null = null;
  private hotkeyProc: ReturnType<typeof Bun.spawn> | null = null;

  constructor(config: RuntimeConfig, options: DaemonOptions = {}) {
    this.config = config;
    this.options = options;
  }

  private pairingStateFile(): string {
    return this.options.pairingStateFile
      ?? (this.options.pidFile
        ? join(dirname(this.options.pidFile), "web-voice", "pairing.json")
        : webVoicePairingStatePath());
  }

  private publishWebVoicePairingState(): void {
    if (!this.webVoice || !this.webVoicePairingStartedAt) return;
    try {
      writePairingState({
        scheme: this.webVoice.scheme,
        port: this.webVoice.port,
        lanHost: bestEffortLanIPv4(),
        tunnelProvider: this.webVoiceTunnel?.provider ?? null,
        tunnelUrl: this.webVoiceTunnel?.publicUrl ?? null,
        startedAt: this.webVoicePairingStartedAt,
        pid: process.pid,
      }, this.pairingStateFile());
    } catch (error: unknown) {
      log("warn", `web-voice pairing state could not be published: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removeWebVoicePairingState(): void {
    if (!this.webVoicePairingStartedAt) return;
    try {
      removePairingState(this.pairingStateFile(), process.pid);
    } catch (error: unknown) {
      log("warn", `web-voice pairing state could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async start(): Promise<void> {
    if (this.lifecycle === "running") return;
    if (this.lifecycle === "starting" && this.startPromise) return this.startPromise;
    if (this.lifecycle !== "idle") throw new Error(`Cicero daemon cannot start while ${this.lifecycle}`);
    this.lifecycle = "starting";
    this.stopRequested = false;
    this.lifecycleAbort = new AbortController();
    // Before anything can log. A remote endpoint routinely quotes the key it
    // just rejected, and a configured key is often an ordinary-looking string
    // no shape rule can recognise — the configured VALUE is what identifies it.
    registerKnownSecrets(this.snapshotKnownSecrets());
    const starting = this.startWithRollback();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  private async startWithRollback(): Promise<void> {
    try {
      await this.startComponents();
    } catch (error) {
      if (!this.stopRequested) {
        this.stopRequested = true;
        this.lifecycleAbort.abort();
        this.lifecycle = "stopping";
        this.running = false;
        const rollback = this.stopInternal();
        this.stopPromise = rollback;
        await rollback.catch((cleanupError: unknown) => {
          log("warn", `Startup rollback had cleanup errors: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        });
        if (this.stopPromise === rollback) this.stopPromise = null;
      }
      if (error instanceof StartupCancelledByShutdownError) throw error;
      throw new Error(`Cicero daemon failed to start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private assertStartupActive(): void {
    if (this.stopRequested || this.lifecycleAbort.signal.aborted) {
      throw new StartupCancelledByShutdownError();
    }
  }

  /** Track best-effort warmups; only signal-cooperative work joins the drain. */
  private runBackground(
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
    options: BackgroundTaskOptions = {},
  ): BackgroundTaskHandle {
    const signal = this.lifecycleAbort.signal;
    const task = Promise.resolve()
      .then(() => action(signal))
      .catch((error: unknown) => {
        if (!signal.aborted) {
          log("info", `${label} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    const handle: BackgroundTaskHandle = { task, settled: false };
    void task.then(
      () => { handle.settled = true; },
      () => { handle.settled = true; },
    );
    if (options.drainOnShutdown ?? true) {
      this.backgroundTasks.add(task);
      void task.then(
        () => { this.backgroundTasks.delete(task); },
        () => { this.backgroundTasks.delete(task); },
      );
    }
    return handle;
  }

  private async drainBackgroundTasks(): Promise<void> {
    try {
      // Tasks can schedule continuations before settling, so drain until the owned
      // set is actually empty rather than taking one stale snapshot.
      while (this.backgroundTasks.size > 0) {
        await Promise.allSettled([...this.backgroundTasks]);
      }
    } catch (error) {
      throw new Error(`background task drain failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** Releases the daemon-wide history compactor; null when compaction is off. */
  private releaseCompactor: (() => void) | null = null;

  private async startComponents(): Promise<void> {
    const totalSteps = 5;

    assertHeadlessWebVoiceConfigured(this.config.headless, this.config.web_voice?.enabled === true);

    // Claim a private, ownership-checked marker before starting any resources.
    // Exclusive creation prevents duplicate daemons; the process-start identity
    // prevents a stale, reused PID from being mistaken for this instance.
    const pidFile = this.options.pidFile ?? ciceroPath("cicero.pid");
    this.pidLease = await claimDaemonPidFile(pidFile);
    this.assertStartupActive();

    // Create providers from config. Stable facades keep every long-lived listener,
    // speaker, and web handler pointed at the current generation after a live swap.
    const initialProviders = (this.options.providerFactory ?? createProviders)(this.config);
    // Assigning the slots below drops whatever they referenced. If a previous
    // shutdown could not confirm release, that reference is the only handle on a
    // still-running child, so retry it first and keep anything still unconfirmed
    // where later stop() calls will keep trying, rather than losing it here.
    await this.retryUnconfirmedProviderRelease();
    for (const retained of [
      { role: "stt" as const, slot: this.sttSlot as { stop: () => Promise<void> } | null },
      { role: "tts" as const, slot: this.ttsSlot as { stop: () => Promise<void> } | null },
    ]) {
      if (retained.slot) {
        const slot = retained.slot;
        this.unreleasedSlots.push({ role: retained.role, stop: () => slot.stop() });
      }
    }
    this.sttSlot = new ProviderSlot(initialProviders.stt);
    this.ttsSlot = new ProviderSlot(initialProviders.tts);
    this.providers = {
      ...initialProviders,
      stt: new SwappableSTTProvider(this.sttSlot),
      tts: new SwappableTTSProvider(this.ttsSlot),
    };
    this.runtimeControl = await startRuntimeControl({
      token: this.pidLease.record.token,
      pid: this.pidLease.record.pid,
      descriptorPath: this.options.runtimeControlDescriptorPath,
      onSwap: (request, swapOptions) => this.swapVoiceProvider(request, swapOptions),
    });
    this.assertStartupActive();
    this.startupPolicies = createBackendStartupPolicies(this.config, {
      builtInProviders: this.options.providerFactory === undefined
        || this.options.providerFactory === createProviders,
    });
    // Background history compaction (opt-in). Every brain adapter builds its own
    // private BrainTurnContext, so the compactor is registered process-wide here
    // rather than threaded through eight constructors and every brain wrapper.
    // Without it the transcript evicts its oldest turns exactly as it always has.
    const compaction = this.config.brain.history_compaction;
    if (compaction?.enabled) {
      const compactor = createHistoryCompactor({
        summarizer_url: compaction.summarizer_url ?? this.config.web_voice?.tldr?.summarizer_url,
        summarizer_model: compaction.summarizer_model ?? this.config.web_voice?.tldr?.summarizer_model,
      });
      if (compactor) {
        // Shutdown must be able to cancel a compaction that is already in the
        // air, not just stop new ones from starting. This controller is the
        // daemon's handle on every request the registered compactor makes.
        const abort = new AbortController();
        const unregister = setDefaultHistoryCompactor((input, signal) =>
          compactor(input, AbortSignal.any([signal, abort.signal])));
        this.releaseCompactor = () => {
          unregister();
          abort.abort();
        };
      }
      else log("warn", "brain.history_compaction is enabled but no summarizer_url is configured — history will evict its oldest turns instead");
    }

    const audioPlayer = createAudioPlayer();
    const audioRecorder = createAudioRecorder();

    // Localhost voice dashboard (default on, :8086). Start it first so all
    // startup logs stream to it. A dashboard failure never blocks the daemon.
    const dash = this.config.dashboard;
    if (dash?.enabled !== false) {
      this.dashboard = startDashboard({
        port: dash?.port ?? 8086,
        token: crypto.randomUUID(),
        onControl: (action) => this.handleDashboardControl(action),
      });
      if (this.dashboard) {
        dashBus.setConfig({
          brain: this.config.brain.backend,
          model: this.config.raw.llm?.model ?? this.config.servers.router.model,
          ttsVoice: this.config.raw.tts?.voice ?? this.config.voice,
          ttsBackend: this.config.raw.tts?.backend ?? "tts",
        });
      }
    }

    // Step 1: Start model servers via providers
    // Retain the ServerManager in BOTH paths: it is the shutdown owner that stops
    // every provider (initial and any hot-swapped-in generation via the slot
    // facades). Under --no-servers we skip *starting* managed servers but must
    // still own teardown, or a swapped/initial STT/TTS provider leaks past stop().
    this.servers = new ServerManager();
    if (this.options.skipServers) {
      logStep(1, totalSteps, "Skipping model servers (--no-servers)");
      await this.servers.verifyRequired(this.providers, this.startupPolicies);
      this.assertStartupActive();
    } else {
      logStep(1, totalSteps, "Starting model servers...");
      await this.servers.start(this.providers, this.startupPolicies);
      this.assertStartupActive();
    }

    // Step 2: Initialize components using providers
    logStep(2, totalSteps, "Initializing components...");
    this.terminal = createTerminalAdapter(this.config);
    this.router = createRouter(this.config, this.providers.llm);
    this.brain = createBrain(this.config, this.terminal, {
      onNudgeReply: (text) => { void this.deliverProactiveReply(text); },
      onConfirmationPending: (summary, nonce) => {
        this.webVoice?.confirmPending(summary, nonce);
      },
      dialBackControl: true,
    });
    this.speaker = createSpeaker(this.config, this.providers.tts, audioPlayer);
    this.executor = new ActionExecutor(this.config, this.terminal, this.brain, this.speaker, this.contextStore, this.providers.llm);
    const healthStore = this.initializeOperationalState();
    this.assertStartupActive();

    // AEC audio hub (macOS): routes mic + TTS through the echo-cancelling helper so
    // the mic doesn't hear Cicero's own voice — what lets genuine voice barge-in
    // work over open speakers. Created here but STARTED lazily on voice activation
    // and stopped on deactivate (toggleVoiceMode): the helper is only needed while
    // a conversation is live. While idle it would hold the mic via Voice Processing
    // — whose noise suppression also crushes the activation clap — so we leave the
    // mic to the raw-sox clap listener. Opt-in (config `aec`); needs the built
    // helper, else it degrades gracefully to the no-AEC path.
    if (this.config.aec && !this.config.headless) {
      if (aecAvailable()) {
        this.aecHub = new AecAudioHub();
      } else {
        log("warn", "config `aec` is on but the helper isn't built — run: bun run build:aec (continuing without echo cancellation)");
      }
    }
    this.streamingSpeaker = createStreamingSpeaker(this.config, this.providers.tts, audioPlayer, this.aecHub);

    // Step 3: Start brain
    const brainMode = this.config.brain.mode || "subprocess";
    // tab-inject only applies to the Claude Code backend; other backends ignore it,
    // so don't mislabel them (e.g. an openai-compatible/HTTP brain is not "→ tab …").
    const usesTab = brainMode === "tab-inject" && this.config.brain.backend === "claude-code";
    const brainLabel = usesTab
      ? `${this.config.brain.backend} → tab "${this.config.brain.target_tab || "cicero-brain"}"`
      : this.config.brain.backend;
    logStep(3, totalSteps, `Starting Brain (${brainLabel})...`);
    await this.brain.start();
    this.assertStartupActive();
    const readiness = await waitForBrainReadiness(
      this.brain,
      this.lifecycleAbort.signal,
      this.options.brainReadiness,
    );
    if (!readiness.healthy) {
      const attemptLabel = `${readiness.attempts} attempt${readiness.attempts === 1 ? "" : "s"}`;
      const budgetLabel = readiness.timedOut ? ` within its ${readiness.timeoutMs}ms budget` : "";
      const errorLabel = readiness.lastError === undefined
        ? ""
        : `; last error: ${readiness.lastError instanceof Error ? readiness.lastError.message : String(readiness.lastError)}`;
      throw new Error(
        `configured brain '${this.config.brain.backend}' failed its startup readiness check after ${attemptLabel}${budgetLabel}${errorLabel}; run cicero doctor for the exact binary, endpoint, or credential fix`,
        readiness.lastError === undefined ? undefined : { cause: readiness.lastError },
      );
    }
    this.assertStartupActive();
    log("ok", "Brain ready");
    // The dial-back is a capability of the daemon, not of Telegram: a typed
    // "call me" (bot poller below) and a SPOKEN one (brain control decorator)
    // both spool the same ring for the tgcall sidecar.
    const dialBack = async (who?: string, options?: BrainTurnOptions): Promise<string> => {
      const signal = options?.signal ?? this.lifecycleAbort.signal;
      signal.throwIfAborted();
      // "have ada call me": pin the lane BEFORE spooling the ring, so
      // the call connects straight to that employee (voice included) —
      // the same sticky pin as a spoken transfer; "back to you" releases.
      let ack = "Ringing you now.";
      let lanePickup: string | undefined;
      if (who) {
        // The lane picks up briefed on its parked tasks — "have ada
        // call me" after a blocked announcement is THE conversation about
        // the blocker. The lane agent digs up details with its own shell.
        const brief = async (lane: string): Promise<string | null> => {
          const kw = this.config.notify?.kanban;
          // No configured board command = no board to consult (fail closed).
          if (!kw?.command || kw.enabled === false) return null;
          signal.throwIfAborted();
          const parked = (await listViaCli(kw.command, { signal }))
            .filter((t) => t.status === "blocked" && t.assignee === lane);
          signal.throwIfAborted();
          if (parked.length === 0) return null;
          const list = parked.map((t) => `${t.id} "${t.title}"`).join(", ");
          return `The user is calling you back about your parked task${parked.length > 1 ? "s" : ""}: ${list}. ` +
            "Pull up the details yourself with your board CLI and open by saying what you're blocked on and what you need from them.";
        };
        const name = await this.brain.transferTo?.(who, brief, { signal });
        signal.throwIfAborted();
        if (!name) {
          const roster = Object.keys(this.config.brain.lanes ?? {}).join(", ");
          return roster
            ? `I couldn't get "${who}" on the line. I can put on: ${roster} — or just say "call me".`
            : `I couldn't get "${who}" on the line — say "call me" and I'll ring you myself.`;
        }
        lanePickup = name;
        ack = `Ringing you now — ${name} will pick up.`;
      }
      signal.throwIfAborted();
      // Spool unconditionally: an explicit "call me" is never dropped, so it
      // still rings if the sidecar comes up moments later (one fixed-path
      // file, overwritten — a consumer-less install never piles them up).
      const callbackRequest = JSON.stringify({ reason: "text dial-back", lane: who ?? null, at: Date.now() });
      const published = await writeCallbackSpool(callbackRequest, signal);
      if (!published) signal.throwIfAborted();
      // Only promise a ring when a consumer is provably alive. With no call
      // sidecar running there is nothing to consume the spool, so answer
      // honestly instead of overpromising "Ringing you now." — the sidecar's
      // heartbeat stays fresh while it places or defers a ring mid-call. A
      // sidecar with no configured callback owner advertises no heartbeat.
      if (await callbackConsumerAlive()) return ack;
      return lanePickup
        ? `I've lined up ${lanePickup}, but I don't have a phone line set up right now — the call sidecar isn't running, so I can't ring you. I've queued the request in case it starts.`
        : "I don't have a phone line set up right now — the call sidecar isn't running, so I can't ring you. I've queued the request in case it starts.";
    };
    this.brain.setCallMeHandler?.(dialBack);

    // ONE history for every surface that records a turn. Separate instances
    // over the same file each keep their own append chain, so one instance's
    // trim rewrite can drop lines another just appended — and TurnHistory's
    // cached line count assumes a single writer. Built lazily: a daemon with
    // neither Telegram nor web voice never touches the file.
    let conversationHistory: TurnHistory | undefined;
    const history = () => conversationHistory ??= new TurnHistory(
      join(homedir(), ".cicero", "web-voice", "history.jsonl"),
    );

    if (this.config.notify?.telegram) {
      // Since Jul 10 the bot is the office's TEXT surface (the tgcall userbot
      // keeps only calls): "log …" hits the health record instantly, "call me"
      // spools a dial-back for the tgcall sidecar, and anything else is a
      // chat turn against the same brain the voice surfaces reach — recorded
      // in the shared history so voice sessions resume with it.
      const tgHistory = history();
      // Semantic fallback for dial-back phrasings the lexical pattern misses
      // ("get ada on the horn") — the same small local model the
      // switchboard uses for spoken transfers. Lexical-only without a
      // summarizer endpoint; a wrong or slow verdict degrades to a chat turn.
      const callClassifier = summarizerClassifier(this.config.web_voice?.tldr);
      this.stopTelegramPoller = startTelegramUpdatePoller(this.config.notify.telegram, this.brain, undefined, undefined, {
        onHealthLog: (metric, words) => this.logHealth(metric, words),
        onCallMe: dialBack,
        onChat: async (text) => {
          if (callClassifier) {
            const intent = await classifyCallIntent(text, callClassifier, Object.keys(this.config.brain.lanes ?? {}));
            if (intent) return dialBack(intent.who);
          }
          // Own the turn under the daemon lifecycle so a slow brain turn is
          // cancelled on shutdown instead of running (up to the provider timeout)
          // and publishing a reply / history append after stop() has returned.
          return runOperatorChatTurn(text, {
            brain: this.brain,
            history: tgHistory,
            operationalContext: (signal) => this.operationalContext(signal),
          }, this.lifecycleAbort.signal);
        },
      });
      log("ok", "Telegram text surface ready (chat, log, call me, approvals)");
    }

    // Pre-warm the brain too: the first agent turn of a fresh session pays the
    // full system prompt with a cold provider-side prompt cache (measured ~8s vs
    // ~1.6s warm on hermes→NVIDIA). One throwaway turn primes the cache so the
    // user's first real utterance is warm. Fire-and-forget.
    //
    // Session resume rides the same turn: a restart starts a FRESH agent
    // session, so the warmup carries a recap of the recent conversation
    // (web-voice chat history) — Cicero picks up where it left off instead of
    // drawing a blank. `web_voice.resume_turns: 0` disables it.
    this.runBackground("brain warmup", async (signal) => {
      let warmMsg = "Warmup ping — reply with just: ok";
      const resumeTurns = this.config.web_voice?.resume_turns ?? 10;
      if (this.config.web_voice?.enabled && resumeTurns > 0) {
        try {
          const primer = buildResumePrimer(await history().recent(resumeTurns));
          if (primer) warmMsg = primer;
        } catch { /* no history — plain warmup */ }
      }
      // Teach the front desk its own office: who the employees are and how the
      // user transfers. Rides the same warmup turn, before the ack instruction.
      const roster = buildRosterNote(this.config.brain.lanes, this.config.brain.escalate?.triggers);
      if (roster) warmMsg = `${roster}\n\n${warmMsg}`;
      await this.brain.send(warmMsg, { signal });
      if (!signal.aborted) {
        log("ok", warmMsg.length > 60 ? "Brain warmed (cache primed + conversation resumed)" : "Brain warmed (prompt cache primed)");
      }
    });

    // Native dictation is opt-in. Resolve its typing capability now rather than
    // on first use, so an operator on a session that cannot synthesize
    // keystrokes (Wayland, or Linux without xdotool) learns at startup instead
    // of pressing the hotkey and watching nothing happen.
    if (this.config.dictation.enabled && this.config.headless) {
      log("warn", "Dictation is enabled but headless mode is on — no local microphone is opened, so dictation is disabled this run");
    }
    if (dictationRunnable(this.config)) {
      const built = createDictationListener(this.config, this.providers.stt, audioRecorder, {
        acquire: () => this.acquireDictationMicrophone(),
        release: () => this.releaseDictationMicrophone(),
      });
      if ("listener" in built) {
        this.dictation = built.listener;
        // The "cicero" target delivers through this callback. Without it the
        // whole path succeeds and then silently drops every transcript.
        this.dictation.onCommand((text) => this.dispatchCommand(text));
        await this.dictation.start();
      } else {
        log("warn", `Dictation is configured but unavailable: ${built.unavailable}`);
      }
      this.assertStartupActive();
    }

    // Pre-warm TTS and STT so the first turn isn't hit with a multi-second cold
    // model load. Fire-and-forget — startup must not block on warmup.
    if (!this.startupPolicies.tts?.skipReason) {
      this.startupVoiceWarmups.set("tts", this.runBackground(
        "TTS warmup",
        () => warmupProvider(this.providers.tts),
        { drainOnShutdown: false },
      ));
    }
    if (!this.options.skipServers) {
      if (!this.startupPolicies.stt?.skipReason && this.providers.stt.warmup) {
        this.startupVoiceWarmups.set("stt", this.runBackground(
          "STT warmup",
          () => this.providers.stt.warmup!(),
          { drainOnShutdown: false },
        ));
      }
      // Warm the router/LLM model too — the first classify cold-loads it (~5s).
      if (!this.startupPolicies.llm?.skipReason) {
        this.runBackground("LLM warmup", (signal) => this.providers.llm
          .chatCompletion([{ role: "user" as const, content: "hi" }], { max_tokens: 1, signal })
          .then(() => { if (!signal.aborted) log("ok", "LLM model warmed"); }));
      }
      // The classifier role promises a model that is already warm, but startup
      // only ever probed its health — and a health probe does not load a model.
      // On ollama it is GET /api/tags, which lists what is AVAILABLE; the model
      // loads on the first generate/chat request. On an adopted llama-server the
      // probe says nothing about which model is resident either. So warm it the
      // same way as the reply model: with a real completion, in the background,
      // best-effort. A classifier that cannot answer this is not fatal — every
      // caller of it already falls back.
      const classifier = this.providers.classifier;
      if (classifier && !this.startupPolicies.classifier?.skipReason) {
        this.runBackground("classifier warmup", (signal) => classifier
          .chatCompletion([{ role: "user" as const, content: "hi" }], { max_tokens: 1, signal })
          .then(() => { if (!signal.aborted) log("ok", "Classifier model warmed"); }));
      }
    }

    // Step 3b: Web voice server (browser audio client). For a headless box with no
    // mic/speakers, the browser is the audio I/O. Off by default. Reuses the
    // STT → brain → TTS pipeline at the provider level (see processWebTurn).
    // Built BEFORE the web server binds. The browser accepts turns the moment
    // the port opens, and a judge constructed later leaves every turn in that
    // window unjudged -- which is indistinguishable, to an operator, from the
    // feature not working.
    const judgeCfg = this.config.intentJudge;
    if (judgeCfg.enabled) {
      const judge = createIntentJudge(this.providers.classifier, {
        hotWindowMs: judgeCfg.hotWindowMs,
        minConfidence: judgeCfg.minConfidence,
        contextTurns: judgeCfg.contextTurns,
        timeoutMs: judgeCfg.timeoutMs,
      });
      if (judge) {
        this.intentJudge = judge;
        log("info", "Intent judge on: utterances are checked against the classifier before they become commands");
      } else {
        // Never silently borrow the reply model for a per-utterance decision.
        log("warn", "intent_judge.enabled is set but no `classifier` backend is configured — every utterance will be accepted as before; see docs/intent-judge.md");
      }
    }
    const wv = this.config.web_voice;
    if (wv?.enabled) {
      const webHost = wv.host ?? "0.0.0.0";
      const webPort = wv.port ?? 8090;
      const { token, ephemeral: tokenIsEphemeral } = resolveWebVoiceToken(wv.token);
      // Pre-render the "let me think…" fillers once so the web path can cover the
      // brain's latency with an instant (cached) clip. Same thinking_filler gate
      // as the host path; primed fire-and-forget after TTS warmup, and pick()
      // returns undefined until ready, so early turns simply skip the filler.
      let webFiller: FillerBank | undefined;
      if (this.config.brain.thinking_filler ?? true) {
        webFiller = new FillerBank(this.providers.tts, this.config.raw.filler_lines);
        this.webFillerBank = webFiller;
      }
      // Prime fillers, THEN warm lane voices — one strictly sequential chain
      // (fire-and-forget as a whole). A cold clone prep makes a large transient
      // GPU allocation; two preps landing together can abort the TTS server
      // (seen as SIGABRT on the audiocpp CUDA seat), so startup never runs
      // filler priming and voice warmups concurrently. Fillers go first: they
      // prep the front desk's own voice, which the first real turn needs.
      {
        const filler = webFiller;
        const laneVoices = [...new Set(
          Object.values(this.config.brain.lanes ?? {})
            .map((l) => l.voice)
            .filter((v): v is string => !!v),
        )];
        this.runBackground("web voice warmup", async (signal) => {
          if (filler) {
            try {
              const n = await filler.prime();
              log("ok", `web-voice filler bank primed (${n} clips)`);
            } catch (err: unknown) {
              log("info", `filler prime skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          // Warming each lane clone computes its voice embedding (~1-2s each)
          // so the first roll call of the day isn't the slow one.
          if (laneVoices.length) {
            for (const v of laneVoices) {
              if (signal.aborted) return;
              try { await this.providers.tts.generateAudio("Warming up.", v); }
              catch (err: unknown) { log("info", `lane voice warmup skipped (${v}): ${err instanceof Error ? err.message : String(err)}`); }
            }
            log("ok", `lane voices warmed (${laneVoices.join(", ")})`);
          }
          // Last in the chain (voices are warm now, so these are cheap): a small
          // filler set PER LANE VOICE, so a pinned employee says "let me check"
          // in their own voice instead of getting silence.
          if (filler && laneVoices.length) {
            let clips = 0;
            for (const v of laneVoices) {
              if (signal.aborted) return;
              try { clips += await filler.primeVoice(v); }
              catch (err: unknown) { log("info", `lane filler prime skipped (${v}): ${err instanceof Error ? err.message : String(err)}`); }
            }
            log("ok", `lane filler clips primed (${clips} across ${laneVoices.length} voices)`);
          }
        });
      }
      const tlsExplicitlyDisabled = wv.tls?.enabled === false;
      let tls: Awaited<ReturnType<typeof ensureTls>> = null;
      if (!tlsExplicitlyDisabled) {
        try {
          tls = await (this.options.tlsEnsurer ?? ensureTls)({
            dir: join(homedir(), ".cicero", "web-voice"),
            certFile: wv.tls?.cert_file,
            keyFile: wv.tls?.key_file,
            signal: this.lifecycleAbort.signal,
          });
        } catch (error: unknown) {
          // Turn a cooperative TLS cancellation into the daemon's stable
          // startup-cancelled contract instead of reporting a setup failure.
          this.assertStartupActive();
          throw error;
        }
      }
      this.assertStartupActive();
      assertWebTlsPolicy(webHost, tls, tlsExplicitlyDisabled);
      const webHistory = history();
      // Every spoken sentence funnels through here — the one place to strip
      // Markdown/typography so a voice never says "dash" or glitches on an
      // em-dash. A sentence that is pure markup flattens to nothing and is
      // skipped without consuming a roll-call voice slot.
      const laneTts = createLaneTts(this.providers.tts, () => this.brain.activeLaneVoice?.());
      const voiceState: VoiceControlState = { ...DEFAULT_VOICE_CONTROL_STATE };
      // TLDR speech gate (on by default): long replies get their first sentences
      // spoken verbatim, the rest text-only, plus one spoken summary line.
      // "details" reads back the remainder. See TldrOptions in web-voice/turn.ts.
      let pendingDetail: string | null = null;
      let lastSpokenReply: string | null = null;
      const lastReply = {
        store: (spokenReply: string) => {
          lastSpokenReply = spokenReply;
          // The browser heard this, so the next verdict is judged against it --
          // a reply to Cicero's own question is what a judge most easily gets
          // wrong, and this is what opens the hot window on the web path.
          this.noteWebSpoken(spokenReply);
        },
        pending: () => lastSpokenReply,
      };
      const tldrCfg = wv.tldr;
      // One small-model completion helper, shared by the TLDR gate and the
      // call-minutes writer — same local summarizer endpoint for both.
      const summarizerComplete = createSummarizerComplete(tldrCfg);
      const tldr = (tldrCfg?.enabled ?? true)
        ? {
            cap: tldrCfg?.spoken_sentences ?? 4,
            store: (remainder: string) => { pendingDetail = remainder; },
            pending: () => pendingDetail,
            summarize: summarizerComplete
              ? (text: string) =>
                  summarizerComplete(`Summarize for text-to-speech in ONE short spoken sentence (max 25 words, no markdown):\n\n${text}`, 80)
              : undefined,
          }
        : undefined;
      // Interruption recovery: the streaming pipeline stores the spoken tail
      // of a barged-in reply here; a "continue" within the window hands it
      // back to the brain. One-shot and time-limited — a "continue" an hour
      // later should be a fresh question, not a séance.
      let interruptedTail: { text: string; at: number } | null = null;
      const recover = {
        store: (spokenPrefix: string) => {
          interruptedTail = { text: spokenPrefix, at: Date.now() };
          // The room heard this much before cutting in, so the next verdict is
          // judged against it. Without it, "yes" answering an interrupted
          // "Should I deploy staging?" is judged with no question in view and
          // can be declined as undirected.
          this.noteWebSpoken(spokenPrefix);
        },
        pending: () => {
          if (!interruptedTail || Date.now() - interruptedTail.at > 5 * 60 * 1000) return null;
          const t = interruptedTail.text;
          interruptedTail = null;
          return t;
        },
      };
      // Call minutes: after the last recorded turn, wait for the conversation
      // to go quiet, then text short notes to the phone — like leaving a
      // meeting and finding the minutes in your inbox. Quiet-based (not
      // hangup-based) so mid-call reconnects don't send notes early.
      const minutesQuietMs = Number(process.env.CICERO_MINUTES_QUIET_MS || 150000);
      let minutesSince = Date.now(); // turns before this instant are already covered
      const noteTurn = () => {
        if (!this.config.notify?.call_minutes || !summarizerComplete) return;
        const tg = this.config.notify?.telegram;
        if (!tg) return;
        clearTimeout(this.minutesTimer);
        this.minutesTimer = setTimeout(async () => {
          try {
            const turns = (await webHistory.recent(50)).filter((x) => x.t > minutesSince && x.user);
            // The quiet timer firing means THIS conversation is over — close the
            // window either way, or skipped short calls pile up and their combined
            // span trips the gate on a later 30-second check-in.
            minutesSince = Date.now();
            const mc = this.config.notify?.call_minutes;
            const minMs = callMinutesThresholdMs(mc);
            if (!worthMinutes(turns, minMs)) return; // short calls don't deserve minutes
            const notes = await summarizerComplete(minutesPrompt(turns), 250);
            // The summarizer can decline too — a long call can still be all small talk.
            if (/^\s*SKIP\.?\s*$/i.test(notes)) { log("info", "call minutes: nothing worth noting"); return; }
            void sendTelegramText(tg, `\u{1F4CB} Call notes:\n${notes}`);
            log("info", `call minutes sent (${turns.length} turns)`);
          } catch (err: unknown) {
            log("warn", `call minutes failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }, minutesQuietMs);
      };
      // Long-turn parking (opt-in): a turn whose first sentence hasn't arrived
      // within park_after_s hands the floor back and finishes detached; the
      // reply is delivered through the notify path in the lane's voice (urgent:
      // the user is mid-conversation, quiet hours don't apply). Full reply goes
      // to the chat pane via history; the SPOKEN version is summarized if long.
      const ltCfg = wv.long_turn;
      const deliverParked = async (reply: string, transcript: string, lane?: string): Promise<void> => {
        try {
          const trimmed = reply.trim();
          if (!trimmed) {
            await this.webVoice?.notify(
              "That long-running request came back empty — ask me again if you want a retry.",
              lane,
              { urgent: true },
            );
            return;
          }
          let spoken = trimmed;
          if (trimmed.length > 600 && summarizerComplete) {
            try {
              spoken = `In short: ${(await summarizerComplete(
                `Summarize this assistant reply in at most two short spoken sentences:\n\n${trimmed}`, 120,
              )).trim()} It's all in the chat log.`;
            } catch {
              spoken = `${trimmed.slice(0, 600)}… the rest is in the chat log.`;
            }
          }
          await webHistory.append({ t: Date.now(), user: transcript, reply: trimmed, lane });
          // Name the speaker: the clip plays in the lane's voice, but the text
          // surfaces (Telegram, notice card) carried no attribution — a lane's
          // late reply landing after a transfer read as a non-sequitur.
          const called = lane ? (this.config.brain.lanes?.[lane]?.aliases?.[0] ?? lane) : undefined;
          const who = called ? called.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^The\b/, "the") : undefined;
          const preface = who ? `${who} here — back on what you asked earlier.` : "Back on what you asked earlier.";
          await this.webVoice?.notify(`${preface} ${spoken}`, lane, { urgent: true });
        } catch (error) {
          throw new Error(`parked turn delivery failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      };
      const makePark = () => {
        if (!(ltCfg?.enabled ?? false)) return undefined;
        const lane = this.brain.activeLane?.() ?? undefined; // captured at turn start — delivery speaks as who was asked
        return {
          afterMs: (ltCfg?.park_after_s ?? 20) * 1000,
          maxBackgroundMs: (ltCfg?.max_background_s ?? 600) * 1000,
          line: ltCfg?.line,
          onParked: async (reply: string, transcript: string) => {
            try {
              await deliverParked(reply, transcript, lane);
            } catch (error) {
              log("warn", error instanceof Error ? error.message : String(error));
            }
          },
        };
      };
      // A pinned lane's filler plays in the LANE's voice; until that voice's
      // clips are primed the turn gets silence (never the wrong voice).
      const pickFiller = (t?: string) => {
        const lane = this.brain.activeLane?.();
        if (!lane) return webFiller?.pick(t);
        const voice = this.config.brain.lanes?.[lane]?.voice;
        return voice ? webFiller?.pick(t, voice) : undefined;
      };
      // Input-side tone (opt-in): a CPU speech-emotion sidecar classifies each
      // utterance in parallel with STT; informative verdicts ride into the
      // brain as a short tag (see web-voice/tone.ts). Started fire-and-forget —
      // classify() returns null until the server is healthy, so early turns
      // simply go untagged.
      const toneCfg = this.config.tone;
      let tone: ToneOptions | undefined;
      if (toneCfg.enabled && !this.options.skipServers) {
        const ser = (this.options.serProviderFactory ?? createSerProvider)({
          host: toneCfg.host,
          port: toneCfg.port,
          model: toneCfg.model,
          timeout_ms: toneCfg.timeoutMs,
        });
        this.serProvider = ser;
        log("info", "Starting speech-emotion (tone) sidecar...");
        if (ser.start) {
          this.toneStartupTask = this.runBackground(
            "tone sidecar startup",
            () => ser.start!(),
            { drainOnShutdown: false },
          );
        }
        tone = {
          tag: (wav) => {
            // Short utterances skip SER entirely — the model is confidently
            // wrong below ~1.5s (measured: neutral speech → "angry 1.000" at
            // 0.6s). A "yo" carries no prosody worth reporting anyway.
            const ms = wavDurationMs(wav);
            if (ms < toneCfg.minMs) {
              log("info", `tone: skipped (${Math.round(ms)}ms < min_ms ${toneCfg.minMs})`);
              return Promise.resolve(null);
            }
            return ser.classify(wav).then((r) => {
              const tag = toneTag(r, toneCfg.minScore);
              // Every verdict is logged — tuning min_score/min_ms needs data.
              if (r) log("info", `tone: ${r.label} ${r.score.toFixed(2)} (${Math.round(ms)}ms) → ${tag ? "tagged" : "dropped"}`);
              return tag;
            }).catch(() => null);
          },
          graceMs: toneCfg.graceMs,
        };
      }
      // Speculative turns (opt-in, needs the end-of-turn detector): on a
      // confident "complete" probe the tail is transcribed and the brain
      // started before the final WAV lands — see speculative.ts for the gates.
      const specCfg = wv.speculative;
      // A speculative turn runs on speech the user has not finished. Tokens
      // from a wrong guess are discarded; a tool call is not recallable. So a
      // tool-executing brain stays out of the speculative path unless the
      // operator has accepted that trade explicitly.
      const specToolBrain = brainExecutesTools(this.config.brain);
      const specSideEffectsAllowed = !specToolBrain || specCfg?.allow_tool_brains === true;
      if (specCfg?.enabled && this.config.turn.enabled && !specSideEffectsAllowed) {
        log(
          "warn",
          `speculative turns are configured but disabled: the "${this.config.brain.backend}" brain runs tools, ` +
            "and speculation would start them on an unfinished utterance. " +
            "Set web_voice.speculative.allow_tool_brains: true to accept that.",
        );
      }
      // Speculation starts the brain on the probe TAIL -- before a final
      // transcript exists, so before there is anything to judge. A confident
      // veto therefore lands after the brain has already recorded the exchange
      // and, where tool brains are permitted, possibly acted; aborting the
      // stream cannot reverse either. Stopping ambient speech from doing
      // exactly that is the whole point of the veto, so the veto wins and
      // speculation stands down. Read from CONFIG rather than the constructed
      // judge because the web server is built before the judge is.
      const judgeWillRun = this.config.intentJudge.enabled && this.config.classifierBackend !== null;
      if (judgeWillRun && specCfg?.enabled) {
        log("info", "Speculation off while the intent judge is on: speculation would reach the brain before the veto could decline the turn");
      }
      const speculator = specCfg?.enabled && !judgeWillRun && this.config.turn.enabled && this.brain.sendStream && specSideEffectsAllowed
        ? makeSpeculator({
            stt: this.providers.stt,
            brain: this.brain,
            isLocalFastPath,
            minProbability: specCfg.min_probability ?? 0.85,
            tone,
            operationalContext: (signal) => this.operationalContext(signal),
          })
        : undefined;
      // Speech gate (Silero VAD): fetch-and-verify the pinned assets in the
      // background; the /vad routes 404 (and the page stays energy-only)
      // until they land. `speech_gate: false` skips the download entirely.
      const vadDir = join(homedir(), ".cicero", "web-voice", "vad");
      if (this.config.web_voice?.speech_gate !== false) {
        this.runBackground("speech-gate assets", async (signal) => {
          const r = await ensureVadAssets(vadDir, { signal });
          if (r.ready) log("ok", r.fetched > 0 ? `Speech gate ready (${r.fetched} asset${r.fetched === 1 ? "" : "s"} fetched)` : "Speech gate ready");
          else log("warn", `speech gate degraded to energy-only — ${r.failures.join("; ")} (retries next start)`);
        });
      }
      this.webVoice = (this.options.webVoiceServerStarter ?? startWebVoiceServer)({
        host: webHost,
        port: webPort,
        token,
        tls,
        vadDir,
        readiness: () => this.running
          ? { ready: true }
          : { ready: false, reason: "daemon startup or shutdown in progress" },
        confirmations: this.brain,
        onHealth: async (rows, options) => {
          try {
            options?.signal?.throwIfAborted();
            for (const r of rows) {
              options?.signal?.throwIfAborted();
              await healthStore.append({ t: Date.now(), source: "api", ...r });
            }
            options?.signal?.throwIfAborted();
            return rows.length;
          } catch (error) {
            throw new Error(`health ingest failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        // Turn replies render in the CURRENT SPEAKER's voice: when the lane
        // switchboard has an employee pinned, that lane's TTS voice override
        // applies (resolved per sentence, so the pin ack already sounds like
        // the employee). Notifications stay in Cicero's own voice.
        onTurn: async (wav, options) => {
          const turn = await processWebTurn(wav, {
          // Same veto as the streaming path. Adding the option without wiring
          // it here is what left this entry point open the first time round.
          judge: this.webIntentGate(),
          stt: this.providers.stt,
          brain: this.brain,
          tts: laneTts,
          tldr,
          tone,
          maxAudioBytes: MAX_TURN_AUDIO_BYTES,
          signal: options?.signal,
          trackBackground: options?.trackBackground,
          operationalContext: (signal) => this.operationalContext(signal),
          });
          // Context for the next verdict -- but only what the client could
          // actually hear. A reply of "**" is non-empty text that synthesizes
          // to an empty clip, and recording it would tell the judge Cicero said
          // something the room never heard.
          if (turn.audio.byteLength > 0) this.noteWebSpoken(turn.reply);
          return turn;
        },
        // Semantic end-of-turn probes (see probe.ts): the client asks mid-pause
        // whether the speaker sounds done. this.turnDetector is read lazily —
        // it's created later in startup; probes before then return null and the
        // client's silence hangover governs.
        onTurnProbe: this.config.turn.enabled
          ? async (samples, sampleRate, options) => {
              try {
                if (options?.signal?.aborted) return null;
                const detector = this.turnDetector;
                if (!detector) return null;
                const prediction = await detector.predict(samples, sampleRate);
                if (options?.signal?.aborted) return null;
                const decision = decideEndOfTurn({ prediction, silenceForced: false, threshold: this.config.turn.threshold });
                return { complete: decision.endTurn, probability: prediction.probability };
              } catch (error) {
                log("warn", `web turn probe failed: ${error instanceof Error ? error.message : String(error)}`);
                return null;
              }
            }
          : undefined,
        // Record each completed turn (transcript + spoken reply) so reconnects
        // replay the chat log; the proxy sink taps the stream without altering it.
        // Fillers are pre-rendered in the front desk's voice — suppressed while
        // an employee is pinned (the wrong voice saying "one moment" is worse
        // than a beat of silence).
        onStreamTurn: async (wav, sink, options) => {
          try {
            const deps = { stt: this.providers.stt, brain: this.brain, tts: laneTts, voice: { state: voiceState }, filler: pickFiller, tldr, recover, lastReply, park: makePark(), tone, judge: this.webIntentGate(), signal: options?.signal, trackBackground: options?.trackBackground, operationalContext: (signal?: AbortSignal) => this.operationalContext(signal) };
            if (options?.record === false) {
              await streamWebTurn(wav, deps, sink, options.spec);
              return;
            }
            const recorded = createRecordedWebTurn(sink, webHistory, noteTurn, () => this.brain.activeLane?.());
            await streamWebTurn(wav, deps, recorded.sink, options?.spec);
            await recorded.drain();
          } catch (error) {
            throw new Error(`recorded web voice turn failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        onSpeculate: speculator,
        // Typed input (the text box next to the mic): same pipeline minus STT.
        onTextTurn: async (text, sink, options) => {
          try {
            const deps = { stt: this.providers.stt, brain: this.brain, tts: laneTts, voice: { state: voiceState }, filler: pickFiller, tldr, recover, lastReply, park: makePark(), signal: options?.signal, trackBackground: options?.trackBackground, operationalContext: (signal?: AbortSignal) => this.operationalContext(signal) };
            if (options?.record === false) {
              await streamWebTextTurn(text, deps, sink);
              return;
            }
            const recorded = createRecordedWebTurn(sink, webHistory, noteTurn, () => this.brain.activeLane?.());
            await streamWebTextTurn(text, deps, recorded.sink);
            await recorded.drain();
          } catch (error) {
            throw new Error(`recorded web text turn failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        // Proactive voice-back: /api/notify renders through the same TTS the
        // replies use, so notifications arrive in Cicero's (cloned) voice.
        // If a Telegram bot is configured, the same clip also goes to the
        // phone as a voice note. The browser does not wait, but daemon shutdown
        // retains the delivery through its background-task drain.
        // A notification that went out (spoken or parked — not quiet-hours
        // deferred) becomes one-shot brain context, so "call me" or "what do
        // we do about that?" right after an announcement lands on-topic.
        onNotified: (text) => this.brain.injectContext(notificationTurnContext(text, new Date())),
        onDictate: async () => {
          if (!this.dictation) throw new Error("dictation is not enabled on this daemon");
          await this.dictation.toggle();
          return { state: this.dictation.getState() };
        },
        onNotify: async (text, voice, opts) => {
          try {
            if (opts?.signal?.aborted) return null;
            // Quiet hours: don't ping — queue for the morning briefing. Urgent
            // notifies (a parked reply landing mid-conversation) skip the defer:
            // the user is actively talking, quiet hours don't apply to them.
            const qh = this.config.notify?.quiet_hours;
            if (!opts?.urgent && qh && inQuietHours(new Date(), qh, this.config.notify?.timezone)) {
              await this.getOvernightStore().enqueue(text);
              if (opts?.signal?.aborted) return null;
              return null;
            }
            // skipRender: nobody is connected to hear it, so the clip can be
            // synthesized at flush time (onNotifyRender) instead of now — a
            // notification that only ever gets parked must not cost a GPU
            // synthesis. Only a Telegram voice note still forces the render:
            // the phone needs the clip immediately.
            const tgEarly = this.config.notify?.telegram;
            const mirrors = tgEarly && opts?.telegramMirror !== false;
            if (opts?.skipRender && !(mirrors && tgEarly.voice_note)) {
              // Parity with the eager path's post-render abort check: a turn
              // cancelled mid-dispatch must not mirror or park.
              if (opts?.signal?.aborted) return null;
              if (mirrors) {
                this.runBackground("Telegram notify delivery", async () => {
                  try {
                    await sendTelegramText(tgEarly, text);
                  } catch (error) {
                    log("warn", `Telegram notify delivery failed: ${error instanceof Error ? error.message : String(error)}`);
                  }
                });
              }
              return new ArrayBuffer(0);
            }
            const audio = await this.renderNotifyClip(text, voice);
            if (opts?.signal?.aborted) return null;
            const tg = this.config.notify?.telegram;
            // telegramMirror: false = the caller delivers its own Telegram
            // rendering (the morning briefing texts a digest the TTS path
            // couldn't speak) — mirroring the spoken text would double-send.
            if (tg && opts?.telegramMirror !== false) {
              this.runBackground("Telegram notify delivery", async () => {
                try {
                  await (tg.voice_note ? sendTelegramVoice(tg, text, audio) : sendTelegramText(tg, text));
                } catch (error) {
                  log("warn", `Telegram notify delivery failed: ${error instanceof Error ? error.message : String(error)}`);
                }
              });
            }
            return audio;
          } catch (error) {
            throw new Error(`web notify failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        // The lazy half of onNotify: pure synthesis for a parked notification
        // being flushed to a client. No quiet-hours check (the item was
        // accepted at dispatch), no Telegram mirror (already sent), no
        // onNotified (context was injected when it parked).
        onNotifyRender: async (text, voice, opts) => {
          try {
            opts?.signal?.throwIfAborted();
            const audio = await this.renderNotifyClip(text, voice);
            opts?.signal?.throwIfAborted();
            return audio;
          } catch (error) {
            throw new Error(`parked notify render failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        // Render-only TTS (the Telegram call greeting, external integrations)
        // — must NOT trigger the notify fan-out above.
        onSay: async (text, options) => {
          try {
            options?.signal?.throwIfAborted();
            const audio = await this.providers.tts.generateAudio(speakable(text));
            options?.signal?.throwIfAborted();
            return audio;
          } catch (error) {
            throw new Error(`web say failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        // Warmup and unattended/scheduled prompts deliberately retain their
        // existing context policy: operational snapshots are for operator turns.
        onChat: async (text, options) => {
          try {
            return await runOperatorChatTurn(text, {
              brain: this.brain,
              history: webHistory,
              operationalContext: (signal) => this.operationalContext(signal),
            }, options?.signal);
          } catch (error) {
            throw new Error(`web chat failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        onHistory: (options) => options?.signal?.aborted ? Promise.resolve([]) : webHistory.recent(20),
      });
      assertHeadlessWebVoiceStarted(this.config.headless, this.webVoice !== null, webHost, webPort);
      if (this.webVoice) {
        this.webVoicePairingStartedAt = new Date().toISOString();
        this.publishWebVoicePairingState();
        if (wv.tunnel) {
          this.webVoiceTunnel = await startWebVoiceTunnel({
            config: wv.tunnel,
            localScheme: this.webVoice.scheme,
            localHost: webHost,
            localPort: this.webVoice.port,
            signal: this.lifecycleAbort.signal,
            onOwned: (owner) => { this.webVoiceTunnelOwner = owner; },
          });
          this.assertStartupActive();
          if (this.webVoiceTunnel) this.publishWebVoicePairingState();
        }
        if (tokenIsEphemeral) {
          // This intentionally bypasses log()/dashBus: startup stdout receives
          // the one-run credential, but the browser dashboard must never receive
          // it through its event stream. A supervisor may still capture stdout;
          // service deployments should configure a stable token.
          console.log(
            `Voice client (ephemeral token): ${this.webVoice.scheme}://<this-box-ip>:${this.webVoice.port}/?token=${token}`,
          );
          if (this.webVoiceTunnel) {
            console.log(
              `Voice client via ${this.webVoiceTunnel.provider} (ephemeral token): ${this.webVoiceTunnel.publicUrl}/?token=${token}`,
            );
          }
          console.log("Set web_voice.token in ~/.cicero/config.yaml for a stable credential.");
        } else {
          log("ok", `🎙️  Voice client: ${this.webVoice.scheme}://<this-box-ip>:${this.webVoice.port}/?token=<redacted>`);
          if (this.webVoiceTunnel) {
            log("ok", `🎙️  Voice client via ${this.webVoiceTunnel.provider}: ${this.webVoiceTunnel.publicUrl}/?token=<redacted>`);
          }
        }
        if (this.webVoice.scheme === "http") {
          log("warn", "web-voice is HTTP — the browser mic only works from localhost. Add a TLS cert for LAN access.");
        }
        // Morning briefing: durably claim the local day before looking up or
        // delivering anything. A restart can catch up, but never double-send.
        const briefing = this.config.notify?.briefing;
        if (briefing?.at) {
          const webVoice = this.webVoice;
          const tz = this.config.notify?.timezone;
          const statusStore = this.briefingStatusStore!;
          this.briefingScheduler = new BriefingScheduler({
            at: briefing.at,
            catchUpMinutes: briefing.catch_up_minutes ?? 180,
            timezone: tz,
            quietHours: this.config.notify?.quiet_hours,
            store: statusStore,
            run: async (_trigger, signal, beforeDelivery): Promise<BriefingRunResult> => {
              signal.throwIfAborted();
              const overnightStore = this.getOvernightStore();
              const snapshot = await overnightStore.peek();
              signal.throwIfAborted();

              let board: KanbanTask[] | null = null;
              const boardCommand = this.config.notify?.kanban?.enabled !== false
                ? this.config.notify?.kanban?.command
                : undefined;
              try {
                if (boardCommand) board = await listViaCli(boardCommand, { signal });
              } catch {
                signal.throwIfAborted();
                // Board state is optional in the daily briefing.
              }
              signal.throwIfAborted();

              let health: string | null = null;
              try { health = briefLine(await healthStore.since(Date.now() - 24 * 60 * 60 * 1000)); } catch { /* record optional */ }
              signal.throwIfAborted();
              beforeDelivery();

              const overnight = snapshot.map((item) => item.text);
              const day = dayOf(new Date(), tz);
              const digest = composeBriefingDigest(overnight, board, health, day);
              const tg = this.config.notify?.telegram;
              const channels: NonNullable<BriefingRunResult["channels"]> = {};
              const telegramDelivery = tg
                ? deliverBriefingTelegramChunks(
                    digest,
                    (chunk) => sendTelegramText(tg, chunk, undefined, {}, signal),
                    signal,
                  )
                    .then((outcome) => { channels.telegram = outcome; })
                    .catch(() => { channels.telegram = "failed"; })
                : Promise.resolve();
              const voiceDelivery = briefing.call
                ? webVoice.notify(composeBriefing(overnight, board, health), undefined, {
                    telegramMirror: false,
                    signal,
                  }).then(async (result) => {
                    const accepted = result !== null && (result.delivered > 0 || result.parked);
                    channels.voice = accepted ? "accepted" : "failed";
                    if (result?.parked) {
                      const callbackRequest = JSON.stringify({ reason: "morning briefing", at: Date.now() });
                      await recordParkedBriefingVoiceOutcome(
                        signal,
                        channels,
                        () => writeCallbackSpool(callbackRequest, signal),
                        callbackConsumerAlive,
                      );
                    }
                  }).catch(() => { channels.voice = signal.aborted ? "aborted" : "failed"; })
                : Promise.resolve();

              await Promise.all([telegramDelivery, voiceDelivery]);
              if (signal.aborted && channels.callback === "accepted") {
                channels.voice = "aborted";
                channels.callback = "aborted";
              }
              const outcomes = Object.values(channels);
              const accepted = outcomes.filter((outcome) => outcome === "accepted").length;
              if (accepted > 0) {
                injectDeliveredBriefingContext(
                  (context) => this.brain.injectContext(context),
                  digest,
                  true,
                  new Date(),
                );
                await overnightStore.ack(snapshot.map((item) => item.id));
              }
              if (signal.aborted && accepted === 0) signal.throwIfAborted();

              const phase = accepted === 0 ? "failed" : accepted === outcomes.length ? "delivered" : "partial";
              const result: BriefingRunResult = {
                phase,
                channels,
                deferredCount: snapshot.length,
                contentSummary: `${snapshot.length} deferred; board ${board ? "included" : "unavailable"}; health ${health ? "included" : "empty"}`,
                errorKind: phase === "delivered" ? undefined : accepted === 0 ? "delivery-failed" : "channel-failed",
              };
              log(phase === "delivered" ? "ok" : "warn", `☀️ Morning briefing ${phase} (${snapshot.length} deferred item(s))`);
              return result;
            },
          });
          log("ok", `☀️ Morning briefing scheduled daily at ${briefing.at} (catch-up ${briefing.catch_up_minutes ?? 180}m)${briefing.call ? " (with a call)" : ""}`);
        }
        // Scheduled prompts: daily unattended brain turns (research briefs,
        // digests) texted via Telegram. Unlike the briefing, the CONTENT is a
        // live brain answer, so lanes with web access can do real research.
        const schedules = this.config.notify?.schedules ?? [];
        if (schedules.length > 0) {
          const tg = this.config.notify?.telegram;
          if (!tg) {
            log("warn", "notify.schedules is configured without notify.telegram — scheduled prompt replies have nowhere to go");
          } else {
            const brain = this.brain;
            const lifecycleSignal = this.lifecycleAbort.signal;
            this.promptScheduler = new PromptScheduler({
              schedules,
              timezone: this.config.notify?.timezone,
              quietHours: this.config.notify?.quiet_hours,
              ask: (schedule, signal) => sendUnattended(brain, schedule.prompt, {
                lane: schedule.lane,
                signal: AbortSignal.any([lifecycleSignal, signal]),
              }),
              deliver: async (text) => {
                for (let i = 0; i < text.length; i += 4000) {
                  if (!await sendTelegramText(tg, text.slice(i, i + 4000))) {
                    throw new Error("Telegram send failed");
                  }
                }
              },
            });
            this.promptScheduler.start();
            log("ok", `💡 Scheduled prompts armed: ${schedules.map((s, i) => `${scheduleLabel(s, i)} at ${s.at}${s.lane ? ` (lane ${s.lane})` : ""}`).join(", ")}`);
          }
        }
      }
    }

    // Step 4: Start listener
    logStep(4, totalSteps, "Starting listener...");
    this.listener = createListener(this.config);
    this.listener.onCommand((text) => this.dispatchCommand(text));

    // Semantic end-of-turn detector (optional; default off). Launches its own
    // ONNX model server the way STT does. If it can't start, the listener's
    // health check quietly falls back to plain silence detection. Headless
    // installs need it too — the web-voice client probes it mid-pause.
    if (this.config.turn.enabled && !this.options.skipServers) {
      const t = this.config.turn;
      this.turnDetector = createTurnDetector({
        backend: t.backend,
        host: t.host,
        port: t.port,
        model: t.model,
        threshold: t.threshold,
        timeout_ms: t.timeoutMs,
      });
      log("info", "Starting Smart-Turn end-of-turn detector...");
      await this.turnDetector.start?.();
      this.assertStartupActive();
    }

    // Initialize conversational listener (activated via "voice" command)
    this.conversational = createConversationalListener(this.config, this.providers.stt, audioRecorder, audioPlayer, this.turnDetector ?? undefined, this.aecHub ?? undefined);
    this.conversational.onCommand((text) => this.dispatchCommand(text));
    // "Was that addressed to me?" veto, off unless switched on AND a classifier
    // is configured. It can only ever decline an utterance the listener would
    // have taken, never cause one to be taken -- so a missing or broken judge
    // leaves behavior exactly as it is today.
    // Constructed before the web server bound; hand it to the host listener now
    // that the listener exists.
    if (this.intentJudge) this.conversational.setIntentJudge(this.intentJudge);
    // Lifecycle cleanup belongs to voice-mode deactivation itself, not to the
    // optional clap feature. This runs for dashboard/hotkey/spoken shutdown and
    // recorder failures alike, and does not restart clap during daemon shutdown.
    this.conversational.onDeactivate(() => this.handleVoiceDeactivated());
    if (this.streamingSpeaker) {
      this.conversational.onBargeIn(() => this.handleLocalBargeIn());
      // Full-duplex echo rejection: give the listener a live view of what Cicero
      // is saying so the mic re-capturing our own TTS isn't mistaken for a barge-in.
      this.conversational.setSpeakingTextProvider(() => {
        if (!this.streamingSpeaker) return "";
        const snap = this.streamingSpeaker.getSnapshot();
        return [...snap.spoken, ...snap.pending].join(" ");
      });
      // A bare "stop" interrupts without a follow-up command, so discard the
      // recovery snapshot — otherwise it would wrongly attach to the next turn.
      // A vetoed barge-in produces no replacement turn, so the snapshot taken at
      // the interrupt has nothing to attach to — same reasoning as a bare "stop".
      this.conversational.onBargeInDiscarded(() => {
        this.pendingRecovery = null;
      });
      this.conversational.onStopCommand(() => {
        this.pendingRecovery = null;
        this.activeLocalTurn?.abort("stop command");
      });
    }
    // Headless: skip starting any local-mic capture (clap, conversational, hotkey).
    // The objects exist so other code paths stay null-safe, but nothing opens a mic —
    // on a box with no mic/speakers, talk to it through the web voice client instead.
    if (!this.config.headless) await this.conversational.start();
    this.assertStartupActive();

    // Double-clap activation. Holds the mic only while voice mode is off, so it
    // releases on activate and resumes when voice mode turns back off (any way).
    const clap = this.config.clap;
    // A dictation started during the startup window (the listener is runnable
    // before the servers bind) already owns the microphone. Arming clap on top
    // of it is the same two-recorder overlap the handoff exists to prevent.
    if (clap.enabled && !this.options.skipServers && !this.config.headless && !this.dictationHoldsMicrophone) {
      this.clapListener = new ClapListener({
        onDoubleClap: () => this.onDoubleClap(),
        threshold: clap.threshold,
        minGapMs: clap.minGapMs,
        maxGapMs: clap.maxGapMs,
        // Raw sox (not the AEC hub): while idle the helper is stopped, so the mic
        // is free, and a raw mic gives clean clap transients. Through the hub,
        // Voice Processing's noise suppression crushes claps below the threshold.
      });
      await this.clapListener.start();
      // A dictation press can land while that start is waiting on a recorder
      // reap. Undo the stale commit rather than leaving two mic owners.
      if (this.dictationHoldsMicrophone) await this.clapListener.stop();
    }

    // Start global hotkey listener for voice toggle
    if (!this.config.headless) this.startHotkeyListener();

    // Step 5: Begin listening
    logStep(5, totalSteps, `Registering hotkey (${this.config.hotkey})...`);
    if (!this.config.headless) await this.listener.start();
    this.assertStartupActive();

    // Web voice creation (if any) has been attempted by now — start board polling
    // even when an enabled web voice failed to bind, so non-web surfaces still see
    // the board. No-op on non-web (already polling) and when no board is configured.
    this.startBoardPollingIfPending();

    this.lifecycle = "running";
    this.startedAtMs = Date.now();
    this.running = true;
    this.briefingScheduler?.start();
    log("ok", "");
    if (this.config.headless) {
      console.log(`Cicero ready (headless — web voice only; local mic/speaker/clap/hotkey disabled).`);
      console.log(`Brain: ${brainLabel} | TTS: ${this.config.ttsEnabled ? "on" : "off"}`);
      if (this.webVoice) {
        console.log(`Talk to it: ${this.webVoice.scheme}://<this-box-ip>:${this.webVoice.port}/?token=<token>`);
        if (this.webVoiceTunnel) {
          console.log(`Talk to it via ${this.webVoiceTunnel.provider}: ${this.webVoiceTunnel.publicUrl}/?token=<token>`);
        }
      }
      else log("warn", "web_voice is disabled — nothing can reach Cicero. Set web_voice.enabled: true.");
    } else {
      console.log(`Cicero ready. Listening for commands.`);
      console.log(`Brain: ${brainLabel} | TTS: ${this.config.ttsEnabled ? "on" : "off"}`);
      console.log(`Type "voice" or press ${this.config.hotkey} to toggle conversational mode`);
    }
    if (this.dashboard) {
      dashBus.setConfig({
        brain: brainLabel,
        model: this.config.raw.llm?.model ?? this.config.servers.router.model,
        ttsVoice: this.config.raw.tts?.voice ?? this.config.voice,
        ttsBackend: this.config.raw.tts?.backend ?? "tts",
      });
      console.log(`Dashboard: ${this.dashboard.url} (live voice activity)`);
    }
    console.log("");

    // Watch actions.yaml for hot-reload
    this.watchActions();
  }

  private dispatchCommand(text: string): Promise<void> {
    this.activeLocalTurn?.abort("superseded by a newer local turn");
    const controller = new AbortController();
    this.activeLocalTurn = controller;
    let task!: Promise<void>;
    task = this.handleCommand(text, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          logError("Local command dispatch failed", error instanceof Error ? error : new Error(String(error)));
        }
      })
      .finally(() => {
        if (this.activeLocalTurn === controller) this.activeLocalTurn = null;
        this.localTurnTasks.delete(task);
      });
    this.localTurnTasks.add(task);
    return task;
  }

  /** Generic STT/TTS swap transaction used by the authenticated local control channel. */
  private async swapVoiceProvider(
    request: SwapRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<SwapResult> {
    if (!this.running || this.stopRequested || this.lifecycle !== "running") {
      throw new Error("Cicero is not ready to swap providers");
    }
    if (this.startupVoiceWarmups.get(request.role)?.settled === false) {
      throw new Error(`${request.role.toUpperCase()} startup warmup is still in progress; retry the swap shortly`);
    }
    if (this.voiceSwapRunning) throw new Error("another provider swap is already in progress");
    this.voiceSwapRunning = true;
    try {
      const plan = await planVoiceProviderSwap(this.config, request);
      const selection = plan.selection;
      const candidateConfig = new RuntimeConfig(structuredClone(this.config.raw));
      candidateConfig.setVoiceBackend(request.role, selection);
      if (plan.fallback) candidateConfig.setVoiceFallback(request.role, plan.fallback);

      if (request.role === "stt") {
        const slot = this.sttSlot;
        if (!slot) throw new Error("STT provider slot is unavailable");
        const candidate = (this.options.sttProviderFactory ?? createSTTProvider)(candidateConfig);
        await slot.swap(candidate, () => {
          updateConfigFields(
            {
              stt: selection as STTProviderConfig,
              ...(plan.fallback ? { stt_fallback: plan.fallback as STTProviderConfig } : {}),
            },
            this.options.configPath,
            { replaceTopLevel: plan.fallback ? ["stt", "stt_fallback"] : ["stt"] },
          );
          this.config.setVoiceBackend("stt", selection);
          if (plan.fallback) this.config.setVoiceFallback("stt", plan.fallback);
        }, options);
      } else {
        const slot = this.ttsSlot;
        if (!slot) throw new Error("TTS provider slot is unavailable");
        const candidate = (this.options.ttsProviderFactory ?? createTTSProvider)(candidateConfig);
        // The filler bank primed its clips through the provider that is being
        // retired. Web turns emit those cached bytes directly, so leaving them
        // in place plays the old provider's "let me check" and then the new
        // provider's reply inside one turn. Dropping them AFTER swap() resolves
        // was too late: the cutover publishes the replacement synchronously and
        // swap() then drains the retired generation for up to the cleanup
        // deadline, and every turn admitted in that window (the server runs up
        // to eight concurrently) pinned the new provider and took an old-voice
        // clip. Invalidate at the cutover instead.
        let cutOver = false;
        try {
          await slot.swap(candidate, () => {
            updateConfigFields(
              {
                tts: selection as TTSProviderConfig,
                ...(plan.fallback ? { tts_fallback: plan.fallback as TTSProviderConfig } : {}),
              },
              this.options.configPath,
              { replaceTopLevel: plan.fallback ? ["tts", "tts_fallback"] : ["tts"] },
            );
            this.config.setVoiceBackend("tts", selection);
            if (plan.fallback) this.config.setVoiceFallback("tts", plan.fallback);
          }, {
            ...options,
            onCutover: () => {
              cutOver = true;
              // Not awaited: the cutover must stay synchronous. The clear itself
              // queues behind any in-flight prime, but discardPrepared() closes
              // the bank to pick() before it returns, so no turn admitted in
              // that window can take a retired-provider clip.
              void this.webFillerBank?.discardPrepared().catch((error: unknown) => {
                log("warn", `filler bank invalidation at cutover failed: ${error instanceof Error ? error.message : String(error)}`);
              });
            },
          });
        } finally {
          // A cutover that committed and then failed to confirm the retired
          // generation's cleanup still left the new provider live. Skipping the
          // re-prime there meant stale-voice clips until a restart or another
          // successful swap, so the refill is tied to the cutover, not to
          // swap() resolving.
          if (cutOver) {
            dashBus.setConfig({
              brain: this.config.brain.backend,
              model: this.config.raw.llm?.model ?? this.config.servers.router.model,
              ttsVoice: this.config.raw.tts?.voice ?? this.config.voice,
              ttsBackend: request.backend,
            });
            this.refillFillerBankAfterSwap();
          }
        }
      }
      log("ok", `${request.role.toUpperCase()} swapped live to ${request.backend}${request.model ? ` (${request.model})` : ""}`);
      return { ...request, status: "active" };
    } finally {
      this.voiceSwapRunning = false;
    }
  }

  private async drainLocalTurns(): Promise<void> {
    // A finishing task cannot legitimately create a new local turn during
    // shutdown, but drain to a stable empty set so listener adapters with a
    // queued callback cannot slip a continuation past a stale snapshot.
    if (this.localTurnTasks.size === 0) return;
    const configured = this.options.shutdownDrainTimeoutMs;
    const timeoutMs = typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 1
      ? configured
      : DEFAULT_DAEMON_SHUTDOWN_DRAIN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = (async () => {
      while (this.localTurnTasks.size > 0) {
        await Promise.allSettled([...this.localTurnTasks]);
      }
    })();
    try {
      await Promise.race([
        drain,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`local command turns did not drain within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Bounded ring push. Mirrors the listener's own limits on captured speech. */
  private static pushWebContext(ring: string[], line: string): void {
    const bounded = line.length <= 300 ? line : line.slice(0, 300);
    ring.push(bounded);
    if (ring.length > 6) ring.splice(0, ring.length - 6);
  }

  /** What the browser just heard Cicero say — context for the next verdict. */
  private noteWebSpoken(text: string): void {
    const spoken = text.trim();
    if (!spoken) return;
    CiceroDaemon.pushWebContext(this.webRecentAssistantSpeech, spoken);
  }

  /**
   * The browser's half of the addressed-to-me veto. Undefined when no judge is
   * configured, which leaves every transcript dispatched exactly as before.
   */
  private webIntentGate(): ((transcript: string, signal?: AbortSignal) => Promise<boolean>) | undefined {
    const judge = this.intentJudge;
    if (!judge) return undefined;
    return async (transcript: string, signal?: AbortSignal): Promise<boolean> => {
      const decision = await judge.decide({
        utterance: transcript,
        recentUtterances: this.webRecentUtterances,
        recentAssistantSpeech: this.webRecentAssistantSpeech,
        // No hot window on this path, deliberately. It is defined as "moments
        // after Cicero FINISHED speaking", and the server cannot observe that:
        // the browser keeps playing queued audio long after the turn is marked
        // done, and a replacement turn on the same socket closes the previous
        // one early. Every attempt to track it opened the window at the wrong
        // instant, which SKIPS the classifier -- the one failure this feature
        // cannot afford. So the browser always asks. The judge still gets
        // recentAssistantSpeech, which is what actually lets it recognise "yes"
        // as an answer to Cicero's own question.
        msSinceAssistantSpoke: null,
      }, signal);
      // Room speech is context whether or not it was for us.
      CiceroDaemon.pushWebContext(this.webRecentUtterances, transcript);
      if (decision.accept) return true;
      log("info", `🙉 Web voice: not addressed to me (${decision.confidence.toFixed(2)}), ignoring the turn`);
      return false;
    };
  }

  private handleLocalBargeIn(): void {
    if (!this.streamingSpeaker) return;
    const spoken = this.streamingSpeaker.getSnapshot().spoken;
    this.pendingRecovery = { spoken };
    // The room heard this much of the reply before it was cut. Hand it to the
    // listener so the next verdict is judged against what Cicero was actually
    // mid-way through saying; the live speaking-text provider goes empty the
    // moment the speaker is interrupted below.
    this.conversational?.noteInterrupted(spoken.join(" "));
    this.activeLocalTurn?.abort("barge-in");
    this.streamingSpeaker.interrupt();
  }

  private finalizeStreamingTurn(text: string, result: RouterResult, signal: AbortSignal): boolean {
    if (signal.aborted || !this.streamingSpeaker) return false;
    this.conversational?.noteSpoken(this.streamingSpeaker.getSnapshot().spoken.join(" "));
    this.contextStore.addTurn({
      text,
      intent: result.intent,
      category: result.category,
      params: result.params,
    });
    return true;
  }

  private async handleCommand(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const tStart = Date.now(); // turn clock: "Heard" → first audio out, for snappiness tuning
    log("text", `Heard: "${text}"`);

    // Step 1: Preprocess — strip fillers, expand phonetic aliases
    const cleaned = stripFillers(text);
    const expanded = expandAliasesFn(cleaned, this.config.phoneticAliases);

    if (!expanded.trim()) return; // empty after cleaning

    // If this turn follows a barge-in, tell the brain what it was mid-saying
    // so it can address the interjection and resume. (When Plan 2 Task 4 ships,
    // a bare "stop" is filtered before reaching here, so this only fires for
    // genuine interjections.)
    if (this.pendingRecovery) {
      this.brain.injectContext(
        buildRecoveryContext({ spoken: this.pendingRecovery.spoken, interjection: expanded }),
      );
      this.pendingRecovery = null;
    }

    // Step 1b: Voice-driven computer use. In conversational mode, an explicit
    // action request ("computer, ..." / "use the computer to ...") runs the compute
    // agent with a SPOKEN confirmation gate instead of the brain/router path.
    if (this.conversational?.isActive()) {
      const { isAction, goal } = parseActionRequest(expanded);
      if (isAction) {
        await this.handleVoiceAction(goal, expanded, signal);
        return;
      }
    }

    // Step 2: Classify via LLM-first router (with conversation context)
    const context = this.contextStore.getRecentTurnsForPrompt(5);

    try {
      const result = await this.router.classify(expanded, this.config.actions, context);
      if (signal.aborted) return;
      log("brain", `Intent: ${result.intent} → ${result.category} (route ${Date.now() - tStart}ms)`);

      // Step 3: Handle runtime toggles inline (they modify daemon state)
      if (this.handleRuntimeIntent(result)) {
        this.contextStore.addTurn({
          text: expanded,
          intent: result.intent,
          category: result.category,
          params: result.params,
        });
        return;
      }

      // Step 4: Handle tab-directed commands (need daemon's brain.switchTab)
      if (await this.handleTabIntent(result, expanded, signal)) {
        this.contextStore.addTurn({
          text: expanded,
          intent: result.intent,
          category: result.category,
          params: result.params,
        });
        return;
      }

      // Agent-first: send open-ended conversation to the brain/agent instead of the
      // local model. Runtime toggles (mute/stop) and tab commands were handled above;
      // canned `local`/`cli` utilities (time, battery, calendar) stay instant. Only
      // the open `local-llm` route is redirected, so the agent carries the conversation.
      if (this.config.brain.agent_first && result.category === "local-llm") {
        result.category = "brain";
      }

      // Step 5: For brain queries, enrich with recent context
      if (result.category === "brain" && this.contextStore.size > 0) {
        const recentContext = this.contextStore.getContext();
        this.brain.injectContext(recentContext);
      }

      const systemContext = result.category === "brain" || result.category === "local-llm"
        ? await captureOperationalContext(
            (captureSignal) => this.operationalContext(captureSignal),
            signal,
          )
        : null;
      if (signal.aborted) return;

      // Step 6: Streaming pipeline for local-llm in conversational mode
      if (result.category === "local-llm" && this.conversational?.isActive() && this.streamingSpeaker) {
        log("speak", `Streaming LLM → TTS pipeline... (+${Date.now() - tStart}ms to first token)`);
        const sentences = this.executor.executeLocalLLMStreaming(result, text, {
          signal,
          systemContext: systemContext ?? undefined,
        });
        await this.streamingSpeaker.speakStream(sentences);
        this.finalizeStreamingTurn(expanded, result, signal);
        return;
      }

      // Step 6b: Streaming pipeline for brain queries in conversational mode.
      // Mirror ActionExecutor.executeBrain's prompt selection: slash-command
      // brain actions send action.command, everything else sends originalText.
      if (
        result.category === "brain" &&
        this.conversational?.isActive() &&
        this.streamingSpeaker &&
        (canNarrateAgent(this.brain) || canStreamBrain(this.brain))
      ) {
        const action = this.config.actions[result.intent];
        const prompt = action?.command && action.category === "brain"
          ? action.command
          : text;
        // Prefer progress narration (say what the agent is doing) when the brain
        // supports it and it's enabled; otherwise stream the plain answer.
        const narrate = (this.config.brain.narrate_progress ?? true) && canNarrateAgent(this.brain);
        // Cover the agent's thinking latency with a short varied spoken filler.
        const filler = (this.config.brain.thinking_filler ?? true) ? this.nextFiller() : undefined;
        log("speak", `Streaming ${narrate ? "agent narration" : "brain"} → TTS pipeline... (+${Date.now() - tStart}ms to first token)`);
        if (narrate) {
          await streamAgentNarration(this.brain, this.streamingSpeaker, prompt, filler, {
            signal,
            systemContext: systemContext ?? undefined,
          });
        } else {
          await streamBrainToSpeaker(this.brain, this.streamingSpeaker, prompt, filler, {
            signal,
            systemContext: systemContext ?? undefined,
          });
        }
        this.finalizeStreamingTurn(expanded, result, signal);
        return;
      }

      // Step 7: Play thinking earcon for commands that take time
      if ((result.category === "brain" || result.category === "cli") && this.conversational?.isActive()) {
        this.conversational.playSound("thinking");
      }

      // Step 8: Execute via executor
      const execResult = await this.executor.execute(result, text, {
        signal,
        systemContext: systemContext ?? undefined,
      });
      if (signal.aborted) return;

      // Step 9: Record structured turn
      this.contextStore.addTurn({
        text: expanded,
        intent: result.intent,
        category: result.category,
        params: result.params,
        output: execResult.output?.substring(0, 200),
      });

      // Also record in legacy context store for brain enrichment
      if (execResult.success && execResult.output) {
        this.contextStore.add(text, execResult.output.substring(0, 500));
      }

      // Step 10: Play success earcon
      if (execResult.success && this.conversational?.isActive() && result.category !== "local" && result.category !== "local-llm") {
        this.conversational.playSound("success");
      }

      // Step 11: Speak result if TTS enabled
      if (this.config.ttsEnabled && execResult.output) {
        const action = this.config.actions[result.intent];
        const ttsMode = action?.tts_mode || (result.category === "brain" ? "summary" : "full");
        if (ttsMode !== "silent") {
          const textToSpeak = ttsMode === "summary"
            ? await summarizeForTTS(execResult.output, this.providers.llm, { maxTokens: this.config.ttsSummaryMaxTokens })
            : execResult.output;
          if (textToSpeak) {
            log("speak", `Speaking result (${ttsMode})... (+${Date.now() - tStart}ms)`);
            // In conversational mode, speak canned/full replies through the SAME
            // streaming-speaker path as streamed ones (the AEC hub when present) so
            // they're at a consistent volume and echo-cancelled — instead of the bare
            // afplay path, which played quieter and un-cancelled (the "first reply is
            // quiet, the rest are loud" bug, where the first reply was a canned one).
            if (this.conversational?.isActive() && this.streamingSpeaker) {
              await this.streamingSpeaker.speakStream(asyncOnce(textToSpeak));
            } else {
              await this.speaker.speak(textToSpeak);
            }
            // Streaming and non-streaming both land here; noted once for both.
            // Not when the turn was interrupted, though: barge-in aborts the
            // signal and stops the speaker mid-sentence, so recording it as
            // fully spoken opens a hot window for speech the room never heard
            // the end of -- and the hot window SKIPS the judge.
            if (!signal.aborted) this.conversational?.noteSpoken(textToSpeak);
          }
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      logError("Command failed", err as Error);
      if (this.conversational?.isActive()) {
        this.conversational.playSound("error");
      }
      if (this.config.ttsEnabled) {
        await this.speakAndNote("That command failed. Check the log for details.");
      }
    }
  }

  /** Deliver an agent-initiated reply through the same proactive channel as /api/notify. */
  private async deliverProactiveReply(text: string): Promise<void> {
    try {
      if (this.webVoice) {
        await this.webVoice.notify(text);
        return;
      }

      const qh = this.config.notify?.quiet_hours;
      if (qh && inQuietHours(new Date(), qh, this.config.notify?.timezone)) {
        await this.getOvernightStore().enqueue(text);
        return;
      }
      const tg = this.config.notify?.telegram;
      if (tg) void sendTelegramText(tg, text);
    } catch (err: unknown) {
      log("warn", `approval auto-retry reply notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Run a voice-driven computer-use request: the compute agent takes actions to
   * accomplish `goal`, asking for SPOKEN confirmation before any mutating step,
   * then speaks the result. Reuses the existing TTS Speaker and a one-shot STT
   * turn from the conversational listener.
   */
  private async handleVoiceAction(
    goal: string,
    originalText: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    log("brain", `Computer-use request: "${goal}"`);
    this.conversational?.playSound("thinking");

    try {
      if (!isLocalComputeTarget(this.config.llmBackend) && !this.config.compute.allowCloud) {
        const refusal =
          "Computer use is connected to a cloud model. Enable compute dot allow cloud in the config if you want file and command observations sent there.";
        log("warn", "Computer-use request refused: configured LLM is public/cloud and compute.allow_cloud is false");
        if (this.config.ttsEnabled) await this.speakAndNote(refusal);
        return;
      }
      const result = await runVoiceAction(goal, {
        llm: this.providers.llm,
        speak: async (text) => {
          signal.throwIfAborted();
          await this.speakAndNote(text);
          signal.throwIfAborted();
        },
        listenOnce: async () => {
          signal.throwIfAborted();
          const reply = await this.conversational!.listenOnce();
          signal.throwIfAborted();
          return reply;
        },
        log: (message) => log("brain", message),
        workspaceRoot: this.config.compute.root ?? process.cwd(),
        maxReadBytes: this.config.compute.maxReadBytes,
        signal,
      });
      if (signal.aborted) return;

      this.contextStore.addTurn({
        text: originalText,
        intent: "compute_action",
        category: "compute",
        params: { goal },
        output: result.summary?.substring(0, 200),
      });

      if (this.conversational?.isActive()) {
        this.conversational.playSound(result.ok ? "success" : "error");
      }
      if (this.config.ttsEnabled && result.summary) {
        log("speak", "Speaking action result...");
        await this.speakAndNote(result.summary);
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      logError("Computer-use failed", err instanceof Error ? err : new Error(String(err)));
      if (this.conversational?.isActive()) this.conversational.playSound("error");
      if (this.config.ttsEnabled) {
        await this.speakAndNote("That action failed. Check the log for details.");
      }
    }
  }

  /**
   * Handle runtime intents that modify daemon state.
   * These can't go through the executor because they need access to daemon internals.
   * Returns true if handled.
   */
  /** Next thinking-filler, varied so the same line never plays twice in a row. */
  private nextFiller(): string {
    this.lastFiller = pickThinkingFiller(this.lastFiller);
    return this.lastFiller;
  }

  private handleRuntimeIntent(result: RouterResult): boolean {
    switch (result.intent) {
      case "runtime_mute":
        this.config.ttsEnabled = false;
        log("info", "TTS disabled");
        return true;

      case "runtime_unmute":
        this.config.ttsEnabled = true;
        log("info", "TTS enabled");
        return true;

      case "runtime_restart_brain":
        this.brain.restart()
          .then(() => log("ok", "Brain restarted"))
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logError("Brain restart failed", new Error(msg));
          });
        return true;

      case "runtime_voice_toggle":
        void this.toggleVoiceMode();
        return true;

      default:
        return false;
    }
  }

  /**
   * Handle tab-directed intents that need daemon's brain.switchTab.
   * Returns true if handled.
   */
  private async handleTabIntent(result: RouterResult, text: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return true;
    // Handle tab_switch (from keyword matcher or LLM)
    if (result.intent === "tab_switch" && result.params.tab) {
      if (!this.brain.switchTab) return false;
      const tabName = result.params.tab.replace(/\s*\btab\b\s*$/i, "").trim();
      if (isVagueTabName(tabName)) {
        if (this.config.ttsEnabled) {
          await this.speakAndNote("Which tab? Say the tab name, like 'switch to sales'.");
        }
        return true;
      }
      this.brain.switchTab(tabName);
      if (this.config.ttsEnabled) {
        await this.speakAndNote(`Switched brain to ${tabName} tab.`);
      }
      return true;
    }

    // Handle tab_command (richer LLM-classified tab commands)
    if (result.intent === "tab_command") {
      if (!this.brain.switchTab) return false;
      const tabName = (result.params.tab || "").replace(/\s*\btab\b\s*$/i, "").trim();
      if (!tabName || isVagueTabName(tabName)) {
        if (this.config.ttsEnabled) {
          await this.speakAndNote("Which tab? Say the tab name.");
        }
        return true;
      }

      const command = result.params.command;
      if (command) {
        // "switch to X and do Y" or "in X, do Y"
        this.brain.switchTab(tabName);
        log("info", `Switched to "${tabName}", running: "${command}"`);
        await this.handleCommand(command, signal); // recursive — preserve this turn's cancellation owner
      } else {
        // Simple switch
        this.brain.switchTab(tabName);
        if (this.config.ttsEnabled) {
          await this.speakAndNote(`Switched brain to ${tabName} tab.`);
        }
      }
      return true;
    }

    return false;
  }

  private watchActions(): void {
    const actionsPath = ciceroPath("actions.yaml");
    this.actionsReloader = new ActionConfigReloader(actionsPath, this.config, {
      onReload: (customCount) => log("ok", `Actions reloaded (${customCount} custom actions)`),
      onError: (error) => log("warn", `Failed to reload actions: ${error.message}`),
    });
    try {
      this.actionsReloader.start();
      log("info", `Watching ${actionsPath} for changes`);
    } catch (error: unknown) {
      this.actionsReloader = null;
      log("warn", `Could not watch actions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startHotkeyListener(): void {
    const hotkeyBin = join(dirname(import.meta.dir), "helpers", "cicero-hotkey");
    try {
      const { existsSync } = require("fs");
      if (!existsSync(hotkeyBin)) {
        log("info", "Hotkey helper not found — voice toggle via typing 'voice' only");
        return;
      }

      this.hotkeyProc = Bun.spawn([hotkeyBin], {
        stdout: "pipe",
        stderr: "pipe",
      });

      // Read stdout for HOTKEY events
      const stdout = this.hotkeyProc?.stdout;
      if (!stdout || typeof stdout === "number") return;
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.trim() === "HOTKEY") {
                void this.toggleVoiceMode();
              }
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log("warn", `Hotkey reader exited: ${msg}`);
        }
      };
      readLoop();

      log("info", `Global hotkey listener started (${this.config.hotkey})`);
    } catch (err) {
      log("warn", `Hotkey listener failed: ${(err as Error).message}`);
    }
  }


  /**
   * Handle a voice-mode request from the dashboard button. `toggle` flips state;
   * `activate`/`deactivate` are idempotent so a stale browser tab can't flip the
   * wrong way.
   */
  private handleDashboardControl(action: VoiceControlAction): Promise<void> {
    if (!this.running || !this.conversational) return Promise.resolve();
    return action === "toggle"
      ? this.toggleVoiceMode()
      : this.setVoiceMode(action === "activate");
  }

  private handleVoiceDeactivated(): void {
    this.voiceDesiredActive = false;
    dashBus.setVoiceActive(false);
    this.beginVoiceInputHandoff();
  }

  /**
   * Start an exact mic handoff. AEC stop is invoked synchronously so an in-flight
   * helper activation is cancelled before this method returns; the stored task
   * remains pending until both recorder families confirm release.
   */
  private beginVoiceInputHandoff(): Promise<void> {
    const prior = this.voiceInputHandoff;
    const captureRelease = this.conversational?.releaseAudioCapture() ?? Promise.resolve();
    let aecRelease: Promise<void>;
    try {
      // Do not defer this call through a microtask: AecAudioHub.stop() flips its
      // desired-running epoch synchronously, which cancels a pending start.
      aecRelease = Promise.resolve(this.aecHub?.stop());
    } catch (error: unknown) {
      aecRelease = Promise.reject(error);
    }

    const handoff = Promise.all([prior.catch(() => {}), captureRelease, aecRelease]).then(async () => {
      // Raw clap and the AEC/conversational paths are mutually exclusive. Re-arm
      // only while the daemon still wants the idle voice state — and never while
      // dictation is holding the device for a capture.
      if (!this.running || this.stopRequested || this.voiceDesiredActive || this.dictationHoldsMicrophone) return;
      await this.clapListener?.start();
      // stop(), a new activation, or a dictation press may arrive while clap
      // startup is waiting on a prior recorder reap. Undo that stale commit
      // before the handoff settles.
      if (!this.running || this.stopRequested || this.voiceDesiredActive || this.dictationHoldsMicrophone) {
        await this.clapListener?.stop();
      }
    });
    this.voiceInputHandoff = handoff;
    void handoff.catch((err: unknown) => {
      log("info", `Voice-input handoff cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return handoff;
  }

  /**
   * Hand the local microphone to a dictation capture.
   *
   * Dictation used to spawn its recorder directly, while clap detection held a
   * raw `rec` process (it is on by default whenever voice mode is off). On an
   * exclusive ALSA capture device that is two processes competing for one
   * stream. Ownership now moves through the same handoff barrier voice
   * activation uses, and `dictationHoldsMicrophone` keeps clap from re-arming
   * underneath the capture.
   *
   * Throwing refuses the capture. Voice mode is refused rather than pre-empted:
   * it is the same mutual exclusion clap already has with the conversational
   * path, and pre-empting a live conversation for a hotkey press is worse.
   */
  private async acquireDictationMicrophone(): Promise<void> {
    if (this.voiceDesiredActive || this.conversational?.isActive()) {
      throw new Error("voice mode is holding the microphone — turn it off before dictating");
    }
    this.dictationHoldsMicrophone = true;
    try {
      await this.beginVoiceInputHandoff();
      // The handoff deliberately skips the clap re-arm above; clap may still be
      // armed from before, so stop it explicitly and confirm that release.
      await this.clapListener?.stop();
    } catch (error: unknown) {
      // Fail closed: an unconfirmed release means something may still own the
      // device, so dictation must not add a second recorder on top of it.
      this.dictationHoldsMicrophone = false;
      void this.beginVoiceInputHandoff();
      throw error;
    }
  }

  /** Give it back, so clap re-arms if the daemon is still idle. */
  private async releaseDictationMicrophone(): Promise<void> {
    this.dictationHoldsMicrophone = false;
    await this.beginVoiceInputHandoff();
  }

  /**
   * Hands-free activation: the standalone clap listener (mic owner while voice is
   * off) arms voice mode. Deactivation by clap is separate — it's detected from
   * the conversational recorder's own stream (config `clap.deactivate`), since
   * this listener is stopped while voice mode owns the mic.
   */
  private onDoubleClap(): void {
    if (this.voiceDesiredActive || this.conversational?.isActive()) return; // already on/pending
    log("ok", "👏👏 Double-clap detected — activating voice mode");
    void this.setVoiceMode(true);
  }

  private toggleVoiceMode(): Promise<void> {
    return this.setVoiceMode(!this.voiceDesiredActive);
  }

  /** Serialize transitions and reconcile to the latest requested state. */
  private setVoiceMode(active: boolean): Promise<void> {
    // Once shutdown has synchronously revoked runtime ownership, a late UI/hotkey
    // callback cannot queue a new desired activation.
    if (active && (!this.running || this.stopRequested)) {
      this.voiceDesiredActive = false;
      dashBus.setVoiceActive(false);
      return this.voiceTransition;
    }
    const wasDesiredActive = this.voiceDesiredActive;
    this.voiceDesiredActive = active;
    // A fresh off→on request revalidates/retries the exact prior capture release
    // before AEC or raw recording can claim the mic. Repeated "activate" events
    // while startup is already pending do not cancel that startup.
    if (active && !wasDesiredActive && !this.conversational?.isActive()) {
      this.beginVoiceInputHandoff();
    }
    // A deactivate arriving while AEC is still starting must cancel that bounded
    // startup immediately; otherwise the stale activation could win two seconds
    // later and turn the mic back on.
    if (!active && !this.conversational?.isActive()) {
      this.beginVoiceInputHandoff();
    }
    const transition = this.voiceTransition
      .then(() => this.reconcileVoiceMode())
      .catch((err: unknown) => {
        log("warn", `Voice-mode transition failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.voiceTransition = transition;
    return transition;
  }

  private async reconcileVoiceMode(): Promise<void> {
    const conversational = this.conversational;
    if (!conversational) return;
    if (!this.running || this.stopRequested) {
      dashBus.setVoiceActive(false);
      return;
    }

    if (this.voiceDesiredActive && !conversational.isActive()) {
      if (this.dictationHoldsMicrophone) {
        // Symmetric with the refusal in acquireDictationMicrophone: whoever has
        // the device keeps it until they are done. Starting AEC or raw capture
        // here would put a second recorder on a live dictation.
        this.voiceDesiredActive = false;
        dashBus.setVoiceActive(false);
        log("warn", "Dictation is holding the microphone — voice mode stays off until the capture ends");
        return;
      }
      try {
        await this.voiceInputHandoff;
      } catch (err: unknown) {
        // A failed release is a safety barrier, not permission to overlap the
        // previous audio owner with a new activation.
        this.voiceDesiredActive = false;
        dashBus.setVoiceActive(false);
        log("warn", `Prior voice-input release is unconfirmed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!this.running || this.stopRequested || !this.voiceDesiredActive) return;
      await this.clapListener?.stop();
      if (!this.running || this.stopRequested || !this.voiceDesiredActive) return;
      let microphoneReleased = true;
      if (this.aecHub && !this.aecHub.isRunning()) {
        try {
          await this.aecHub.start();
          if (!this.running || this.stopRequested || !this.voiceDesiredActive) {
            await this.aecHub.stop();
            if (!this.running || this.stopRequested) return;
            return;
          }
        } catch (err: unknown) {
          // Missing/failed AEC is safe to fall back from only after its exact
          // helper has been reaped. A cleanup failure means it may still own the
          // microphone, so starting raw `rec` would create a competing owner.
          try {
            await this.aecHub.stop();
          } catch (cleanupError: unknown) {
            microphoneReleased = false;
            log(
              "warn",
              `AEC helper cleanup could not be confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)} — voice activation remains off`,
            );
          }
          if (!this.running || this.stopRequested) return;
          if (microphoneReleased && this.voiceDesiredActive) {
            log("warn", `AEC hub failed to start: ${err instanceof Error ? err.message : String(err)} — continuing without echo cancellation`);
          }
        }
      }
      if (!this.running || this.stopRequested) return;
      // The desired state may have changed while helper startup was awaiting its
      // first frame. Never commit a stale activation.
      if (this.voiceDesiredActive) {
        if (microphoneReleased) {
          conversational.activate();
          // activate() is synchronous, but keep the ownership invariant explicit
          // at the commit boundary for shutdown/deactivation maintenance.
          if (!this.running || this.stopRequested || !this.voiceDesiredActive) {
            const priorHandoff = this.voiceInputHandoff;
            conversational.deactivate();
            if (this.voiceInputHandoff === priorHandoff) this.handleVoiceDeactivated();
            await this.voiceInputHandoff;
            if (!this.running || this.stopRequested) return;
          }
        } else {
          this.voiceDesiredActive = false;
        }
      } else {
        await this.aecHub?.stop();
        if (!this.running || this.stopRequested) return;
      }
    } else if (!this.voiceDesiredActive && conversational.isActive()) {
      const priorHandoff = this.voiceInputHandoff;
      conversational.deactivate();
      // The real listener invokes its registered callback synchronously. Keep
      // the daemon safe for embedders/test adapters that implement the listener
      // contract but omit that callback behavior.
      if (this.voiceInputHandoff === priorHandoff) this.handleVoiceDeactivated();
      await this.voiceInputHandoff;
      if (!this.running || this.stopRequested) return;
    } else if (!this.voiceDesiredActive) {
      await this.voiceInputHandoff;
      if (!this.running || this.stopRequested) return;
    }

    dashBus.setVoiceActive(conversational.isActive());
  }

  /**
   * Retry release for every provider generation a previous shutdown left
   * unconfirmed. Reaching `idle` with the slots still populated is exactly that
   * case: the teardown below keeps them precisely so a later stop() can retry,
   * but nothing used to do the retrying, so an unreaped child got exactly one
   * stop attempt and was then stranded when startup replaced the fields.
   */
  /**
   * Invalidate filler clips synthesized on a provider that has just been retired,
   * then re-prime on the replacement. The discard is awaited so no turn can pick a
   * stale clip after the swap returns; the re-prime is background work, sequential
   * for the same reason startup's chain is (two cold clone preps landing together
   * make a large transient GPU allocation that can abort the TTS server).
   */
  /**
   * Rebuild the filler bank on the provider that just went live.
   *
   * Deliberately NOT awaited by the swap request. discardPrepared() queues
   * behind any prime still running, and a prime is a whole bank of sequential
   * synthesis — eight clips at a minute each is longer than the control client's
   * entire deadline. Waiting for it inside a swap that has already persisted and
   * cut over made the CLI abort and report a failure for a swap that was live,
   * which is the one outcome this command must never produce. Nothing stale can
   * be served meanwhile: the cutover closed the bank synchronously.
   */
  private refillFillerBankAfterSwap(): void {
    const filler = this.webFillerBank;
    if (!filler) return;
    const laneVoices = [...new Set(
      Object.values(this.config.brain.lanes ?? {})
        .map((l) => l.voice)
        .filter((v): v is string => !!v),
    )];
    this.runBackground("filler re-prime after swap", async (signal) => {
      try {
        await filler.discardPrepared();
      } catch (error) {
        log("warn", `filler bank invalidation after swap failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (signal.aborted) return;
      try {
        const n = await filler.prime();
        log("ok", `filler bank re-primed after swap (${n} clips)`);
      } catch (err: unknown) {
        log("info", `filler re-prime skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const v of laneVoices) {
        if (signal.aborted) return;
        try { await filler.primeVoice(v); }
        catch (err: unknown) { log("info", `lane filler re-prime skipped (${v}): ${err instanceof Error ? err.message : String(err)}`); }
      }
    });
  }

  /**
   * Retry every provider release a previous shutdown could not confirm, and
   * REFUSE to start while any of them is still unconfirmed.
   *
   * Starting anyway was the hazard: the fresh provider is built on the same
   * configured port, and startManagedServer() adopts a server that is already
   * healthy there as unmanaged — so the new generation would run on the old
   * child's process, and the next retry of the old owner would then stop the
   * server the running daemon depends on. There is no ownership transfer that
   * makes that safe, so the daemon does not start a second provider on top of a
   * child it could not prove is gone.
   *
   * Retryable, not latched: whatever is still unconfirmed stays retained, and
   * the next start (or stop) tries again. Recovery is another `cicero start`,
   * not a code change.
   */
  private async retryUnconfirmedProviderRelease(): Promise<void> {
    const unconfirmed: Array<{ role: string; error: unknown }> = [];
    if (this.servers && this.providers && (this.sttSlot || this.ttsSlot)) {
      try {
        await this.servers.stop(this.providers);
        this.sttSlot = null;
        this.ttsSlot = null;
      } catch (error) {
        log("warn", `retained provider teardown is still unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
        unconfirmed.push({ role: "retained voice providers", error });
      }
    }
    // Retry the graveyard too, and put back whatever still will not confirm.
    const pending = this.unreleasedSlots;
    this.unreleasedSlots = [];
    for (const entry of pending) {
      try {
        await entry.stop();
      } catch (error) {
        log("warn", `${entry.role} provider teardown is still unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
        this.unreleasedSlots.push(entry);
        unconfirmed.push({ role: entry.role.toUpperCase(), error });
      }
    }
    if (unconfirmed.length > 0) {
      throw new AggregateError(
        unconfirmed.map((entry) => entry.error),
        `cannot start: a previous ${unconfirmed.map((entry) => entry.role).join(" and ")} release is still unconfirmed, `
        + "so its process may still own the configured port. Stop that process (check the port with `cicero doctor`) "
        + "and start again.",
      );
    }
  }

  /**
   * Speak, and tell the listener what was said.
   *
   * Everything Cicero says is context for "was that addressed to me?" and opens
   * the intent judge's hot window. Call sites that spoke directly through
   * `this.speaker` were invisible to both, so the next utterance could be judged
   * without the speech it was answering.
   */
  private async speakAndNote(text: string): Promise<void> {
    await this.speaker.speak(text);
    this.conversational?.noteSpoken(text);
  }

  async stop(): Promise<void> {
    // Revoke voice ownership before the first await. In particular, AEC stop is
    // invoked synchronously through beginVoiceInputHandoff so a pending helper
    // startup cannot complete later and resurrect conversational capture.
    this.voiceDesiredActive = false;
    dashBus.setVoiceActive(false);
    if (this.lifecycle === "idle") {
      // A prior best-effort shutdown may have reached idle while an exact raw or
      // AEC child remained behind a failed reap. Retry every microphone owner;
      // each async stop revokes its desired epoch synchronously before awaiting.
      const clapRelease = this.clapListener?.stop();
      const conversationalRelease = this.conversational?.stop();
      const aecRelease = this.aecHub?.stop();
      // The dictation listener is retained by the same rule and belongs in the
      // same retry: shutdown logs its failure best-effort and reaches idle, so
      // leaving it out here meant a recorder still holding the microphone, or a
      // helper still typing, was owned by an object nothing would ever call
      // again. Cleared only once its release is confirmed.
      const dictationRelease = this.dictation
        ? this.dictation.stop().then(() => { this.dictation = null; })
        : Promise.resolve();
      await Promise.all([
        clapRelease ?? Promise.resolve(),
        conversationalRelease ?? Promise.resolve(),
        aecRelease ?? Promise.resolve(),
        dictationRelease,
      ]);
      // Providers are owners too: an idle daemon holding retained slots still has
      // a live child behind a failed release.
      await this.retryUnconfirmedProviderRelease();
      return;
    }
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.running = false;
    // Admission must be revoked in the same stack as stop(). Both handles make
    // their accepting=false transition before returning the drain promise. If
    // this were deferred through stopInternal(), one last HTTP/WebSocket turn
    // could enter while shutdown was waiting for a cancelled startup or voice
    // input handoff.
    const ingressStop = this.stopExternalIngress();
    this.removeWebVoicePairingState();
    // stopAfterStartup may first await a cancelled startup. Observe an early
    // drain rejection now; the exact promise is still awaited and reported
    // below, so this only prevents an unhandled-rejection window.
    void ingressStop.catch(() => {});
    let clapRelease: Promise<void>;
    try {
      // ClapListener.stop() revokes its desired-running epoch before its first
      // await, so an older start waiting on recorder cleanup cannot spawn after
      // shutdown has begun.
      clapRelease = Promise.resolve(this.clapListener?.stop());
    } catch (error: unknown) {
      clapRelease = Promise.reject(error);
    }
    this.conversational?.deactivate();
    const audioHandoff = this.beginVoiceInputHandoff();
    const shutdownHandoff = Promise.all([audioHandoff, clapRelease]).then(() => {});
    this.voiceInputHandoff = shutdownHandoff;
    void shutdownHandoff.catch((error: unknown) => {
      log("info", `Shutdown voice-input cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.lifecycleAbort.abort();
    this.activeLocalTurn?.abort("daemon stopping");
    this.activeLocalTurn = null;
    this.lifecycle = "stopping";
    const stopping = this.stopAfterStartup(this.startPromise, ingressStop);
    this.stopPromise = stopping;
    void stopping.catch(() => {
      // Ownership failures are fail-closed but retryable: admission is already
      // revoked, while a later stop() can finish the exact ingress/local/audio
      // drain before final provider teardown.
      if (this.stopPromise === stopping) this.stopPromise = null;
    });
    return stopping;
  }

  /** Invoke both ingress stops now, while preserving every sync/async failure. */
  private stopExternalIngress(): Promise<void> {
    const invoke = (handle: { stop: () => Promise<void> } | null): Promise<void> => {
      if (!handle) return Promise.resolve();
      try {
        return Promise.resolve(handle.stop());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return Promise.allSettled([
      invoke(this.runtimeControl),
      invoke(this.dashboard),
      invoke(this.webVoiceTunnelOwner),
      invoke(this.webVoice),
    ]).then((outcomes) => {
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "external ingress did not drain; dependency shutdown is blocked",
        );
      }
    });
  }

  private async stopAfterStartup(
    starting: Promise<void> | null,
    ingressStop: Promise<void>,
  ): Promise<void> {
    try {
      // Never clean underneath assignments still being made by startComponents.
      // A cancelled startup may reject; cleanup still owns everything it created.
      if (starting) await starting.catch(() => {});
      await this.stopInternal(ingressStop);
    } catch (error) {
      throw new Error(`Cicero shutdown failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private async stopInternal(initialIngressStop?: Promise<void>): Promise<void> {
    log("info", "Shutting down...");
    const cleanup = async (label: string, action: () => void | Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        log("info", `${label} cleanup failed (best effort): ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    let shutdownCompleted = false;
    let providerReleaseUnconfirmed = false;
    let providerReleaseFailure: unknown = null;
    try {
      // Quiesce every scheduler/timer synchronously, then drain the briefing's
      // exact owned run before dependencies are released.
      // Unregister before anything else so a brain that keeps running past this
      // point (a drain, a rollback) cannot start a fresh compaction against an
      // endpoint we are done with. In-flight ones are drained below.
      this.releaseCompactor?.();
      this.releaseCompactor = null;
      const briefingStop = this.briefingScheduler?.stop();
      this.promptScheduler?.stop();
      this.promptScheduler = null;
      if (this.minutesTimer) clearTimeout(this.minutesTimer);
      this.minutesTimer = undefined;
      await cleanup("briefing scheduler", () => briefingStop);
      this.briefingScheduler = null;

      // Stop accepting external work before tearing down any dependency an
      // HTTP/WebSocket/dashboard handler may still be using. Both stop methods
      // quiesce admission synchronously (in stop()'s own stack), then resolve
      // only after their owned jobs drain. The DRAIN is best-effort here: a
      // slow/hung swap (or any ingress that will not drain) must not abort the
      // shutdown before provider teardown and PID release — admission is already
      // revoked, each ingress releases its own socket on timeout, and the
      // provider slots below are the authoritative bounded resource release.
      this.removeWebVoicePairingState();
      await cleanup("external ingress", () => initialIngressStop ?? this.stopExternalIngress());
      await cleanup("startup background tasks", () => this.drainBackgroundTasks());
      await cleanup("actions reloader", () => this.actionsReloader?.stop());
      this.actionsReloader = null;
      await cleanup("Telegram poller", () => this.stopTelegramPoller?.());
      this.stopTelegramPoller = null;
      // Keep the listener when its teardown is unconfirmed: it is the only owner
      // of a recorder still holding the microphone, or of a typing helper still
      // typing, and clearing the reference here stranded both. A later stop()
      // retries the reap.
      let dictationFailure: unknown;
      await cleanup("dictation", async () => {
        try {
          await this.dictation?.stop();
        } catch (error: unknown) {
          dictationFailure = error;
          throw error;
        }
      });
      if (!dictationFailure) this.dictation = null;
      await cleanup("hotkey helper", () => this.hotkeyProc?.kill());
      this.hotkeyProc = null;
      await cleanup("voice lifecycle", async () => {
        let firstError: unknown;
        // A callback already queued at shutdown may replace either task while an
        // older snapshot settles. Drain until both stored identities are stable.
        while (true) {
          const transition = this.voiceTransition;
          const handoff = this.voiceInputHandoff;
          const outcomes = await Promise.allSettled([transition, handoff]);
          for (const outcome of outcomes) {
            if (outcome.status === "rejected" && firstError === undefined) firstError = outcome.reason;
          }
          if (transition === this.voiceTransition && handoff === this.voiceInputHandoff) break;
        }
        if (firstError !== undefined) throw firstError;
      });
      await cleanup("clap listener", () => this.clapListener?.stop());
      await cleanup("conversational listener", async () => { await this.conversational?.stop(); });
      await cleanup("AEC hub", () => this.aecHub?.stop());
      await cleanup("turn detector", async () => { await this.turnDetector?.stop?.(); });
      const toneProvider = this.serProvider;
      const toneStartupTask = this.toneStartupTask;
      if (toneProvider && toneStartupTask && !toneStartupTask.settled) {
        // start() has no AbortSignal contract. Do not make shutdown wait for a
        // model load, but stop the exact old provider if that load finishes
        // after this daemon run has already ended or restarted.
        void toneStartupTask.task
          .then(() => {
            // An embedder may deliberately reuse one provider object across
            // restarts. In that case the completed start belongs to the new
            // live run too and must not be torn down by the old run's cleanup.
            if (this.serProvider === toneProvider && this.lifecycle !== "idle") return;
            return toneProvider.stop?.();
          })
          .catch((error: unknown) => {
            log("info", `tone detector late cleanup failed (best effort): ${error instanceof Error ? error.message : String(error)}`);
          });
      } else {
        await cleanup("tone detector", async () => { await toneProvider?.stop?.(); });
      }
      await cleanup("listener", async () => { await this.listener?.stop(); });
      const turnDependencyFailures: unknown[] = [];
      const releaseTurnDependency = async (action: () => void | Promise<void>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          turnDependencyFailures.push(error);
        }
      };
      // Conversational replies use a distinct StreamingTTSSpeaker, including a
      // directly owned platform player for barge-in. Stopping only `speaker`
      // left that player and its TTS/fallback providers alive past daemon stop.
      await releaseTurnDependency(async () => { await this.streamingSpeaker?.stop(); });
      await releaseTurnDependency(async () => { await this.speaker?.stop(); });
      // Brain.stop() is the cancellation barrier for a command awaiting an
      // agent response. Keep every provider/model server alive until all local
      // dispatch promises (including superseded turns) have actually reaped.
      await releaseTurnDependency(async () => { await this.brain?.stop(); });
      // Unlike best-effort component cleanup, an unfinished command can still
      // call the providers below. Timeout is therefore fail-closed: retain the
      // daemon in `stopping` and let a later stop() retry the exact task set.
      try {
        await this.drainLocalTurns();
      } catch (error) {
        turnDependencyFailures.push(error);
      }
      if (turnDependencyFailures.length > 0) {
        const detail = turnDependencyFailures
          .map((error) => error instanceof Error ? error.message : String(error))
          .join("; ");
        throw new AggregateError(
          turnDependencyFailures,
          `voice turn dependencies did not stop; provider teardown is blocked: ${detail}`,
        );
      }
      await cleanup("kanban watcher", () => this.kanbanWatcher?.stop());
      this.kanbanWatcher = null;
      if (this.servers && this.providers) {
        try {
          await this.servers.stop(this.providers);
        } catch (error) {
          // Release was not confirmed. The slots keep the unreaped generations so
          // a later stop() can retry them, so do NOT clear the slot references
          // below — dropping them here would strand the child for good.
          providerReleaseUnconfirmed = true;
          providerReleaseFailure = error;
          log("warn", `provider teardown was not confirmed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const pidLease = this.pidLease;
      this.pidLease = null;
      await cleanup("PID file", () => pidLease?.release() ?? Promise.resolve());
      // Everything else is torn down, but a dictation listener whose release was
      // unconfirmed still owns a live recorder holding the microphone, or a
      // helper still typing. Logging that best-effort and reporting a clean stop
      // was the lie: the signal path calls stop() exactly once, so nothing ever
      // reached the retry the retained listener exists for. Fail closed here
      // instead — the daemon stays in `stopping` with the listener retained, and
      // a later stop() runs the reap again.
      if (dictationFailure) {
        throw new Error(
          `dictation teardown is unconfirmed, so shutdown is not complete: ${
            dictationFailure instanceof Error ? dictationFailure.message : String(dictationFailure)
          }`,
          { cause: dictationFailure },
        );
      }
      // Round 9 (Codex): an unconfirmed provider release was logged and shutdown
      // reported success. The slots are kept so a later stop() can retry the
      // unreaped generation — but the signal path calls stop() exactly once and
      // exits when it resolves, so that retry was never reached in production and
      // the child outlived the only process holding its handle.
      //
      // So: do not claim a clean stop — but DO finish the bookkeeping below.
      // Reaching `idle` with the slots retained is exactly what lets the next
      // start() retry those handles and refuse by name while the child is still
      // alive; staying in `stopping` instead would replace that with a generic
      // "cannot start while stopping" and strand recovery. The failure is thrown
      // after the state settles.
      if (!providerReleaseFailure) log("ok", "Cicero stopped.");
      shutdownCompleted = true;
    } finally {
      if (shutdownCompleted) {
        // Process-wide state: a daemon that stopped must not leave its
        // credentials registered for whatever runs next in this process.
        clearKnownSecrets();
        this.briefingScheduler = null;
        this.briefingStatusStore = null;
        this.promptScheduler = null;
        this.healthStore = null;
        this.startedAtMs = null;
        this.minutesTimer = undefined;
        this.actionsReloader = null;
        this.backgroundTasks.clear();
        this.localTurnTasks.clear();
        this.toneStartupTask = null;
        this.startupPolicies = {};
        this.serProvider = null;
        this.dashboard = null;
        this.webFillerBank = undefined;
        this.runtimeControl = null;
        // Keep the slots when a provider would not confirm release: they hold the
        // retry state for the unreaped generation. Clearing them would drop the
        // only remaining reference and require a machine-level kill to recover.
        if (!providerReleaseUnconfirmed) {
          this.sttSlot = null;
          this.ttsSlot = null;
        }
        this.voiceSwapRunning = false;
        this.webVoiceTunnelOwner = null;
        this.webVoiceTunnel = null;
        this.webVoice = null;
        this.webVoicePairingStartedAt = null;
        this.voiceDesiredActive = false;
        this.voiceTransition = Promise.resolve();
        this.voiceInputHandoff = Promise.resolve();
        this.lifecycle = "idle";
        this.stopPromise = null;
      }
    }
    // State has settled (see above): report the unconfirmed release now, so the
    // caller exits non-zero instead of believing the daemon shut down cleanly.
    if (providerReleaseFailure) {
      throw new Error(
        `provider teardown is unconfirmed, so shutdown is not complete: ${
          providerReleaseFailure instanceof Error ? providerReleaseFailure.message : String(providerReleaseFailure)
        }`,
        { cause: providerReleaseFailure },
      );
    }
  }
}
