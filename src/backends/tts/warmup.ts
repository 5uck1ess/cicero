import type { TTSProvider } from "./provider";
import { log } from "../../logger";

/** Best-effort pre-warm of a TTS provider; never throws. */
export async function warmupProvider(provider: TTSProvider): Promise<void> {
  if (!provider.warmup) return;
  try {
    await provider.warmup();
    log("info", `TTS provider '${provider.name}' warmed up`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("info", `TTS warmup skipped for '${provider.name}': ${msg}`);
  }
}
