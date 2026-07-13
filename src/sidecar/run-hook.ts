import type { RuntimeConfig } from "../config";
import { loadOrCreateHookToken } from "./hook-auth";
import { log } from "../logger";
import { runSpeakSidecar } from "./runtime";

export async function runHookMode(config: RuntimeConfig): Promise<void> {
  try {
    log("info", "Starting Cicero in hook mode (sidecar)");

    const sidecarCfg = config.sidecar ?? { backend: "claude-code-hook" as const, port: 8084 };
    if (sidecarCfg.backend !== "claude-code-hook") {
      throw new Error(
        "`cicero hook` requires sidecar.backend = 'claude-code-hook'. " +
        "For terminal-scrape mode, use `cicero scrape <tab>`.",
      );
    }
    const hookToken = await loadOrCreateHookToken();

    await runSpeakSidecar(config, sidecarCfg, hookToken);
  } catch (err) {
    log("error", `Hook mode failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
