import { ToolRegistry } from "./registry";
import { runAgent } from "./agent-loop";
import type { AgentResult, AgentLoopDeps } from "./agent-loop";
import { classifyAction } from "./policy";
import { createFileTools } from "./tools/files";
import { shellTool } from "./tools/shell";
import { openAppTool } from "./tools/apps";
import { createBrowserTool } from "./tools/browser";
import { makeVoiceConfirm } from "./voice";

export { ToolRegistry } from "./registry";
export { runAgent } from "./agent-loop";
export type { AgentResult, AgentLoopDeps } from "./agent-loop";
export { classifyAction } from "./policy";
export type { PreparedToolAction, Tool, ToolResult, ToolRunContext } from "./tool";
export { parseAffirmative, makeVoiceConfirm, makeVoiceNarrator } from "./voice";
export type { VoiceConfirmDeps } from "./voice";
export { parseActionRequest } from "./intent";
export type { ActionRequest } from "./intent";
export { isLocalComputeTarget } from "./egress";
export { describeActionForConfirmation } from "./actions";

/** Tier A: local OS tools, always present. Tier B (the Playwright browser tool)
 *  is opt-in via `{ web: true }` so the browser dependency only loads when wanted. */
export function buildDefaultRegistry(opts: {
  web?: boolean;
  workspaceRoot?: string;
  maxReadBytes?: number;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const { listDirTool, readFileTool, writeFileTool } = createFileTools({
    root: opts.workspaceRoot,
    maxReadBytes: opts.maxReadBytes,
  });
  for (const tool of [listDirTool, readFileTool, writeFileTool, shellTool, openAppTool]) {
    registry.register(tool);
  }
  if (opts.web) registry.register(createBrowserTool());
  return registry;
}

export interface RunDoOptions {
  /** The LLM that drives the ReAct loop. */
  llm: AgentLoopDeps["llm"];
  /** Asks the user to approve a mutating action; return false to skip it. */
  confirm: AgentLoopDeps["confirm"];
  /** Registry override; defaults to the Tier A registry (plus browser if `web`). */
  registry?: ToolRegistry;
  /** Include the Tier B Playwright browser tool. Ignored when `registry` is given. */
  web?: boolean;
  /** Filesystem boundary for default file tools (default: process.cwd()). */
  workspaceRoot?: string;
  /** Largest file observation returned to the model. */
  maxReadBytes?: number;
  maxSteps?: number;
  log?: (message: string) => void;
  /** Cancels in-flight tools (including process trees) for this run. */
  signal?: AbortSignal;
}

/**
 * High-level entry point for `cicero do "<goal>"`: wires the default registry and
 * the standard allow/confirm/deny policy into the agent loop.
 */
export async function runDo(goal: string, opts: RunDoOptions): Promise<AgentResult> {
  const registry = opts.registry ?? buildDefaultRegistry({
    web: opts.web,
    workspaceRoot: opts.workspaceRoot,
    maxReadBytes: opts.maxReadBytes,
  });
  try {
    return await runAgent(goal, {
      llm: opts.llm,
      registry,
      classify: classifyAction,
      confirm: opts.confirm,
      maxSteps: opts.maxSteps,
      log: opts.log,
      signal: opts.signal,
    });
  } finally {
    // Release any resource-holding tools (e.g. close the headless browser).
    await registry.dispose();
  }
}

export interface RunVoiceActionOptions {
  llm: AgentLoopDeps["llm"];
  /** Speak text to the user (the existing TTS Speaker). */
  speak: (text: string) => Promise<void>;
  /** Capture and transcribe a single spoken turn (for the confirmation reply). */
  listenOnce: () => Promise<string>;
  /** Progress sink for each agent step (e.g. daemon console log). Not spoken. */
  log?: (message: string) => void;
  /** Registry override (mainly for tests); defaults to Tier A (plus browser if web). */
  registry?: ToolRegistry;
  web?: boolean;
  maxSteps?: number;
  workspaceRoot?: string;
  maxReadBytes?: number;
  signal?: AbortSignal;
}

/**
 * Voice-driven computer use: runs the agent with a SPOKEN confirmation gate —
 * mutating actions are announced and only proceed on an affirmative spoken reply.
 * The final `summary` is what the caller speaks back. Per-step thoughts go to
 * `log` (console), not TTS, to avoid overlapping speech.
 */
export function runVoiceAction(goal: string, opts: RunVoiceActionOptions): Promise<AgentResult> {
  const confirm = makeVoiceConfirm({ speak: opts.speak, listenOnce: opts.listenOnce });
  return runDo(goal, {
    llm: opts.llm,
    confirm,
    log: opts.log,
    registry: opts.registry,
    web: opts.web,
    maxSteps: opts.maxSteps,
    workspaceRoot: opts.workspaceRoot,
    maxReadBytes: opts.maxReadBytes,
    signal: opts.signal,
  });
}
