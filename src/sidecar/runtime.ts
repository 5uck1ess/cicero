import type { RuntimeConfig } from "../config";
import type { SidecarConfig } from "../types";
import { createLLMProvider, createTTSProvider } from "../backends/registry";
import { ServerManager, createBackendStartupPolicies } from "../servers";
import { createSpeaker } from "../speaker";
import { createAudioPlayer } from "../platform/audio";
import { createTerminalAdapter } from "../terminal";
import { waitForShutdown } from "../process-lifecycle";
import { createSpeakAdapter } from "./registry";
import { DefaultSpeakService } from "./service";

/** Start a speech-only sidecar without constructing or warming an unused STT provider. */
export async function runSpeakSidecar(
  config: RuntimeConfig,
  sidecar: SidecarConfig,
  hookToken?: string,
): Promise<void> {
  const providers = {
    llm: createLLMProvider(config),
    tts: createTTSProvider(config),
  };
  const startupPolicies = createBackendStartupPolicies(config);
  const servers = new ServerManager();
  const speaker = createSpeaker(config, providers.tts, createAudioPlayer());
  const adapter = createSpeakAdapter(sidecar, createTerminalAdapter(config), hookToken);
  const service = new DefaultSpeakService({
    llm: providers.llm,
    tts: providers.tts,
    speaker,
    summaryMaxTokens: config.ttsSummaryMaxTokens,
  });
  let attached = false;
  let stopped = false;
  let startup: Promise<void> | null = null;

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    if (startup) await startup.catch(() => { /* startup cause is preserved by the caller */ });
    for (const action of [
      async () => { if (attached) await adapter.detach(); },
      async () => { await service.stop(); },
      async () => { await servers.stop(providers); },
    ]) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "sidecar cleanup failed");
  };

  const cancelWait = new AbortController();
  const shutdownWait = waitForShutdown({ stop: shutdown }, process, cancelWait.signal);
  try {
    startup = (async () => {
      try {
        await servers.start(providers, startupPolicies);
        if (stopped) return;
        await adapter.attach(service);
        attached = true;
      } catch (error) {
        throw new Error(`sidecar startup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    })();
    const outcome = await Promise.race([
      startup.then(() => "started" as const),
      shutdownWait.then(() => "stopped" as const),
    ]);
    if (outcome === "started") await shutdownWait;
  } catch (error) {
    await shutdown().catch(() => { /* preserve the startup/runtime cause */ });
    throw new Error(`Sidecar runtime failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    cancelWait.abort();
  }
}
