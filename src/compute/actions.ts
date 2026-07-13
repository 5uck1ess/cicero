export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
  /** Trusted, tool-authored description shown at the human approval boundary. */
  confirmation?: string;
  /** Trusted policy facts produced by a registered tool's preflight step. */
  security?: {
    sensitiveRead?: boolean;
  };
}

export interface AgentStep {
  thought: string;
  action: AgentAction;
}

/** Human-facing description for terminal and spoken confirmation prompts. */
export function describeActionForConfirmation(action: AgentAction): string {
  return action.confirmation ?? `${action.tool}(${JSON.stringify(action.args)})`;
}

/** Extract the first balanced {...} JSON object from arbitrary model text. */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced ? fenced[1] : text;
  const start = haystack.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    // Braces inside string literals must not change depth, or a "}" in a
    // thought/summary string would truncate extraction. Track string + escape state.
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  throw new Error("no JSON object found in model output (unbalanced braces)");
}

export function parseAgentStep(text: string): AgentStep {
  const raw = extractJsonObject(text);
  const parsed = JSON.parse(raw) as { thought?: unknown; action?: unknown };
  const action = parsed.action as { tool?: unknown; args?: unknown } | undefined;
  if (!action || typeof action.tool !== "string") {
    throw new Error("agent step is missing action.tool");
  }
  return {
    thought: typeof parsed.thought === "string" ? parsed.thought : "",
    action: {
      tool: action.tool,
      args: (action.args && typeof action.args === "object")
        ? (action.args as Record<string, unknown>)
        : {},
    },
  };
}

/** JSON Schema for the {thought, action} step, passed to responseFormat for constrained decoding. */
export function agentStepSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      thought: { type: "string" },
      action: {
        type: "object",
        properties: {
          tool: { type: "string", enum: toolNames },
          args: { type: "object" },
        },
        required: ["tool"],
      },
    },
    required: ["thought", "action"],
  };
}
