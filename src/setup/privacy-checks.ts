import { isLocalHost } from "../backends/net";
import { OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";
import type { Check } from "../cli/doctor";
import type { CiceroConfig } from "../types";
import { isCloudAcpCommand } from "./acp-agents";

/**
 * Doctor warnings for a declared privacy policy. The policy is declared, not
 * enforced on the network: doctor can only compare it with the config.
 */
const AGENT_NOTE = "declared policy; doctor cannot see what a CLI agent does on the network";
const CLOUD_CLIS = new Set(["claude-code", "codex", "gemini", "qwen"]);

function loopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return isLocalHost(host) || /^127\./.test(host);
  } catch { return false; }
}

export function privacyChecks(raw: CiceroConfig): Check[] {
  const privacy = raw.privacy;
  if (!privacy) return [];
  const allow = new Set(privacy.allow ?? []);
  const checks: Check[] = [];
  const warn = (item: string, detail: string) => checks.push({ name: `privacy: ${item}`, level: "warn", detail });
  if (privacy.mode === "local") {
    const brain = raw.brain;
    const backend = brain?.backend ?? "";
    if (OPENAI_COMPATIBLE_BACKENDS.includes(backend) && !loopback(brain?.base_url))
      warn("brain endpoint", `Privacy is local, but brain.backend ${backend} sends conversation to ${brain?.base_url ?? "a cloud API"}.`);
    const llm = raw.llm as { backend?: string; baseUrl?: string } | undefined;
    if (llm && ((llm.baseUrl && !loopback(llm.baseUrl)) || (!llm.baseUrl && llm.backend && OPENAI_COMPATIBLE_BACKENDS.includes(llm.backend))))
      warn("llm endpoint", `Privacy is local, but llm sends conversation to ${llm.baseUrl ?? `the ${llm.backend} cloud API`}.`);
    const summarizer = raw.web_voice?.tldr?.summarizer_url;
    if (summarizer && !loopback(summarizer)) warn("helper endpoint", `Privacy is local, but web_voice.tldr.summarizer_url is ${summarizer}, off this machine.`);
    if (!allow.has("agent")) {
      if (CLOUD_CLIS.has(backend)) warn("agent", `Privacy is local, but brain.backend ${backend} is a cloud agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
      if (backend === "acp" && isCloudAcpCommand(brain?.binary, brain?.binary_args))
        warn("agent", `Privacy is local, but brain runs a cloud ACP agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
      const esc = brain?.escalate;
      if (esc && isCloudAcpCommand(esc.binary, esc.binary_args))
        warn("escalation agent", `Privacy is local, but brain.escalate runs a cloud ACP agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
    }
  }
  if (raw.notify?.telegram && !allow.has("telegram")) warn("telegram", "notify.telegram is set, but privacy.allow has no telegram: message text goes to Telegram.");
  if (raw.notify?.kanban?.enabled && !allow.has("board")) warn("board", "notify.kanban is enabled, but privacy.allow has no board: task text goes to the board CLI.");
  return checks;
}
