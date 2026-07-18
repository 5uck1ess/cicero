// Core types for Cicero voice assistant

export interface CiceroConfig {
  /** Lexical fast-paths answered instantly without a brain turn (see src/brain/quick-intents.ts). */
  quick_intents?: Array<{ phrases?: string[]; pattern?: string; reply: string }>;
  /** Per-bucket thinking-filler overrides (task/lookup/question/default) — reword the acknowledgments without code. */
  filler_lines?: Partial<Record<"connect" | "task" | "lookup" | "question" | "default", string[]>>;
  tts_enabled: boolean;
  tts_summary_max_tokens?: number; // max tokens for brain response TLDR (default 100)
  tts_local_max_tokens?: number;   // max tokens for local-llm responses (default 150)
  wake_word_enabled: boolean;
  hotkey: string;
  wispr_hotkey: string; // hotkey to activate Wispr Flow (e.g. "option+space")
  terminal: "auto" | "kitty" | "wezterm" | "tmux" | "none";
  voice: string;
  voice_ref_audio?: string; // path to reference audio for voice cloning
  voice_ref_text?: string;  // transcript of the reference audio
  barge_in_enabled?: boolean; // enable barge-in (interrupt TTS by speaking)
  full_duplex?: boolean; // continuous, interruptible conversation: mic stays open through TTS, yields to genuine (echo-rejected) speech (default false)
  aec?: boolean; // macOS hardware echo cancellation: route mic+TTS through the cicero-aec-mic helper so the mic doesn't hear Cicero's own voice (default false; needs `bun run build:aec`)
  silence_duration?: string;  // seconds of silence before end-of-speech (default "1.0")
  silence_threshold?: string; // sox volume threshold for silence (default "3%")
  phonetic_aliases?: Record<string, string[]>; // STT mishearing corrections: canonical → [mishearings]
  brain: BrainConfig;
  servers: ServersConfig;
  actions: Record<string, ActionConfig>;
  deployment?: string;
  stt?: STTBackendConfig;
  stt_fallback?: STTBackendConfig; // hot-standby recognizer used when the primary reports an operational failure
  tts?: TTSBackendConfig;
  tts_fallback?: TTSBackendConfig; // hot-standby engine used when the primary fails a generation
  llm?: LLMBackendConfig;
  compute?: {
    /** Permit computer-use goals, file observations, and command output to reach a public/cloud LLM. */
    allow_cloud?: boolean;
    /** Filesystem boundary for list/read/write tools (default: daemon working directory). */
    root?: string;
    /** Maximum file bytes returned to the model (default 262144). */
    max_read_bytes?: number;
  };
  sidecar?: SidecarConfig;
  dashboard?: { enabled?: boolean; port?: number }; // localhost voice activity dashboard (default on, :8086)
  web_voice?: WebVoiceConfig; // browser audio client (mic+speaker in the browser) for headless boxes (default off)
  notify?: {
    telegram?: {
      token?: string;
      token_env?: string;
      chat_id?: string | number;
      sender_user_id?: string | number; // inbound controller; required for groups, safely inferred for private chats
      voice_note?: boolean;
    }; // phone notifications: text by default, voice notes opt-in
    timezone?: string; // IANA name (America/New_York) — quiet_hours and briefing.at are read in THIS zone; default is the box clock
    quiet_hours?: { from: string; to: string }; // HH:MM in notify.timezone — notifications defer instead of pinging
    briefing?: { at: string; call?: boolean; catch_up_minutes?: number };  // daily digest of deferred news + board state; call: also ring and speak it; catch-up defaults to 180 minutes
    schedules?: Array<{ name?: string; at: string; prompt: string; lane?: string }>; // daily unattended brain turns (research briefs, digests) texted via notify.telegram; lane targets a named brain lane, otherwise the front desk answers; quiet hours hold delivery, not the work
    call_minutes?: boolean | { min_minutes?: number }; // notes texted after a voice session goes quiet; only for calls longer than min_minutes (default 3)
    kanban?: { enabled?: boolean; interval_seconds?: number; command?: string[]; task_command?: string[]; call_back?: boolean; nudge_after_minutes?: number }; // announce task completions; call_back rings the phone when nobody's listening (never for blocked tasks); nudge_after_minutes (default 60, 0 = off) reminds about tasks nobody picked up
  }; // extra proactive-notify channels beyond connected browsers
  headless?: boolean; // no local mic/speakers: skip clap/conversational/hotkey/AEC, talk only via web_voice (default false)
  turn?: TurnDetectionConfig; // semantic end-of-turn detection (default off)
  tone?: ToneDetectionConfig; // input-side speech-emotion tag (default off)
  clap?: ClapConfig; // double-clap to activate voice mode (default on)
  vad?: VadConfig; // streaming voice-activity end-of-turn (default on)
  earcons?: boolean; // play activate/ready/thinking/success/error beeps (default true)
}

