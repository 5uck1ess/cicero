import type { AgentAction } from "./actions";

export interface ToolResult {
  /** True when the action succeeded; false signals an error the agent should react to. */
  ok: boolean;
  /** LLM- and human-readable result or error text (fed back as the next observation). */
  output: string;
}

export type PreparedToolAction = Omit<AgentAction, "tool">;

export interface ToolRunContext {
  /** Cancels in-flight work owned by the current agent run. */
  signal?: AbortSignal;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for this tool's `args` object. Used in the prompt + constrained decoding. */
  readonly parameters: Record<string, unknown>;
  /**
   * Normalize and security-check model-authored arguments before policy and
   * confirmation. A rejection here is fail-closed and the tool is not run.
   */
  prepare?(
    args: Record<string, unknown>,
    context?: ToolRunContext,
  ): PreparedToolAction | Promise<PreparedToolAction>;
  run(args: Record<string, unknown>, context?: ToolRunContext): Promise<ToolResult>;
  /** Optional cleanup for tools that hold resources (e.g. a browser); called once after a run. */
  dispose?(): Promise<void>;
}
