import type { RuntimeConfig } from "../config";
import type { Brain, TerminalAdapter } from "../types";
import { ClaudeCodeBrain } from "./claude-code";
import { CodexBrain } from "./codex";
import { GeminiBrain } from "./gemini";
import { QwenBrain } from "./qwen";
import { OllamaBrain } from "./ollama";
import { OpenAiCompatibleBrain } from "./openai-compatible";
import { TabInjectBrain } from "./tab-inject";
import { AcpBrain } from "./acp";
import { HermesGatewayBrain } from "./hermes-gateway";
import { FallbackBrain } from "./fallback";
import { RoutingBrain } from "./routing";
import { SwitchboardBrain, type LaneDef } from "./switchboard";
import { QuickIntentsBrain } from "./quick-intents";
import { DialBackBrain } from "./dial-back";
import { OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";
import { sendTelegramConfirmation } from "../notify/telegram";
import { log } from "../logger";
import { NullTerminalAdapter } from "../terminal/null";
import {
  discardResponseBody,
  PROVIDER_TIMEOUT_MS,
  providerSignal,
  readBoundedJson,
} from "../backends/http-transfer";

export interface BrainHooks {
  onNudgeReply?: (text: string) => void;
  /** Daemon runtime only: install the backend-independent spoken dial-back control. */
  dialBackControl?: boolean;
}

/**
 * Small-local-model intent classifier over the TLDR summarizer endpoint —
 * shared by the switchboard and the transport-neutral dial-back classifiers.
 * undefined without a configured endpoint: callers degrade to lexical-only.
 */
export function summarizerClassifier(
  tldrCfg?: { summarizer_url?: string; summarizer_model?: string },
): ((prompt: string, signal?: AbortSignal) => Promise<string>) | undefined {
  const url = tldrCfg?.summarizer_url;
  if (!url) return undefined;
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: tldrCfg?.summarizer_model ?? "default",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 12,
          temperature: 0,
        }),
        signal: providerSignal(PROVIDER_TIMEOUT_MS.classifier, signal),
      });
      if (!res.ok) {
        await discardResponseBody(res);
        throw new Error(`classifier http ${res.status}`);
      }
      const data = await readBoundedJson<{
        choices?: Array<{ message?: { content?: string } }>;
      }>(res);
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err: unknown) {
      throw err;
    }
  };
}

export function createBrain(config: RuntimeConfig, terminal?: TerminalAdapter, hooks: BrainHooks = {}): Brain {
  const built = buildBrain(config, terminal, hooks);
  // SwitchboardBrain already owns the richer lane + dial-back control plane.
  // Decorate only brains that do not advertise that native capability so a
  // call-ish non-command never pays for two classifier round trips.
  const brain = hooks.dialBackControl && !built.setCallMeHandler
    ? new DialBackBrain(
      built,
      summarizerClassifier(config.raw.web_voice?.tldr),
      Object.keys(config.brain.lanes ?? {}),
    )
    : built;
  // User-defined lexical fast-paths sit in front of EVERYTHING (front desk,
  // lanes, escalation) — they are the user's own control plane.
  const intents = config.quickIntents;
  return intents?.length ? new QuickIntentsBrain(brain, intents) : brain;
}