/** Browser audio client: capture mic + play TTS in the browser, talk to a headless box. */
export interface WebVoiceConfig {
  enabled?: boolean;     // default false
  host?: string;         // bind address (default "0.0.0.0" — reachable from a LAN browser)
  port?: number;         // default 8090
  token?: string;        // shared secret; if omitted, a random one is printed to startup stdout (which a supervisor may retain)
  // HTTPS (required for the browser mic from a remote origin). If omitted, a self-signed
  // cert is generated under ~/.cicero/web-voice/ via openssl. An exposed listener fails
  // closed if generation fails; tls.enabled:false is the explicit plaintext opt-in.
  tls?: { cert_file?: string; key_file?: string; enabled?: boolean };
  // Optional daemon-owned public reachability process. `auto` prefers
  // tailscale, then cloudflared; absence of the block leaves tunneling off.
  tunnel?: WebVoiceTunnelConfig;
  // After a daemon restart, prime the fresh agent session with a recap of the
  // last N conversation turns (rides the warmup ping). 0 disables. Default 10.
  resume_turns?: number;
  // Speech gate: a small local VAD model (Silero v5 over onnxruntime wasm,
  // ~13MB downloaded on first start, served same-origin) that confirms an
  // energy-gate trigger is actually SPEECH before a hands-free utterance
  // opens or a barge-in fires — keyboard clacks and thuds stop interrupting.
  // On by default; assets missing/unfetchable degrades to energy-only.
  speech_gate?: boolean;
  // TLDR speech gate: long replies aren't read aloud in full — the first
  // `spoken_sentences` stream verbatim, the rest lands in the chat pane only,
  // and one spoken summary line closes the turn ("say 'details' for more").
  // On by default; `enabled: false` restores read-everything.
  tldr?: {
    enabled?: boolean;
    spoken_sentences?: number; // default 4
    // Optional OpenAI-compatible endpoint for the one-line remainder summary
    // (e.g. a local llama.cpp/llama-swap). Without it a generic "plus N more
    // sentences" coda is spoken instead.
    summarizer_url?: string;   // e.g. http://127.0.0.1:8080/v1
    summarizer_model?: string;
  };
  // Speculative turns (needs turn.enabled): on a confident mid-pause "complete"
  // verdict the server transcribes the probe tail and starts the brain BEFORE
  // the final utterance WAV arrives, then adopts the in-flight turn when the
  // WAV's duration confirms nothing new was said — typically shaving the whole
  // final transcription (~300-600ms) off time-to-first-audio. Off by default.
  speculative?: {
    enabled?: boolean;         // default false
    min_probability?: number;  // end-of-turn confidence required to speculate (default 0.85)
  };
  // Long-turn parking: when a reply's FIRST sentence hasn't arrived within
  // park_after_s (deep tool loop, slow delegate), the turn speaks a short
  // hand-back line and releases the audio floor; the brain finishes detached
  // (and may retain its stateful session lock) while the reply arrives through
  // the notify path in the lane's voice. A turn
  // that already said anything aloud never parks.
  long_turn?: {
    enabled?: boolean;         // default false
    park_after_s?: number;     // default 20
    max_background_s?: number; // give up on the detached brain after this (default 600)
    line?: string;             // override the spoken hand-back
  };
}

export interface WebVoiceTunnelConfig {
  provider: "auto" | "tailscale" | "cloudflared";
}

