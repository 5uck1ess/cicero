import type { BackgroundTurnOptions, Brain, BrainConfig } from "../types";
import { OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";

type BrainMethod = (...args: never[]) => unknown;

/** Backends routed to the OpenAI chat-completions provider (see `backends/llm/openai`). */
const OPENAI_FAMILY: ReadonlySet<string> = new Set(OPENAI_COMPATIBLE_BACKENDS);

/**
 * True when a turn on this brain can change the world — write files, run
 * commands, post messages — and not merely produce text.
 *
 * This matters for work started on an utterance the user has NOT finished
 * saying (see `web-voice/speculative.ts`). Buffered tokens from a wrong guess
 * are simply dropped, but a tool call has already happened by the time the
 * guess is found to be wrong: "delete the old migrations" spoken before a
 * pause deletes them, and the user's "— no wait, keep the last one" arrives
 * too late. Text is retractable; side effects are not.
 *
 * Fails closed — "might run tools" and "does run tools" are the same answer
 * here, because guessing "safe" is the mistake that cannot be undone:
 * - `tab-inject` drives a live agent session in a terminal tab, whatever the
 *   backend is named.
 * - CLI agents, ACP, and any unrecognized backend name (`backend` accepts
 *   arbitrary strings) are assumed to run tools.
 * - The OpenAI-compatible family is model-only ONLY while it resolves to its
 *   preset's own public endpoint. `base_url` overrides the preset for every
 *   backend name (`resolveOpenAiTarget`), and an operator-supplied URL can
 *   point at an agent that runs tools server-side — Cicero's own docs give
 *   Hermes' agent HTTP API as the example. A brain with an explicit `base_url`
 *   is therefore unknowable from config alone, so it counts as tool-executing.
 */
export function brainExecutesTools(
  config: Pick<BrainConfig, "backend" | "mode" | "base_url">,
): boolean {
  // tab-inject is Claude Code only — the factory falls through to the ordinary
  // backend for any other name, so the mode alone does not imply an agent.
  if (config.mode === "tab-inject" && config.backend === "claude-code") return true;
  // Ollama speaks its own /api/chat protocol, which serves models, not agents.
  if (config.backend === "ollama") return false;
  if (!OPENAI_FAMILY.has(config.backend)) return true;
  return (config.base_url ?? "").trim() !== "";
}

type OptionalBrainKey = {
  [K in keyof Brain]-?: object extends Pick<Brain, K> ? K : never;
}[keyof Brain];

/** Optional Brain methods that wrappers may expose by delegation. */
export type BrainCapability = {
  [K in OptionalBrainKey]-?: NonNullable<Brain[K]> extends BrainMethod ? K : never;
}[OptionalBrainKey];

type BoundCapability<K extends BrainCapability> = Extract<Brain[K], BrainMethod>;

/**
 * Return a capability bound to its owning brain, or undefined when that brain
 * does not implement it. Keeping the absence observable lets callers safely
 * feature-detect optional Brain methods through decorators.
 */
export function bindBrainCapability<K extends BrainCapability>(
  brain: Brain,
  capability: K,
): BoundCapability<K> | undefined {
  const method = brain[capability];
  if (typeof method !== "function") return undefined;
  return method.bind(brain) as BoundCapability<K>;
}

export function allBrainsSupport<K extends BrainCapability>(
  brains: readonly Brain[],
  capability: K,
): boolean {
  return brains.every((brain) => typeof brain[capability] === "function");
}

/**
 * Run an unattended background turn against whatever brain is configured.
 * Brains without sendBackground get a plain send() — except when a lane was
 * requested, which only a lane switchboard can honor: silently answering from
 * the wrong brain would misattribute scheduled work, so that is an error.
 */
export function sendUnattended(
  brain: Brain,
  message: string,
  options?: BackgroundTurnOptions,
): Promise<string> {
  if (brain.sendBackground) return brain.sendBackground(message, options);
  if (options?.lane !== undefined) {
    return Promise.reject(new Error(`this brain has no lanes — cannot run a background turn on lane "${options.lane}"`));
  }
  return brain.send(message, options);
}
