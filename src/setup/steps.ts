import type { SetupDraft } from "./draft";
import type { SystemFacts } from "./system";

export interface StepContext { system: SystemFacts; draft: SetupDraft }
export interface StepExplain {
  what: string;
  why: string;
  happens: string;
  learnMore: string;
}
export interface SetupStep {
  id: string;
  title: string;
  pipeline?: "mic" | "stt" | "brain" | "tts" | "speaker";
  explain: StepExplain;
  /** Read-only detection; dependencies are supplied by the server/test. */
  detect(context: StepContext, deps?: unknown): Promise<unknown>;
  /** Contribute only this step's chosen fields to the in-memory draft. */
  contribute(context: StepContext, choice?: unknown): Record<string, unknown>;
  available: boolean;
}

function step(id: string, title: string, what: string, learnMore: string, pipeline?: SetupStep["pipeline"]): SetupStep {
  return {
    id, title, pipeline, available: false,
    explain: { what, why: "Coming in a later release.", happens: "This preview does not change configuration for this step.", learnMore },
    async detect() { return null; },
    contribute() { return {}; },
  };
}

export const SETUP_STEPS: readonly SetupStep[] = [
  {
    id: "system", title: "System", available: true, pipeline: "mic",
    explain: {
      what: "Checks this computer's platform, memory, disk, and GPU to choose a starting deployment preset.",
      why: "The recommended preset follows the detected hardware; you can choose another preset.",
      happens: "Only read-only hardware checks run. Your choice is kept in memory until Write.",
      learnMore: "docs/setup.md",
    },
    async detect({ system }) { return system; },
    contribute({ system }, choice) { return { deployment: (choice as SetupDraft["deployment"] | undefined) ?? system.recommendedTier }; },
  },
  step("provider", "LLM provider", "The local or remote language model answers ordinary conversation.", "docs/setup.md", "brain"),
  step("brain", "Brain", "A coding agent handles coding work while Cicero carries your voice.", "docs/brains.md", "brain"),
  step("board", "Task board", "An optional external board supplies task notifications.", "docs/notifications.md", "brain"),
  step("stt", "STT", "Speech-to-text turns microphone audio into words.", "docs/setup.md", "stt"),
  step("tts", "TTS", "Text-to-speech turns replies into audio.", "docs/voice-cloning.md", "tts"),
  step("channels", "Channels", "Channels carry messages and calls beyond the browser.", "docs/channels.md", "speaker"),
  step("install", "Install", "Selected local engines need their runtime and model files.", "docs/setup.md"),
  {
    id: "check", title: "Check", available: true, pipeline: "speaker",
    explain: { what: "Runs the real Cicero doctor against a private temporary copy of the draft.", why: "Failures block writing; warnings show what still needs attention.", happens: "The temporary copy is removed after checks finish.", learnMore: "docs/setup.md" },
    async detect() { return null; }, contribute() { return {}; },
  },
  {
    id: "write", title: "Write", available: true, pipeline: "speaker",
    explain: { what: "Reviews and writes your private, annotated config.yaml.", why: "The comments explain each setting for later edits.", happens: "Only a missing config may be written. An invalid existing config needs an explicit backup first.", learnMore: "docs/setup.md" },
    async detect() { return null; }, contribute() { return {}; },
  },
  {
    id: "handoff", title: "Hand-off", available: true, pipeline: "speaker",
    explain: { what: "Start Cicero and pair a phone after setup exits.", why: "The stable web voice token survives daemon restarts.", happens: "This page closes the setup server; it does not start the daemon.", learnMore: "docs/setup.md" },
    async detect() { return null; }, contribute() { return {}; },
  },
];
