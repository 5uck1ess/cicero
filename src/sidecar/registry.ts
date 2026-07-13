import type { SidecarConfig, TerminalAdapter } from "../types";
import { ClaudeCodeHookAdapter } from "./claude-code-hook";
import { TerminalScrapeAdapter } from "./terminal-scrape";
import type { SpeakAdapter } from "./types";

const DEFAULT_PROMPT_MARKER = /^> $/m;

export function createSpeakAdapter(
  config: SidecarConfig,
  terminal: TerminalAdapter,
  hookToken?: string,
): SpeakAdapter {
  switch (config.backend) {
    case "claude-code-hook": {
      if (!hookToken) throw new Error("Claude Code hook token is required");
      return new ClaudeCodeHookAdapter({ port: config.port, token: hookToken });
    }
    case "terminal-scrape":
      return new TerminalScrapeAdapter({
        terminal,
        targetTab: config.targetTab,
        pollIntervalMs: config.pollIntervalMs,
        quietWindowMs: config.quietWindowMs,
        promptMarker: config.promptMarker ? new RegExp(config.promptMarker, "m") : DEFAULT_PROMPT_MARKER,
      });
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown sidecar backend: ${JSON.stringify(exhaustive)}`);
    }
  }
}
