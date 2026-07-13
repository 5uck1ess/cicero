export interface TierConfig {
  stt?: Record<string, unknown>;
  tts?: Record<string, unknown>;
  llm?: Record<string, unknown>;
  terminal?: string;
}

export const TIER_PRESETS: Record<string, TierConfig> = {
  "local-mlx": {
    stt: { backend: "mlx-whisper" },
    tts: { backend: "mlx-audio" },
    llm: { backend: "mlx-lm" },
    // terminal omitted — cascades to DEFAULT_CONFIG.terminal "auto"
  },
  "local-cuda": {
    stt: { backend: "faster-whisper", port: 8083, model: "large-v3-turbo" },
    tts: { backend: "kokoro", port: 8082 },
    // llama.cpp over ollama for the conversational loop: it streams tokens (so
    // the speaker starts on the first sentence) and keeps the model resident (no
    // ollama reload stalls). `model` is a local .gguf path or an HF GGUF repo id
    // (owner/repo[:quant], auto-downloaded via -hf) — pick a quant for your VRAM.
    llm: { backend: "llama-cpp", port: 8080, model: "Qwen/Qwen3.5-4B-Instruct-GGUF:Q4_K_M" },
    terminal: "auto",
  },
  "local-cpu": {
    stt: { backend: "faster-whisper", port: 8083, model: "large-v3-turbo" },
    tts: { backend: "kokoro" },
    llm: { backend: "ollama", port: 11434, model: "qwen3.5:0.8b" },
    terminal: "auto",
  },
  // "hybrid" and "cloud" presets are deferred; Deepgram STT and claude-api
  // still need runtime providers before a complete preset can be advertised.
};