// Streaming voice-activity detection for end-of-turn. Replaces the legacy sox
// absolute-volume silence gate: the recorder calibrates the room's noise floor,
// opens on speech relative to it (robust in any room), and ends the turn a short
// hangover after the speaker stops — the "slight pause" real voice assistants use.
export interface VadConfig {
  enabled?: boolean;        // master switch (default true)
  hangover_ms?: number;     // silence after speech that ends the turn (default 500)
  open_factor?: number;     // open threshold = noise floor × this (default 3)
  min_speech_ms?: number;   // ignore voiced blips shorter than this (default 120)
  calibration_ms?: number;  // initial noise-floor calibration window; floor carries across turns (default 300)
  preroll_ms?: number;      // audio kept before the detected onset (default 240)
}

// Double-clap activation. While voice mode is off, Cicero streams the mic and
// watches for two quick claps (an energy transient, no model needed) to arm
// conversational mode hands-free. It releases the mic the moment voice mode
// turns on, so it never contends with the conversational recorder.
export interface ClapConfig {
  enabled?: boolean;    // master switch (default true)
  threshold?: number;   // peak amplitude 0..1 that counts as a clap (default 0.5)
  min_gap_ms?: number;  // ignore a 2nd clap faster than this (default 80)
  max_gap_ms?: number;  // 2nd clap must land within this of the 1st (default 600)
  deactivate?: boolean; // also double-clap to turn voice mode OFF — detected from
                        // the conversational recorder's own stream, so no second
                        // mic. Needs vad.enabled. Default false (opt-in). A false
                        // trigger only turns voice off, which is recoverable.
}

// Semantic end-of-turn detection (Smart-Turn). When enabled and the model
// server is healthy, a brief silence is treated as a *candidate* turn end and
// the model decides whether the speaker is actually done; if not, recording
// resumes for a bounded grace window so mid-thought pauses aren't cut off.
export interface TurnDetectionConfig {
  enabled?: boolean;            // master switch (default false)
  backend?: "smart-turn";       // the only implemented detector backend
  host?: string;               // remote model server (default localhost)
  port?: number;               // model server port (default 8087)
  model?: string;              // HF repo id of the ONNX checkpoint
  threshold?: number;          // P(complete) at/above which the turn ends (default 0.6)
  grace_attempts?: number;     // max re-record rounds when the model says "not done" (default 2)
  grace_max_duration?: number; // seconds to wait for the user to resume in a grace round (default 3)
  timeout_ms?: number;         // absolute model-request deadline (default 10000)
}

// Input-side tone (speech-emotion recognition). A small CPU sidecar
// (emotion2vec+ base via FunASR, ~90M params — see servers/ser_server.py)
// classifies each utterance's emotional tone from the waveform, in parallel
// with STT. When the verdict is informative (confident and not neutral), a
// short self-explanatory tag rides into the brain with the transcript — so a
// lane hears frustration or excitement, not just the words.
export interface ToneDetectionConfig {
  enabled?: boolean;   // master switch (default false)
  host?: string;       // remote SER server (default localhost — the daemon launches it)
  port?: number;       // SER server port (default 8091)
  model?: string;      // HF repo id (default "emotion2vec/emotion2vec_plus_base")
  min_score?: number;  // ignore verdicts below this confidence (default 0.5)
  grace_ms?: number;   // max wait for the tag once the transcript is ready (default 150)
  min_ms?: number;     // skip utterances shorter than this (default 1500) — SER is confidently WRONG on sub-second clips ("yo" → angry 1.0)
  timeout_ms?: number; // absolute model-request deadline (default 5000)
}

export type SidecarConfig =
  | { backend: "claude-code-hook"; port: number }
  | {
      backend: "terminal-scrape";
      targetTab: string;
      pollIntervalMs: number;
      quietWindowMs: number;
      promptMarker?: string; // regex source, compiled at runtime
    };

export interface BackendConfig {
  backend?: string;
  host?: string; // for network backends (e.g. wyoming)
  port?: number;
  model?: string;
  timeout_ms?: number; // absolute HTTP inference deadline; defaults vary by provider kind
}

export interface STTBackendConfig extends BackendConfig {
  compute_type?: string; // engine quantization knob (faster-whisper/CTranslate2: float16 | int8_float16 | int8)
}