function buildBrain(config: RuntimeConfig, terminal?: TerminalAdapter, hooks: BrainHooks = {}): Brain {
  const { backend, mode, target_tab, auto_approve_tools, confirm_tools, confirm_retry, max_queue_bytes, max_response_bytes, max_pending_turns, binary, binary_args, ollama_port, ollama_model, base_url, model, api_key, api_key_env, max_tokens, timeout_ms, unset_env, headers, session_header, gateway_url, gateway_url_env, session } = config.brain;
  const onConfirmationPending = config.notify?.telegram
    ? async (summary: string, nonce: string): Promise<void> => {
        try {
          const sent = await sendTelegramConfirmation(config.notify!.telegram!, `Allow ${summary}?`, nonce);
          if (!sent) log("warn", `approval prompt was not delivered for: ${summary}`);
        } catch (err: unknown) {
          log("warn", `approval prompt delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    : undefined;

  // tab-inject is Claude Code only — it relies on a CC interactive session in a terminal tab.
  if (mode === "tab-inject" && backend === "claude-code") {
    if (!terminal || terminal instanceof NullTerminalAdapter) {
      throw new Error(
        "brain.mode='tab-inject' requires kitty, tmux, or WezTerm terminal integration; "
        + "set brain.mode: subprocess for a headless/no-terminal deployment",
      );
    }
    return new TabInjectBrain(terminal, target_tab || "cicero-brain", auto_approve_tools ?? false);
  }

  // Any OpenAI-compatible model as the brain: "openai-compatible" + an explicit
  // base_url (a local server, a LAN Hermes *model*, or the Hermes *agent* HTTP API
  // on :8642 — which runs tools/memory server-side). With `session_header` set, send
  // a per-session id so a stateful agent keeps memory across turns.
  if (OPENAI_COMPATIBLE_BACKENDS.includes(backend)) {
    const extraHeaders: Record<string, string> = { ...(headers ?? {}) };
    if (session_header) {
      const sessionId = crypto.randomUUID();
      extraHeaders[session_header] = sessionId;
    }
    return new OpenAiCompatibleBrain(
      { backend, baseUrl: base_url, model, apiKey: api_key, apiKeyEnv: api_key_env, extraHeaders, timeout_ms },
      max_tokens,
    );
  }

  // ACP (Agent Client Protocol): a harness-independent agent over stdio. Talks
  // tools + memory back-and-forth; point it at any ACP agent via binary/binary_args
  // (e.g. ["ssh","gpu-box","hermes","acp"], or local ["bun","x","@zed-industries/claude-code-acp@0.16.2"]).
  if (backend === "acp") {
    const primary = new AcpBrain({
      binary: binary ?? "hermes",
      args: binary_args ?? ["acp"],
      cwd: process.cwd(),
      unsetEnv: unset_env,
      autoApproveTools: auto_approve_tools ?? false,
      confirmTools: confirm_tools,
      confirmRetry: confirm_retry ?? true,
      maxQueuedBytes: max_queue_bytes,
      maxResponseBytes: max_response_bytes,
      maxPendingTurns: max_pending_turns,
      onConfirmationPending,
      onNudgeReply: hooks.onNudgeReply,
    });
    // Optional think lane: "think hard about…" routes the turn to a second,
    // heavier ACP agent (e.g. a profile on a bigger model).
    const esc = config.brain.escalate;
    let front: Brain = primary;
    if (esc?.binary || esc?.binary_args) {
      const escalation = new AcpBrain({
        binary: esc.binary ?? binary ?? "hermes",
        args: esc.binary_args ?? ["acp"],
        cwd: process.cwd(),
        unsetEnv: esc.unset_env ?? unset_env,
        autoApproveTools: auto_approve_tools ?? false,
        confirmTools: confirm_tools,
        confirmRetry: confirm_retry ?? true,
        maxQueuedBytes: max_queue_bytes,
        maxResponseBytes: max_response_bytes,
        maxPendingTurns: max_pending_turns,
        onConfirmationPending,
        onNudgeReply: hooks.onNudgeReply,
      });
      front = new RoutingBrain(primary, escalation, esc.triggers);
    }
    // Optional lane switchboard: named employees ("let me talk to the coder")
    // wrapping the front desk. Lanes start lazily on first pin.
    const laneDefs = config.brain.lanes;
    if (laneDefs && Object.keys(laneDefs).length > 0) {
      const lanes: Record<string, LaneDef> = {};
      // codex lanes drive the Codex CLI directly (it has no ACP mode) and
      // resume the same codex session across turns for continuity.
      const makeLaneBrain = (d: { backend?: "acp" | "codex"; binary?: string; binary_args?: string[]; unset_env?: string[]; env?: Record<string, string> }): Brain =>
        d.backend === "codex"
          ? new CodexBrain(d.binary ?? "codex", d.binary_args ?? [], d.unset_env ?? [], { resume: true })
          : new AcpBrain({
              binary: d.binary ?? binary ?? "hermes",
              args: d.binary_args ?? ["acp"],
              cwd: process.cwd(),
              env: d.env,
              unsetEnv: d.unset_env ?? unset_env,
              autoApproveTools: auto_approve_tools ?? false,
              confirmTools: confirm_tools,
              confirmRetry: confirm_retry ?? true,
              maxQueuedBytes: max_queue_bytes,
              maxResponseBytes: max_response_bytes,
              maxPendingTurns: max_pending_turns,
              onConfirmationPending,
              onNudgeReply: hooks.onNudgeReply,
            });
      for (const [name, l] of Object.entries(laneDefs)) {
        const laneBrain: Brain = l.fallbacks?.length
          ? new FallbackBrain([makeLaneBrain(l), ...l.fallbacks.map(makeLaneBrain)], name)
          : makeLaneBrain(l);
        lanes[name] = {
          brain: laneBrain,
          aliases: l.aliases,
          voice: l.voice,
          greeting: l.greeting,
          persona: l.persona,
        };
      }
      // Intent classifier for phrasings the lexical patterns miss: the same
      // small local model the TLDR summarizer uses (already loaded, ~0.4s).
      // Without a summarizer endpoint the switchboard is lexical-only.
      return new SwitchboardBrain(front, lanes, summarizerClassifier(config.raw.web_voice?.tldr));
    }
    return front;
  }

  if (backend === "hermes-gateway") {
    const url = gateway_url ?? (gateway_url_env ? process.env[gateway_url_env] : undefined);
    if (!url) {
      throw new Error(
        gateway_url_env
          ? `brain.gateway_url_env points to unset environment variable '${gateway_url_env}'`
          : "brain.gateway_url or brain.gateway_url_env is required for hermes-gateway",
      );
    }
    return new HermesGatewayBrain({
      url,
      session: session ?? "",
      autoApproveTools: auto_approve_tools,
      turnTimeoutMs: timeout_ms,
      maxResponseBytes: max_response_bytes,
    });
  }

  switch (backend) {
    case "claude-code":
      return new ClaudeCodeBrain(binary, binary_args, unset_env);
    case "codex":
      return new CodexBrain(binary, binary_args, unset_env);
    case "gemini":
      return new GeminiBrain(binary, binary_args);
    case "qwen":
      return new QwenBrain(binary, binary_args);
    case "ollama":
      return new OllamaBrain({ port: ollama_port, model: ollama_model, timeoutMs: timeout_ms });
    default:
      throw new Error(`Unknown brain backend: ${backend}`);
  }
}
