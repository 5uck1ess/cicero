import { fetchLimited, type PickerDeps } from "./pickers";
import type { GemmaModel } from "./fit";

/**
 * Local model runtimes the front desk and helper can use. Cicero does not own
 * or install them in part 1; it only lists what a running runtime serves.
 */
export type RuntimeId = "llama-cpp" | "ollama" | "lm-studio";
export interface RuntimeListing { id: RuntimeId; running: boolean; baseUrl: string; models: string[]; singleModel: boolean; installed: boolean }

export const RUNTIME_ENDPOINTS: Record<RuntimeId, { list: string; baseUrl: string; label: string; binary: string | null }> = {
  // llama-swap and a bare llama-server answer the same probe; the model count tells them apart.
  "llama-cpp": { list: "http://127.0.0.1:8080/v1/models", baseUrl: "http://127.0.0.1:8080/v1", label: "llama-swap / llama.cpp", binary: "llama-server" },
  ollama: { list: "http://127.0.0.1:11434/api/tags", baseUrl: "http://127.0.0.1:11434/v1", label: "Ollama", binary: "ollama" },
  "lm-studio": { list: "http://127.0.0.1:1234/v1/models", baseUrl: "http://127.0.0.1:1234/v1", label: "LM Studio", binary: null },
};
export const RUNTIME_IDS = Object.keys(RUNTIME_ENDPOINTS) as RuntimeId[];

const RUNTIME_START: Record<RuntimeId, string> = {
  "llama-cpp": "llama-server -m your-model.gguf --port 8080",
  ollama: "ollama serve",
  "lm-studio": "lms server start",
};

/** How to start the runtime a local base URL points at (matched by port on a loopback host), or null. */
export function runtimeStartCommand(baseUrl: string): string | null {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return null; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  const id = RUNTIME_IDS.find((r) => new URL(RUNTIME_ENDPOINTS[r].baseUrl).port === url.port);
  return id ? RUNTIME_START[id] : null;
}

export async function listRuntimes(deps: PickerDeps = {}): Promise<Record<RuntimeId, RuntimeListing>> {
  const fetcher = deps.fetcher ?? fetch;
  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const listed = await Promise.all(RUNTIME_IDS.map((id) => fetchLimited(fetcher, RUNTIME_ENDPOINTS[id].list)));
  return Object.fromEntries(RUNTIME_IDS.map((id, index) => {
    const { running, models } = listed[index]!;
    const binary = RUNTIME_ENDPOINTS[id].binary;
    return [id, { id, running, baseUrl: RUNTIME_ENDPOINTS[id].baseUrl, models, singleModel: running && models.length === 1, installed: running || (binary ? Boolean(which(binary)) : false) }];
  })) as Record<RuntimeId, RuntimeListing>;
}

/** A listed model that looks like this Gemma size, e.g. "gemma4:e4b-it-qat" or "gemma4-e4b" for E4B. */
export function suggestListedModel(models: readonly string[], target: GemmaModel): string | null {
  const size = target.id === "26b-a4b" ? "(?:26b-a4b|a4b|26b)" : target.id;
  const pattern = new RegExp(`gemma[-_.:]?4.*(?:^|[^a-z0-9])${size}(?:$|[^a-z0-9])`, "i");
  const exact = [target.ollamaTag, target.lmStudioId].filter((tag): tag is string => Boolean(tag));
  return models.find((m) => exact.includes(m)) ?? models.find((m) => pattern.test(m)) ?? null;
}

/** How to get a fit model onto a runtime that doesn't list it yet. */
export function installHint(runtime: RuntimeId, target: GemmaModel): string {
  if (runtime === "ollama") return target.ollamaTag ? `ollama pull ${target.ollamaTag}` : `No verified Ollama tag for ${target.label}; use llama-swap with ${target.hfRepo}`;
  if (runtime === "lm-studio") return target.lmStudioId ? `In LM Studio, download ${target.lmStudioId}, set context to 65536, and load it` : `No verified LM Studio build of ${target.label}`;
  return `Add ${target.hfRepo} to llama-swap (see the model entry below), then reload llama-swap`;
}

/** A copyable llama-swap entry with the settings the fit table assumes (64k context, q8 KV cache). */
export function llamaSwapEntry(target: GemmaModel): string {
  const name = `gemma-4-${target.id}`;
  return `models:\n  ${name}:\n    cmd: llama-server --port \${PORT} -hf ${target.hfRepo} --host 127.0.0.1 -c 65536 -fa on -ctk q8_0 -ctv q8_0 -ngl 99`;
}