export interface TTSBackendConfig extends BackendConfig {
  device?: string; // local TTS accelerator selection (cuda | cpu | mps | auto)
  voice?: string;
  refAudio?: string;
  refText?: string;
  apiKey?: string; // inline key for a supported cloud TTS backend (currently ElevenLabs)
  responseTimeoutMs?: number;
  maxAudioBytes?: number;
}

export interface LLMBackendConfig extends BackendConfig {
  baseUrl?: string; // full OpenAI-compatible API base URL
  apiKey?: string; // inline provider key; prefer apiKeyEnv in persisted configuration
  apiKeyEnv?: string; // environment variable containing the provider key
  extraHeaders?: Record<string, string>; // provider-specific static HTTP headers
  /** Extra fields merged into local LLM request bodies; unknown sibling keys are rejected. */
  extra?: Record<string, unknown>;
}

// --- Voice cloning library ---
// Providers with a complete add → use → TTS runtime contract. Future providers
// belong here only after provisioning, activation, construction, and rendering
// are all implemented and covered by the shared conformance suite.
export type VoiceProvider = "audiocpp" | "pocket-tts" | "vibevoice" | "elevenlabs";

export interface VoiceManifest {
  name: string; // user-chosen, kebab-case
  provider: VoiceProvider;
  source_clip: string; // absolute path to original WAV/MP3 sample
  trimmed_clip?: string; // provider-safe derived WAV used for inference/upload
  voice_id?: string; // cloud provider voice ID (ElevenLabs)
  sample_rate?: number; // source clip sample rate
  duration_s?: number;
  ref_text?: string; // optional reference transcript metadata (backend support varies)
  created_at: string; // ISO 8601
}

export interface BrainConfig {
  // CLI agents run tools/edit files; "ollama" and "openai-compatible" (plus any
  // OpenAI preset like "openrouter") answer with a model only. `(string & {})`
  // keeps literal autocomplete while allowing preset names.
  backend: "claude-code" | "codex" | "gemini" | "qwen" | "ollama" | "openai-compatible" | "acp" | (string & {});
  mode: "subprocess" | "tab-inject"; // subprocess = claude --print, tab-inject = inject into existing tab
  target_tab?: string; // tab title to inject into (for tab-inject mode)
  auto_approve_tools?: boolean; // tab-inject: true bypasses checks; false uses Claude's auto permission mode
  confirm_tools?: string[]; // spoken confirmation gate: deny matching tool calls until the user says yes (acp backend)
  confirm_retry?: boolean; // after an approved confirmation, auto-send a retry turn through the grant window (default true)
  max_queue_bytes?: number; // acp: maximum unread streamed UTF-8 text retained in memory (default 256 KiB)
  max_response_bytes?: number; // acp: maximum UTF-8 text accumulated by send(); streaming stays incremental (default 2 MiB)
  max_pending_turns?: number; // acp: maximum active + queued turns admitted to one session (default 32)
  // Think lane (acp backend): a second, heavier ACP agent that handles turns
  // containing a trigger phrase ("think hard about…"). Separate conversation —
  // suits one-shot deep questions.
  escalate?: { binary?: string; binary_args?: string[]; triggers?: string[]; unset_env?: string[] };
  // Lane switchboard (acp backend): named employees you can be transferred to.
  // "Let me talk to the coder" pins the conversation to that lane until
  // "back to Cicero". Each lane is its own agent + conversation; `voice`
  // overrides the TTS voice while pinned so employees sound different.
  lanes?: Record<string, {
    backend?: "acp" | "codex";  // how the lane binary is driven (default acp)
    binary?: string;
    binary_args?: string[];
    aliases?: string[];
    voice?: string;
    greeting?: string;
    unset_env?: string[];
    env?: Record<string, string>; // extra env for the lane's agent (e.g. ANTHROPIC_MODEL)
    persona?: string;             // in-character speaking style, injected into the lane's first turn
    // Plan-billing insurance: ordered backup brains tried when this lane's
    // agent fails before producing output (e.g. Anthropic plan → Codex plan
    // → a local/free agent profile). The switch is spoken out loud.
    fallbacks?: Array<{
      backend?: "acp" | "codex";
      binary?: string;
      binary_args?: string[];
      unset_env?: string[];
      env?: Record<string, string>;
    }>;
  }>;
  // Per-brain overrides
  binary?: string;          // override the binary name (default: same as backend)
  binary_args?: string[];   // extra args passed before the prompt
  ollama_port?: number;     // port for ollama backend (default 11434)
  ollama_model?: string;    // model name for ollama backend (default "qwen3.5:0.8b")
  // openai-compatible brain (OpenRouter / any local server / a LAN model server)
  base_url?: string;        // OpenAI-compatible base URL (e.g. http://192.168.1.50:8080/v1)
  model?: string;           // model id (e.g. gemma4, qwen3-coder, or an OpenRouter slug)
  api_key?: string;         // bearer key; omit for a keyless local/LAN server
  api_key_env?: string;     // env var to read the key from when api_key is unset
  max_tokens?: number;      // response cap for this brain (default 1024)
  timeout_ms?: number;      // absolute HTTP brain-turn deadline (default 120000)
  // openai-compatible brain pointed at an agent server (e.g. Hermes :8642):
  headers?: Record<string, string>; // static extra HTTP headers sent on every request
  // Header name under which to send a per-session id (generated once at startup) so a
  // stateful agent keeps memory across turns — Hermes uses "X-Hermes-Session-Id".
  session_header?: string;
  // When the brain supports it (e.g. codex, claude-code), speak a running summary
  // of what the agent is doing (commands, steps, final answer), not just the answer.
  narrate_progress?: boolean; // default true
  // Env vars to REMOVE from the agent subprocess. Set ["ANTHROPIC_API_KEY"] to make
  // claude-code use the OAuth/subscription login instead of a (stale) env API key.
  unset_env?: string[];
  // Agent-first: route EVERY open-ended conversational turn (the `local-llm` route)
  // to the brain/agent instead of the local model, so the whole conversation is the
  // agent (tools + memory). Instant utilities (time, battery, mute, stop) stay local.
  // Trade-off: every turn pays the agent's latency (and, for a cloud brain, cost).
  agent_first?: boolean;
  // Speak a short, varied "let me think…" filler at the start of a brain turn to
  // cover the agent's thinking latency (it plays while the agent generates). Default on.
  thinking_filler?: boolean;
}

