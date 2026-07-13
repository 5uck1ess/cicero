import type { LLMProviderConfig } from "../backends/llm/provider";
import { isKeylessHost } from "../backends/net";
import { OPENAI_COMPATIBLE_BACKENDS } from "../backends/llm/openai";

const CLOUD_CAPABLE_BACKENDS = new Set(OPENAI_COMPATIBLE_BACKENDS);

/**
 * Computer-use observations may contain file contents and command output. Only
 * local/private-LAN model targets are implicit trust boundaries; public/cloud
 * targets require an explicit operator opt-in before the agent loop starts.
 */
export function isLocalComputeTarget(config: LLMProviderConfig): boolean {
  const backend = config.backend ?? "";
  if (CLOUD_CAPABLE_BACKENDS.has(backend)) {
    // A named cloud preset is public by default, but operators may deliberately
    // point the same OpenAI-compatible client at a local/LAN endpoint.
    if (!config.baseUrl) return false;
    try {
      return isKeylessHost(new URL(config.baseUrl).hostname);
    } catch {
      return false;
    }
  }

  // The provider registry maps local backends, an omitted backend, and unknown
  // backend names to a local-server implementation. Match that exact runtime
  // fallback while still refusing a public host supplied to it.
  if (backend === "claude-api") return false;
  return isKeylessHost(config.host);
}
