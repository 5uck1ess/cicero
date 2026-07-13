import type { BackgroundTurnOptions, Brain } from "../types";

type BrainMethod = (...args: never[]) => unknown;

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
  return brain.send(message, options?.signal ? { signal: options.signal } : undefined);
}