export interface ServersConfig {
  router: ServerConfig;
  tts: ServerConfig;
  stt: ServerConfig;
}

export interface ServerConfig {
  port: number;
  model: string;
}

export interface ActionConfig {
  category: "terminal" | "cli" | "brain" | "local" | "local-llm";
  command: string;
  tts_mode: "full" | "summary" | "silent";
  examples: string[];
  /** Absolute wall-clock budget for this action. Defaults to 30 seconds. */
  timeout_s?: number;
  /** Maximum bytes retained from each output stream. Defaults to 64 KiB. */
  output_limit?: number;
}

export interface Tab {
  id: string;            // opaque adapter-specific handle (focus/send/get/close)
  title: string;
  is_focused: boolean;
  cwd?: string; // working directory of the tab's foreground process
}

export interface RouterResult {
  intent: string;
  category: "terminal" | "cli" | "brain" | "local" | "local-llm";
  params: Record<string, string>;
  confidence: number;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  duration_ms: number;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface ComponentHealth {
  name: string;
  status: "healthy" | "degraded" | "down";
  uptime_ms: number;
  last_check: Date;
  error?: string;
}

// Component interfaces
export interface Listener {
  start(): Promise<void>;
  stop(): Promise<void>;
  onCommand(callback: (text: string) => void): void;
}

export interface Router {
  classify(text: string, actions: Record<string, ActionConfig>, context?: string): Promise<RouterResult>;
  health(): Promise<boolean>;
}

/** Per-invocation controls shared by every brain adapter. */
export interface BrainTurnOptions {
  /** Cancels this turn only. Adapters should stop their underlying work promptly. */
  signal?: AbortSignal;
  /**
   * Immutable host-produced context for this invocation only. Adapters must
   * forward it unchanged and must never retain it as conversation memory.
   */
  systemContext?: string;
}

export interface BackgroundTurnOptions extends BrainTurnOptions {
  /** Lane switchboards: run the turn on this named lane (cold-starting it) instead of the front desk. */
  lane?: string;
}

/** Public, immutable identity for one pending ACP permission decision. */
export interface PendingConfirmation {
  readonly nonce: string;
  readonly summary: string;
}

export interface Brain {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: string, options?: BrainTurnOptions): Promise<string>;
  /**
   * Optional streaming variant of `send`. Yields response text incrementally
   * as the backend produces it, enabling low-latency TTS. Brains that cannot
   * stream omit this; callers must feature-detect with `typeof brain.sendStream`.
   */
  sendStream?(message: string, options?: BrainTurnOptions): AsyncIterable<string>;
  /**
   * Optional progress narration: yields speakable summaries of what the agent is
   * *doing* (its messages, the commands it runs, the final answer) rather than
   * only the final text. Agents that can stream structured events (e.g. Codex
   * `exec --json`) implement this; callers feature-detect with `typeof brain.streamProgress`.
   */
  streamProgress?(message: string, options?: BrainTurnOptions): AsyncIterable<string>;
  sendToTab?(message: string, tabName: string, options?: BrainTurnOptions): Promise<string>;
  switchTab?(tabName: string): void;
  getTargetTab?(): string;
  /**
   * Attach one-shot context to the next actual downstream brain turn. Wrapper
   * control replies may defer it, but adapters must not replay it indefinitely.
   */
  injectContext(context: string): void;
  restart(): Promise<void>;
  health(): Promise<boolean>;
  /** Lane switchboard: name of the pinned lane, or null at the front desk. */
  activeLane?(): string | null;
  /** Lane switchboard: pin a lane by name/alias (typed dial-back routing).
   * Resolves the employee's working name, or null when nobody matched.
   * `brief(lane)` builds context injected before the lane picks up; the turn
   * signal cancels startup and prevents a late pin. */
  transferTo?(
    ref: string,
    brief?: (lane: string) => Promise<string | null>,
    options?: BrainTurnOptions,
  ): Promise<string | null>;
  /** Install the daemon's dial-back so a SPOKEN "call me" rings the phone.
   * The handler returns the spoken ack and receives per-turn cancellation. */
  setCallMeHandler?(handler: (who?: string, options?: BrainTurnOptions) => Promise<string>): void;
  /** Lane switchboard: TTS voice override for the current speaker (undefined = default voice). */
  activeLaneVoice?(): string | undefined;
  /**
   * Unattended background turn (scheduled prompts). Not a spoken turn: lane
   * switchboards skip the control plane and never move the pinned lane;
   * options.lane targets a named lane instead of the front desk. Callers
   * feature-detect and fall back to send() when absent (helper: sendUnattended).
   */
  sendBackground?(message: string, options?: BackgroundTurnOptions): Promise<string>;
  /** True when the LAST turn was answered by the lexical control plane (transfer ack, roll call, standup) — such replies skip the TLDR gate. */
  wasControlTurn?(): boolean;
  /** ACP spoken-confirmation gate: true while a tool-permission request is waiting for a spoken yes/no. */
  hasPendingConfirmation?(): boolean;
  /** All approval capabilities visible through this brain wrapper. */
  pendingConfirmations?(): readonly PendingConfirmation[];
  /** ACP spoken-confirmation gate: approve or cancel the pending permission without sending a model turn.
   * The exact nonce is mandatory; stale, missing, or mismatched capabilities resolve nothing. */
  resolvePendingConfirmation?(approved: boolean, nonce: string): boolean;
}

export interface Speaker {
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
}

export interface SpawnTabOptions {
  title: string;
  cwd?: string;
  command?: string;       // optional shell command to send into the new tab
  env?: Record<string, string>;
  keepFocus?: boolean;
}

export interface TerminalAdapter {
  listTabs(): Promise<Tab[]>;
  focusTab(nameOrId: string): Promise<void>;
  sendText(tab: string, text: string): Promise<void>;
  sendKey(tab: string, key: string): Promise<void>;
  getText(tab: string, extent?: "screen" | "all" | "last_cmd_output"): Promise<string>;
  spawnTab(opts: SpawnTabOptions): Promise<Tab>;
  closeTab(id: string): Promise<void>;
  health(): Promise<{ ok: boolean; reason?: string }>;
}
