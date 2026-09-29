/** An ACP agent the Agent step offers by name. */
export interface AcpAgent { id: string; label: string; command: string[]; cloud: boolean; provider: string | null }

// Commands verified with an ACP initialize on 2026-09-29 (docs/superpowers/plans/2026-09-29-setup-v2-verification.md).
export const ACP_AGENTS: readonly AcpAgent[] = [
  { id: "hermes", label: "Hermes", command: ["hermes", "acp"], cloud: false, provider: null },
  { id: "codex-acp", label: "Codex (ACP adapter)", command: ["bunx", "@agentclientprotocol/codex-acp@2.0.0"], cloud: true, provider: "codex" },
  { id: "claude-acp", label: "Claude Code (ACP adapter)", command: ["bunx", "@agentclientprotocol/claude-agent-acp@0.84.0"], cloud: true, provider: "claude" },
  { id: "grok-acp", label: "Grok (ACP)", command: ["grok", "agent", "stdio"], cloud: true, provider: "grok" },
];

// Package adapters that reach a cloud model, with or without a version pin (older names included).
const CLOUD_ADAPTER_PACKAGES = ["@agentclientprotocol/codex-acp", "@agentclientprotocol/claude-agent-acp", "@zed-industries/codex-acp", "@zed-industries/claude-code-acp"];
const unpinned = (spec: string) => spec.replace(/(.)@[^/@]*$/, "$1");

/** True when a configured ACP command runs a known cloud adapter (a package adapter, or `grok agent`). */
export function isCloudAcpCommand(binary: string | undefined, args: readonly string[] | undefined): boolean {
  if (!binary) return false;
  const argv = args ?? [];
  if (binary === "grok" || binary.endsWith("/grok")) return argv[0] === "agent";
  return [binary, ...argv].some((part) => CLOUD_ADAPTER_PACKAGES.includes(unpinned(part)));
}
