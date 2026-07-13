/**
 * In-process event bus for the voice dashboard. The daemon never depends on a
 * client being connected — `push` swallows subscriber errors, so a dead browser
 * tab can never break the voice loop. Everything funnels through `log()`, so the
 * big state pill is *derived* from known daemon log lines rather than threaded
 * through the daemon's hot path.
 */

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface DashEvent {
  type: "state" | "log" | "transcript" | "response" | "config" | "snapshot" | "voice";
  ts: number;
  state?: VoiceState;
  icon?: string;
  message?: string;
  text?: string;
  config?: Record<string, unknown>;
  history?: DashEvent[];
  voiceActive?: boolean;
}

type Sub = (e: DashEvent) => void;

const HISTORY_LIMIT = 80;
const ANSI = /\x1b\[[0-9;]*m/g;

class DashBus {
  private subs = new Set<Sub>();
  private history: DashEvent[] = [];
  state: VoiceState = "idle";
  config: Record<string, unknown> = {};
  // Whether conversational voice mode is armed. Distinct from `state`: the pill
  // tracks activity (listening/thinking/speaking) while this tracks whether the
  // loop is on at all, so the dashboard toggle button can show the right label.
  voiceActive = false;

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
    return { type: "snapshot", ts: Date.now(), state: this.state, voiceActive: this.voiceActive, config: this.config, history: [...this.history] };
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
