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
const CLOUD_ADAPTER_PACKAGES: Record<string, string> = {
  "@agentclientprotocol/codex-acp": "codex", "@zed-industries/codex-acp": "codex",
  "@agentclientprotocol/claude-agent-acp": "claude", "@zed-industries/claude-code-acp": "claude",
};
// Coding CLIs that speak ACP themselves and always use their vendor's cloud models (docs/brains.md).
const CLOUD_ACP_CLIS: Record<string, string> = { gemini: "gemini", qwen: "qwen" };
const unpinned = (spec: string) => spec.replace(/(.)@[^/@]*$/, "$1");

/** The provider a configured ACP command bills (codex, claude, grok, gemini, qwen), or null for a local or unknown agent. */
export function acpProviderOf(binary: string | undefined, args: readonly string[] | undefined): string | null {
  if (!binary) return null;
  const argv = args ?? [];
  const name = binary.split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, "");
  if (name === "grok") return argv[0] === "agent" ? "grok" : null;
  // Cloud CLIs with their own ACP mode: they reach their vendor's models whatever the flags.
  const cli = CLOUD_ACP_CLIS[name];
  if (cli) return cli;
  for (const part of [binary, ...argv]) { const provider = CLOUD_ADAPTER_PACKAGES[unpinned(part)]; if (provider) return provider; }
  return null;
}

/** True when a configured ACP command runs a known cloud adapter (a package adapter, `grok agent`, or a cloud CLI such as gemini). */
export function isCloudAcpCommand(binary: string | undefined, args: readonly string[] | undefined): boolean {
  return acpProviderOf(binary, args) !== null;
}
