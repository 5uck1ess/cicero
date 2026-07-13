import type { RuntimeConfig } from "../config";
import { sttEndpointKey, type STTProvider, type STTProviderConfig } from "./stt/provider";
import type { TTSProvider, TTSProviderConfig } from "./tts/provider";
import type { LLMProvider } from "./llm/provider";
import { MlxWhisperProvider } from "./stt/mlx-whisper";
import { FasterWhisperProvider } from "./stt/faster-whisper";
import { AudioCppSTTProvider } from "./stt/audiocpp";
import { FallbackSTTProvider } from "./stt/fallback";
import { MlxAudioProvider } from "./tts/mlx-audio";
import { KokoroProvider } from "./tts/kokoro";
import { VibeVoiceProvider } from "./tts/vibevoice";
import { PocketTtsProvider } from "./tts/pocket";
import { AudioCppProvider } from "./tts/audiocpp";
import { ElevenLabsProvider } from "./tts/elevenlabs";
import { FallbackTTSProvider } from "./tts/fallback";
import { WyomingSTTProvider } from "./stt/wyoming";
import { WyomingTTSProvider } from "./tts/wyoming";
import { MlxLmProvider } from "./llm/mlx-lm";
import { OllamaProvider } from "./llm/ollama";
import { LlamaCppProvider } from "./llm/llama-cpp";
import { OpenAiProvider, OPENAI_COMPATIBLE_BACKENDS } from "./llm/openai";
import { voiceProviderContractForBackend, type VoiceProviderContract } from "../voice/provider-contract";
import {
  SUPPORTED_STT_BACKENDS,
  SUPPORTED_TTS_BACKENDS,
  supportedBackendHint,
} from "./supported-backends";

export interface BackendProviders {
  stt: STTProvider;
  tts: TTSProvider;
  llm: LLMProvider;
}

/** A mode may need only part of the stack (for example sidecars need no STT). */
export type BackendProviderSet = Partial<BackendProviders>;

export function createProviders(config: RuntimeConfig): BackendProviders {
  return {
    stt: createSTTProvider(config),
    tts: createTTSProvider(config),
    llm: createLLMProvider(config),
  };
}

export function createSTTProvider(config: RuntimeConfig): STTProvider {
  const primaryConfig = config.sttBackend;
  const primary = buildSTTProvider(primaryConfig, "stt.backend");
  const fallbackConfig = config.sttFallbackBackend;
  if (fallbackConfig) {
    const primaryEndpoint = sttEndpointKey(primaryConfig);
    const fallbackEndpoint = sttEndpointKey(fallbackConfig);
    if (primaryEndpoint !== null && primaryEndpoint === fallbackEndpoint) {
      throw new Error(
        `stt_fallback resolves to the primary STT endpoint (${primaryEndpoint}); configure a distinct host or port`,
      );
    }
    return new FallbackSTTProvider(
      primary,
      buildSTTProvider(fallbackConfig, "stt_fallback.backend"),
    );
  }
  return primary;
}

function buildSTTProvider(sttConfig: STTProviderConfig, configKey: string): STTProvider {
  switch (sttConfig.backend) {
    case "mlx-whisper":
      return new MlxWhisperProvider(sttConfig);
    case "faster-whisper":
      return new FasterWhisperProvider(sttConfig);
    case "audiocpp":
      // STT on the audio.cpp native runtime — the whole voice stack on one
      // server, no Python venv. faster-whisper stays the default; this is opt-in.
      return new AudioCppSTTProvider(sttConfig);
    case "wyoming":
      return new WyomingSTTProvider(sttConfig);
    case "nemotron":
    case "moonshine":
    case "deepgram":
      throw new Error(
        `${configKey}='${sttConfig.backend}' is not implemented; ${supportedBackendHint(configKey, SUPPORTED_STT_BACKENDS)}`,
      );
    default:
      throw new Error(
        `${configKey}='${sttConfig.backend}' is unsupported; ${supportedBackendHint(configKey, SUPPORTED_STT_BACKENDS)}`,
      );
  }
}

export function createTTSProvider(config: RuntimeConfig): TTSProvider {
  const primary = buildTTSProvider(config.ttsBackend, "tts.backend");
  const fallbackConfig = config.ttsFallbackBackend;
  if (fallbackConfig) {
    return new FallbackTTSProvider(
      primary,
      buildTTSProvider(fallbackConfig, "tts_fallback.backend"),
    );
  }
  return primary;
}

function buildTTSProvider(ttsConfig: TTSProviderConfig, configKey: string): TTSProvider {
  const voiceContract = voiceProviderContractForBackend(ttsConfig.backend);
  if (voiceContract) return buildVoiceTTSProvider(voiceContract, ttsConfig);
  switch (ttsConfig.backend) {
    case "mlx-audio":
      return new MlxAudioProvider(ttsConfig);
    case "kokoro":
      return new KokoroProvider(ttsConfig);
    case "wyoming":
      return new WyomingTTSProvider(ttsConfig);
    case "omnivoice":
    case "voxtral":
      throw new Error(
        `${configKey}='${ttsConfig.backend}' is not implemented; ${supportedBackendHint(configKey, SUPPORTED_TTS_BACKENDS)}`,
      );
    default:
      throw new Error(
        `${configKey}='${ttsConfig.backend}' is unsupported; ${supportedBackendHint(configKey, SUPPORTED_TTS_BACKENDS)}`,
      );
  }
}

function buildVoiceTTSProvider(contract: VoiceProviderContract, config: TTSProviderConfig): TTSProvider {
  switch (contract.provider) {
    case "audiocpp":
      return new AudioCppProvider(config);
    case "pocket-tts":
      return new PocketTtsProvider(config);
    case "vibevoice":
      return new VibeVoiceProvider(config);
    case "elevenlabs":
      return new ElevenLabsProvider(config);
    default: {
      const exhaustive: never = contract.provider;
      throw new Error(`Unsupported voice provider contract: ${String(exhaustive)}`);
    }
  }
}

export function createLLMProvider(config: RuntimeConfig): LLMProvider {
  const llmConfig = config.llmBackend;
  // Cloud / paid / remote OpenAI-compatible brains (OpenAI, OpenRouter, Groq,
  // DeepSeek, Qwen/DashScope, Moonshot/Kimi, Zhipu/GLM, MiniMax, …).
  if (OPENAI_COMPATIBLE_BACKENDS.includes(llmConfig.backend ?? "")) {
    return new OpenAiProvider(llmConfig);
  }
  switch (llmConfig.backend) {
    case "mlx-lm":
      return new MlxLmProvider(llmConfig);
    case "ollama":
      return new OllamaProvider(llmConfig);
    case "llama-cpp":
      return new LlamaCppProvider(llmConfig);
    case "claude-api":
      throw new Error(`LLM backend 'claude-api' is not implemented — for a cloud brain use 'openai' (or any OpenAI-compatible preset: deepseek, dashscope, moonshot, zhipu, openrouter, groq); for local use 'mlx-lm'/'ollama'/'llama-cpp'`);
    default:
      throw new Error(`Unknown LLM backend '${llmConfig.backend}'`);
  }
}
