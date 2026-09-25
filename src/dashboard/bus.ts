/**
 * In-process event bus for the voice dashboard. The daemon never depends on a
 * client being connected — `push` swallows subscriber errors, so a dead browser
 * tab can never break the voice loop. Everything funnels through `log()`, so the
 * big state pill is *derived* from known daemon log lines rather than threaded
 * through the daemon's hot path.
 */
import type { BrainStructuredUpdate } from "../types";
import { redactSnapshotSecrets } from "../operational-state";
import type { Percentiles } from "../latency";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface DashEvent {
  type: "state" | "log" | "transcript" | "response" | "config" | "snapshot" | "voice" | "structured" | "latency";
  ts: number;
  state?: VoiceState;
  icon?: string;
  message?: string;
  text?: string;
  config?: Record<string, unknown>;
  history?: DashEvent[];
  voiceActive?: boolean;
  structured?: BrainStructuredUpdate;
  latency?: Percentiles;
}

type Sub = (e: DashEvent) => void;

const HISTORY_LIMIT = 80;
const ANSI = /\x1b\[[0-9;]*m/g;
function boundedLabel(value: string, max: number): string {
  return redactSnapshotSecrets(value.replace(/[\x00-\x1f\x7f]/g, " ")).slice(0, max);
}

function structuredMessage(update: BrainStructuredUpdate): string {
  if (update.kind === "plan") {
    const entries = update.entries ?? [];
    const count = entries.length;
    const active = entries.filter((entry) => entry.status === "in_progress").length;
    const head = `plan: ${count} ${count === 1 ? "step" : "steps"}${active ? ` (${active} in progress)` : ""}`;
    return `${head}${entries[0] ? ` · ${entries[0].title}: ${entries[0].status}` : ""}`.slice(0, 256);
  }
  return `tool ${update.title || "call"}: ${update.status || "pending"}`.slice(0, 256);
}

class DashBus {
  private subs = new Set<Sub>();
  private history: DashEvent[] = [];
  state: VoiceState = "idle";
  config: Record<string, unknown> = {};
  // Whether conversational voice mode is armed. Distinct from `state`: the pill
  // tracks activity (listening/thinking/speaking) while this tracks whether the
  // loop is on at all, so the dashboard toggle button can show the right label.
  voiceActive = false;
  latency?: Percentiles;

  subscribe(sub: Sub): () => void {
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  private push(e: DashEvent): void {
    if (e.type === "log" || e.type === "transcript" || e.type === "response") {
      this.history.push(e);
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    for (const sub of this.subs) {
      try { sub(e); } catch { /* a dead client must never break the app */ }
    }
  }

  /** Full current state — sent to a client the moment it connects. */
  snapshot(): DashEvent {
    return { type: "snapshot", ts: Date.now(), state: this.state, voiceActive: this.voiceActive, config: this.config, history: [...this.history], latency: this.latency };
  }

  setLatency(latency?: Percentiles): void {
    this.latency = latency;
    this.push({ type: "latency", ts: Date.now(), latency });
  }

  setState(state: VoiceState, message?: string): void {
    if (this.state !== state) {
      this.state = state;
      this.push({ type: "state", ts: Date.now(), state, message });
    }
  }

  /** Reflect whether voice mode is armed so the dashboard toggle stays in sync. */
  setVoiceActive(active: boolean): void {
    if (this.voiceActive !== active) {
      this.voiceActive = active;
      this.push({ type: "voice", ts: Date.now(), voiceActive: active });
    }
  }

  setConfig(config: Record<string, unknown>): void {
    this.config = config;
    this.push({ type: "config", ts: Date.now(), config });
  }

  /** Tapped by the logger — feeds the live event log AND derives the state pill. */
  log(icon: string, message: string): void {
    const clean = message.replace(ANSI, "");
    this.push({ type: "log", ts: Date.now(), icon, message: clean });

    const heard = clean.match(/^Heard:\s*"(.*)"\s*$/i);
    if (heard) this.transcript(heard[1]);

    this.deriveState(clean);
  }

  transcript(text: string): void {
    this.push({ type: "transcript", ts: Date.now(), text });
  }

  response(text: string): void {
    this.push({ type: "response", ts: Date.now(), text });
  }

  structured(update: NonNullable<DashEvent["structured"]>): void {
    const clean: BrainStructuredUpdate = {
      kind: update.kind,
      ...(update.sourceId ? { sourceId: boundedLabel(update.sourceId, 48) } : {}),
      ...(update.turnId ? { turnId: boundedLabel(update.turnId, 32) } : {}),
      ...(update.toolCallId ? { toolCallId: boundedLabel(update.toolCallId, 128) } : {}),
      ...(update.title ? { title: boundedLabel(update.title, 160) } : {}),
      ...(update.toolKind ? { toolKind: boundedLabel(update.toolKind, 32) } : {}),
      ...(update.status ? { status: boundedLabel(update.status, 32) } : {}),
      ...(update.entries ? { entries: update.entries.slice(0, 32).map((entry) => ({
        title: boundedLabel(entry.title, 160), status: boundedLabel(entry.status, 32),
      })) } : {}),
    };
    this.push({ type: "structured", ts: Date.now(), structured: clean, message: structuredMessage(clean) });
  }

  private deriveState(message: string): void {
    const m = message.toLowerCase();
    // The boot message "listener ready (say 'stop listening'…)" mentions
    // listening but the loop isn't active yet — don't let it flip the pill.
    if (m.includes("listener ready") || m.includes("conversational mode off") ||
        m.includes("conversational mode deactivated")) {
      this.setState("idle");
      if (m.includes("deactivated") || m.includes("mode off")) this.setVoiceActive(false);
    } else if (m.includes("conversational mode activated") || m.includes("resuming") ||
               (m.includes("listening") && !m.includes("stop listening"))) {
      this.setState("listening");
      if (m.includes("activated")) this.setVoiceActive(true);
    } else if (m.startsWith("heard") || m.startsWith("intent:") || m.includes("thinking") || m.includes("streaming")) {
      this.setState("thinking");
    } else if (m.includes("speaking") || m.includes("→ tts") || m.includes("spoke via")) {
      this.setState("speaking");
    }
  }
}

export const dashBus = new DashBus();
