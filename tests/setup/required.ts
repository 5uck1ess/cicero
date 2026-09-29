import type { PickerDeps } from "../../src/setup/pickers";

/** Deps that let the required choices below pass their probes: Hermes on PATH, Ollama listing Gemma 4 E4B. */
export const requiredDeps: PickerDeps = {
  which: (binary) => binary === "hermes" ? "/usr/bin/hermes" : null,
  fetcher: (async (input: RequestInfo | URL) => String(input).includes("11434")
    ? Response.json({ models: [{ name: "gemma4:e4b-it-qat" }] }) : new Response("down", { status: 503 })) as typeof fetch,
};

/** One valid choice per required step (cloud privacy, so no fit or allowance gate applies). */
export const REQUIRED_ANSWERS: readonly [string, unknown][] = [
  ["privacy", { mode: "cloud" }],
  ["system", "local-cuda"],
  ["frontdesk", { kind: "agent" }],
  ["helper", { id: "model", runtime: "ollama", model: "gemma4:e4b-it-qat" }],
  ["stt", { id: "faster-whisper" }],
  ["tts", { id: "kokoro" }],
  ["brain", { id: "hermes" }],
];
