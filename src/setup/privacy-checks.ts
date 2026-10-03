import { isLoopbackHost } from "../backends/net";
import { redactSecrets } from "../redact";
import { OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";
import type { Check } from "../cli/doctor";
import type { CiceroConfig } from "../types";
import { isCloudAcpCommand } from "./acp-agents";
import { cloudSpeechBackend } from "../backends/cloud-speech";

/**
 * Doctor warnings for a declared privacy policy. The policy is declared, not
 * enforced on the network: doctor can only compare it with the config.
 */
const AGENT_NOTE = "declared policy; doctor cannot see what a CLI agent does on the network";
const CLOUD_CLIS = new Set(["claude-code", "codex", "gemini", "qwen"]);

const loopbackHost = (host: string) => isLoopbackHost(host);

function loopback(url: string | undefined): boolean {
  if (!url) return false;
  try { return loopbackHost(new URL(url).hostname); } catch { return false; }
}

/** An endpoint as shown in a warning: URL credentials and tokens redacted. */
const shown = (url: string) => redactSecrets(url);

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
      warn("brain endpoint", `Privacy is local, but brain.backend ${backend} sends conversation to ${brain?.base_url ? shown(brain.base_url) : "a cloud API"}.`);
    const llm = raw.llm as { backend?: string; baseUrl?: string; host?: string } | undefined;
    if (llm && ((llm.baseUrl && !loopback(llm.baseUrl)) || (!llm.baseUrl && llm.backend && OPENAI_COMPATIBLE_BACKENDS.includes(llm.backend))))
      warn("llm endpoint", `Privacy is local, but llm sends conversation to ${llm.baseUrl ? shown(llm.baseUrl) : `the ${llm.backend} cloud API`}.`);
    else if (llm?.host && !loopbackHost(llm.host))
      warn("llm endpoint", `Privacy is local, but llm.host is ${shown(llm.host)}, off this machine.`);
    const summarizer = raw.web_voice?.tldr?.summarizer_url;
    if (summarizer && !loopback(summarizer)) warn("helper endpoint", `Privacy is local, but web_voice.tldr.summarizer_url is ${shown(summarizer)}, off this machine.`);
    if (!allow.has("agent")) {
      if (CLOUD_CLIS.has(backend)) warn("agent", `Privacy is local, but brain.backend ${backend} is a cloud agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
      if (backend === "acp" && isCloudAcpCommand(brain?.binary, brain?.binary_args))
        warn("agent", `Privacy is local, but brain runs a cloud ACP agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
      const esc = brain?.escalate;
      if (esc && isCloudAcpCommand(esc.binary, esc.binary_args))
        warn("escalation agent", `Privacy is local, but brain.escalate runs a cloud ACP agent and privacy.allow has no agent; ${AGENT_NOTE}.`);
    }
  }
  // Speech stays on this machine in both modes unless privacy.allow has "speech".
  // Fallback seats count: a cloud fallback sends audio exactly when it is used.
  const speech = [["stt", raw.stt], ["stt_fallback", raw.stt_fallback], ["tts", raw.tts], ["tts_fallback", raw.tts_fallback]] as const;
  const off = speech.filter(([key, c]) => {
    const s = c as { backend?: string; host?: string } | undefined;
    return s && (cloudSpeechBackend(key, s.backend) !== null || (s.host && !loopbackHost(s.host)));
  }).map(([key]) => key);
  if (off.length && !allow.has("speech")) warn("speech", `Privacy says speech stays on this machine, but ${off.join(" and ")} ${off.length > 1 ? "use" : "uses"} a cloud or remote engine and privacy.allow has no speech.`);
  if (raw.notify?.telegram && !allow.has("telegram")) warn("telegram", "notify.telegram is set, but privacy.allow has no telegram: message text goes to Telegram.");
  if (raw.notify?.kanban?.enabled && !allow.has("board")) warn("board", "notify.kanban is enabled, but privacy.allow has no board: task text goes to the board CLI.");
  return checks;
}
