import { isLoopbackHost } from "../backends/net";
import { ACP_AGENTS, acpProviderOf, isCloudAcpCommand, type AcpAgent } from "./acp-agents";
export { ACP_AGENTS } from "./acp-agents";
import { unsetEnvFor, type AccountsChoice } from "./accounts";
import type { FrontDeskChoice } from "./frontdesk";
import { contributeBrain, detectBrain, parseBrain, type PickerDeps } from "./pickers";
import { isLocal, withAllowance } from "./privacy";
import type { StepContext } from "./steps";

/**
 * The Agent step. With an agent front desk it writes `brain`; with a model
 * front desk it writes `brain.escalate`, the agent the front desk hands a
 * "think hard" turn to. Only ACP agents can be escalation targets.
 */
const CLOUD_CLIS: Record<string, string | null> = { "claude-code": "claude-code", codex: "codex", gemini: null, qwen: null };
export const ALLOW_CLOUD_FIRST = "Allow this agent to use the cloud first";
const ESCALATE_ACP_ONLY = "With a model front desk, the agent must be an ACP agent (or none)";

export type AgentTarget = "brain" | "escalate";
export type AgentChoice =
  | { id: "none"; target: "escalate" }
  | (ReturnType<typeof parseBrain> & { target: AgentTarget; cloud: boolean; allowCloud: boolean; provider: string | null; acp?: string });

export function agentTarget(ctx: StepContext): AgentTarget {
  const front = ctx.choices?.get("frontdesk") as FrontDeskChoice | undefined;
  return front?.kind === "model" ? "escalate" : "brain";
}

export async function detectAgent(ctx: StepContext, deps: PickerDeps = {}) {
  const base = await detectBrain(ctx, deps);
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const target = agentTarget(ctx);
  const local = isLocal(ctx);
  const acp = ACP_AGENTS.map((a) => ({ id: a.id, label: a.label, command: a.command, cloud: a.cloud, found: Boolean(which(a.command[0]!)), status: "unverified until first call" }));
  const cloud: Record<string, boolean> = { "claude-code": true, codex: true, gemini: true, qwen: true, ...Object.fromEntries(ACP_AGENTS.map((a) => [a.id, a.cloud])) };
  const cliFirst = Object.keys(CLOUD_CLIS).find((id) => base.installed[id]?.found);
  const recommended = target === "escalate" ? "none" : local ? (acp.find((a) => !a.cloud && a.found)?.id ?? cliFirst ?? base.recommended) : base.recommended;
  const reason = target === "escalate"
    ? "Your front desk answers on its own; add an agent for \"think hard\" turns if you want one."
    : local && cliFirst ? `${cliFirst} is installed. It reaches the cloud, so allow that first, or pick a local ACP agent.` : base.reason;
  return { ...base, target, mode: target, acp, cloud, recommended, reason, localOnly: local };
}

function acpCommand(raw: Record<string, unknown>): { acp: AcpAgent | null; raw: Record<string, unknown> } {
  const known = ACP_AGENTS.find((a) => a.id === raw.id);
  return known ? { acp: known, raw: { ...raw, id: "acp", command: known.command } } : { acp: null, raw };
}

function isCloud(parsed: ReturnType<typeof parseBrain>, acp: AcpAgent | null): boolean {
  if (acp) return acp.cloud;
  // A custom ACP command is cloud when it runs a known cloud adapter; any other harness reaches the cloud only through its own model.
  if (parsed.id === "acp") { const p = parsed as { binary?: string; binary_args?: string[] }; return isCloudAcpCommand(p.binary, p.binary_args); }
  if (parsed.id === "ollama") return false;
  if (parsed.id in CLOUD_CLIS) return true;
  if (parsed.id === "openai-compatible") {
    // Anything off this machine (a LAN server too) leaves it, as doctor's local-mode check says.
    try { return !isLoopbackHost(new URL(String((parsed as { base_url?: string }).base_url)).hostname); } catch { return true; }
  }
  return true; // a cloud API preset
}

export function parseAgent(raw: unknown, ctx: StepContext, deps: PickerDeps = {}): AgentChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose an agent");
  const c = raw as Record<string, unknown>;
  const target = agentTarget(ctx);
  if (c.id === "none") {
    if (target !== "escalate") throw new Error("An agent front desk needs an agent");
    return { id: "none", target };
  }
  if (c.allowCloud !== undefined && typeof c.allowCloud !== "boolean") throw new Error("Allow cloud must be on or off");
  const { acp, raw: resolved } = acpCommand(c);
  if (target === "escalate" && resolved.id !== "acp") throw new Error(ESCALATE_ACP_ONLY);
  if (target === "escalate" && resolved.mode === "tab-inject") throw new Error(ESCALATE_ACP_ONLY);
  const parsed = parseBrain(resolved, ctx, deps);
  const cloud = isCloud(parsed, acp);
  const allowCloud = c.allowCloud === true;
  if (cloud && isLocal(ctx) && !allowCloud) throw new Error(ALLOW_CLOUD_FIRST);
  const custom = parsed as { binary?: string; binary_args?: string[] };
  const provider = acp ? acp.provider : parsed.id === "acp" ? acpProviderOf(custom.binary, custom.binary_args) : CLOUD_CLIS[parsed.id] ?? null;
  return { ...parsed, target, cloud, allowCloud: cloud && allowCloud, provider, ...(acp ? { acp: acp.id } : {}) };
}

export function contributeAgent(ctx: StepContext, c: AgentChoice): Record<string, unknown> {
  if (!("cloud" in c)) return {};
  const { target, cloud: _cloud, allowCloud, provider, acp: _acp, ...parsed } = c;
  const unset = provider ? unsetEnvFor(provider, ctx.choices?.get("accounts") as AccountsChoice | undefined) : [];
  const allowance = allowCloud && isLocal(ctx) ? withAllowance(ctx, "agent") : {};
  if (target === "escalate") {
    const { binary, binary_args } = parsed as { binary: string; binary_args: string[] };
    return { ...allowance, brain: { escalate: { binary, binary_args, ...(unset.length ? { unset_env: unset } : {}) } } };
  }
  const written = contributeBrain(parsed as ReturnType<typeof parseBrain>) as { brain: Record<string, unknown> };
  return { ...allowance, brain: { ...written.brain, ...(unset.length ? { unset_env: unset } : {}) } };
}
