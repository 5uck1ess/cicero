import type { ToolRegistry } from "./registry";
import type { AgentAction, AgentStep } from "./actions";
import { parseAgentStep, agentStepSchema } from "./actions";
import type { ActionDisposition } from "./policy";
import type { ToolResult } from "./tool";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }

export interface AgentLoopDeps {
  llm: {
    chatCompletion(
      messages: ChatMessage[],
      opts?: {
        responseFormat?: { type: "json_schema"; json_schema: Record<string, unknown> };
        signal?: AbortSignal;
      },
    ): Promise<string>;
  };
  registry: ToolRegistry;
  classify: (action: AgentAction) => ActionDisposition;
  confirm: (action: AgentAction) => Promise<boolean>;
  maxSteps?: number;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  steps: AgentStep[];
}

function systemPrompt(registry: ToolRegistry): string {
  return [
    "You are Cicero's action agent. You accomplish the user's goal by taking ONE action at a time.",
    "",
    "Available tools:",
    registry.manifest(),
    "- finish(summary) — call when the goal is complete or impossible; summary is spoken to the user.",
    "",
    "Respond with ONLY a JSON object, no prose, in this exact shape:",
    '{"thought": "<one short sentence>", "action": {"tool": "<tool name>", "args": {<args>}}}',
    "",
    "Rules:",
    "- Exactly one action per response.",
    "- After each action you receive an OBSERVATION; use it to decide the next action.",
    "- When done (or if you cannot proceed), use the finish tool with a summary.",
    "",
    "Examples:",
    '{"thought":"check what is in Downloads","action":{"tool":"list_dir","args":{"path":"~/Downloads"}}}',
    '{"thought":"the goal is met","action":{"tool":"finish","args":{"summary":"opened the report"}}}',
  ].join("\n");
}

export async function runAgent(goal: string, deps: AgentLoopDeps): Promise<AgentResult> {
  const { llm, registry, classify, confirm, log, signal } = deps;
  const maxSteps = deps.maxSteps ?? 12;
  const schema = agentStepSchema([...registry.names(), "finish"]);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(registry) },
    { role: "user", content: `GOAL: ${goal}` },
  ];
  const steps: AgentStep[] = [];

  for (let i = 0; i < maxSteps; i++) {
    if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
    let raw: string;
    try {
      raw = await llm.chatCompletion(messages, {
        responseFormat: { type: "json_schema", json_schema: schema },
        signal,
      });
    } catch (err: unknown) {
      if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`step ${i + 1}: [llm error] ${msg}`);
      return { ok: false, summary: `LLM error: ${msg}`, steps };
    }
    let step: AgentStep;
    try {
      step = parseAgentStep(raw);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`step ${i + 1}: [invalid output] ${msg}`);
      messages.push({ role: "user", content: `OBSERVATION: your output was not valid (${msg}). Respond with ONLY the JSON object.` });
      continue;
    }
    if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
    steps.push(step);
    messages.push({ role: "assistant", content: raw });
    log?.(`step ${i + 1}: ${step.action.tool} — ${step.thought}`);

    if (step.action.tool === "finish") {
      return { ok: true, summary: String(step.action.args.summary ?? ""), steps };
    }

    // Resolve and preflight the registered tool BEFORE policy. Preflight is the
    // trusted boundary that canonicalizes paths and rejects unsafe destinations;
    // a generic confirmation (including --yes) must never bypass it.
    const tool = registry.get(step.action.tool);
    if (!tool) {
      log?.(`step ${i + 1}: [no such tool] ${step.action.tool}`);
      messages.push({ role: "user", content: `OBSERVATION: no such tool '${step.action.tool}'.` });
      continue;
    }

    if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
    if (tool.prepare) {
      try {
        const prepared = await tool.prepare({ ...step.action.args }, { signal });
        if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
        step.action = {
          tool: step.action.tool,
          args: prepared.args,
          ...(prepared.confirmation !== undefined ? { confirmation: prepared.confirmation } : {}),
          ...(prepared.security !== undefined ? { security: prepared.security } : {}),
        };
      } catch (err: unknown) {
        if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`step ${i + 1}: [preflight blocked] ${step.action.tool} — ${msg}`);
        messages.push({
          role: "user",
          content: `OBSERVATION: action blocked during security preflight — ${msg}. Choose a different action or finish.`,
        });
        continue;
      }
    }

    if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
    const disposition = classify(step.action);
    if (disposition === "deny") {
      log?.(`step ${i + 1}: [denied] ${step.action.tool}`);
      messages.push({ role: "user", content: "OBSERVATION: that action is not permitted. Choose a different action or finish." });
      continue;
    }
    if (disposition === "confirm") {
      if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
      let approved: boolean;
      try {
        approved = await confirm(step.action);
      } catch (err: unknown) {
        // Fail closed: if we can't obtain confirmation (e.g. STT error during a
        // spoken prompt), treat it as declined — never execute on an errored gate.
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`step ${i + 1}: [confirm error → declined] ${msg}`);
        messages.push({ role: "user", content: `OBSERVATION: could not confirm that action (${msg}); treating it as declined. Choose a different action or finish.` });
        continue;
      }
      if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
      if (!approved) {
        log?.(`step ${i + 1}: [declined] ${step.action.tool}`);
        messages.push({ role: "user", content: "OBSERVATION: the user declined that action. Choose a different action or finish." });
        continue;
      }
    }

    if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
    let result: ToolResult;
    try {
      result = await tool.run(step.action.args, { signal });
    } catch (err: unknown) {
      if (signal?.aborted) return { ok: false, summary: "agent run cancelled", steps };
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`step ${i + 1}: ${step.action.tool} threw — ${msg}`);
      messages.push({ role: "user", content: `OBSERVATION: tool threw an error — ${msg}. Try a different action or finish.` });
      continue;
    }
    messages.push({ role: "user", content: `OBSERVATION: ${result.ok ? "" : "(error) "}${result.output}` });
  }

  return { ok: false, summary: "reached step limit without finishing", steps };
}
