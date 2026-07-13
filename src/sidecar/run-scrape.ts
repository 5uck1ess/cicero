import type { RuntimeConfig } from "../config";
import { log } from "../logger";
import { runSpeakSidecar } from "./runtime";

export async function runScrapeMode(config: RuntimeConfig, targetTab: string): Promise<void> {
  try {
    log("info", `Starting Cicero in scrape mode (target tab: ${targetTab})`);

    const configured = config.sidecar;
    const sidecarCfg = configured?.backend === "terminal-scrape"
      ? configured
      : {
          backend: "terminal-scrape" as const,
          targetTab,
          pollIntervalMs: 500,
          quietWindowMs: 1500,
        };

    await runSpeakSidecar(config, sidecarCfg);
  } catch (err) {
    log("error", `Scrape mode failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
