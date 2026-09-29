import type { PrivacyMode } from "./privacy";
import type { SystemFacts, Tier } from "./system";

/**
 * Hardware-sized model choice for the helper and a local front desk.
 * Footprint = resident memory in llama.cpp with 64k context and q8 KV cache.
 * Tags verified on 2026-09-29: docs/superpowers/plans/2026-09-29-setup-v2-verification.md.
 */
export type GemmaId = "e2b" | "e4b" | "12b" | "26b-a4b" | "31b";
export interface GemmaModel {
  id: GemmaId;
  label: string;
  footprintGb: number;
  basis: "measured" | "estimate";
  hfRepo: string;
  ollamaTag: string | null;
  lmStudioId: string | null;
}

export const GEMMA_MODELS: readonly GemmaModel[] = [
  { id: "e2b", label: "Gemma 4 E2B", footprintGb: 2.5, basis: "estimate", hfRepo: "google/gemma-4-E2B-it-qat-q4_0-gguf", ollamaTag: "gemma4:e2b-it-qat", lmStudioId: "lmstudio-community/gemma-4-E2B-it-QAT-GGUF" },
  { id: "e4b", label: "Gemma 4 E4B", footprintGb: 4, basis: "measured", hfRepo: "google/gemma-4-E4B-it-qat-q4_0-gguf", ollamaTag: "gemma4:e4b-it-qat", lmStudioId: "lmstudio-community/gemma-4-E4B-it-QAT-GGUF" },
  { id: "12b", label: "Gemma 4 12B", footprintGb: 8.5, basis: "estimate", hfRepo: "google/gemma-4-12B-it-qat-q4_0-gguf", ollamaTag: "gemma4:12b-it-qat", lmStudioId: "lmstudio-community/gemma-4-12B-it-QAT-GGUF" },
  { id: "26b-a4b", label: "Gemma 4 26B-A4B", footprintGb: 15, basis: "measured", hfRepo: "google/gemma-4-26B-A4B-it-qat-q4_0-gguf", ollamaTag: "gemma4:26b-a4b-it-qat", lmStudioId: "lmstudio-community/gemma-4-26B-A4B-it-QAT-GGUF" },
  { id: "31b", label: "Gemma 4 31B", footprintGb: 20, basis: "estimate", hfRepo: "google/gemma-4-31B-it-qat-q4_0-gguf", ollamaTag: "gemma4:31b-it-qat", lmStudioId: "lmstudio-community/gemma-4-31B-it-QAT-GGUF" },
];

export type SpeechKind = "audiocpp" | "python" | "mlx";
const EPSILON = 1e-9;
const CUDA_HEADROOM_GB = 1.5;
const MAC_SHARE = 0.6;

/** audio.cpp's measured reservation holds only when both seats run on it. */
export function speechKind(tier: Tier, stt?: string, tts?: string): SpeechKind {
  if (tier === "local-mlx") return "mlx";
  return stt === "audiocpp" && tts === "audiocpp" ? "audiocpp" : "python";
}

export function speechReservationGb(kind: SpeechKind): { gb: number; basis: "measured" | "estimate" } {
  return kind === "audiocpp" ? { gb: 3.5, basis: "measured" } : { gb: 2, basis: "estimate" };
}

export interface Budget {
  platform: "cuda" | "mlx";
  totalGb: number;
  speech: { gb: number; basis: "measured" | "estimate"; kind: SpeechKind };
  headroomGb: number;
  budgetGb: number;
  /** Memory other processes hold now (CUDA only): shown beside the budget, never subtracted. */
  inUseByOthersGb: number | null;
}

/** The memory models may use at once; null outside the part 1 scope (CPU-only, Windows). */
export function modelBudget(system: SystemFacts, kind: SpeechKind): Budget | null {
  const speech = { ...speechReservationGb(kind), kind };
  if (system.platform === "linux" && system.gpu.status === "ok") {
    const totalGb = system.gpu.totalMiB / 1024;
    return { platform: "cuda", totalGb, speech, headroomGb: CUDA_HEADROOM_GB, budgetGb: totalGb - speech.gb - CUDA_HEADROOM_GB, inUseByOthersGb: Math.max(0, (system.gpu.totalMiB - system.gpu.freeMiB) / 1024) };
  }
  if (system.platform === "darwin" && system.arch === "arm64" && system.mlxSupported) {
    const totalGb = system.ramTotalBytes / 1024 ** 3;
    return { platform: "mlx", totalGb, speech, headroomGb: 0, budgetGb: MAC_SHARE * totalGb - speech.gb, inUseByOthersGb: null };
  }
  return null;
}

export interface FitPlan {
  helper: GemmaModel | null;
  frontDesk: GemmaModel | null;
  frontDeskReusesHelper: boolean;
  localHelperImpossible: boolean;
  reason: string;
  /** The memory models may use together on this machine, in GB. */
  budgetGb: number;
}

const fits = (need: number, have: number) => need <= have + EPSILON;
const gb = (n: number) => `${Math.round(n * 10) / 10} GB`;

/**
 * Helper: E4B if it fits, else E2B. Front desk: the largest model larger than the helper that fits beside it.
 * Footprints were measured on CUDA; on any other platform every one is shown as an estimate.
 */
export function planFit(budgetGb: number, mode: PrivacyMode, platform: Budget["platform"] = "cuda"): FitPlan {
  const plan = { ...planFitCuda(budgetGb, mode), budgetGb };
  if (platform === "cuda") return plan;
  const estimate = (m: GemmaModel | null) => m && { ...m, basis: "estimate" as const };
  return { ...plan, helper: estimate(plan.helper), frontDesk: estimate(plan.frontDesk) };
}

function planFitCuda(budgetGb: number, mode: PrivacyMode): Omit<FitPlan, "budgetGb"> {
  const e4b = GEMMA_MODELS.find((m) => m.id === "e4b")!;
  const e2b = GEMMA_MODELS.find((m) => m.id === "e2b")!;
  const helper = fits(e4b.footprintGb, budgetGb) ? e4b : fits(e2b.footprintGb, budgetGb) ? e2b : null;
  if (!helper) {
    return {
      helper: null, frontDesk: null, frontDeskReusesHelper: false, localHelperImpossible: mode === "local",
      reason: mode === "local"
        ? `A ${gb(budgetGb)} budget cannot hold even Gemma 4 E2B (${gb(e2b.footprintGb)}). Choose a smaller speech preset, or switch Privacy to cloud to run without a helper.`
        : `A ${gb(budgetGb)} budget cannot hold a local helper; cloud mode runs without one.`,
    };
  }
  const left = budgetGb - helper.footprintGb;
  const larger = GEMMA_MODELS.filter((m) => m.footprintGb > helper.footprintGb && fits(m.footprintGb, left));
  const frontDesk = larger.at(-1) ?? null;
  return {
    helper, frontDesk: frontDesk ?? helper, frontDeskReusesHelper: frontDesk === null, localHelperImpossible: false,
    reason: frontDesk
      ? `${helper.label} helper (${gb(helper.footprintGb)}) + ${frontDesk.label} front desk (${gb(frontDesk.footprintGb)} of the ${gb(left)} left).`
      : `${helper.label} helper; nothing larger fits in the ${gb(left)} left, so the front desk reuses the helper's instance.`,
  };
}

/** Warnings when stored picks no longer fit, e.g. after a heavier Hear/Speak choice. */
export function fitWarnings(budget: Budget, helper: GemmaModel | null, frontDesk: GemmaModel | null, frontDeskReusesHelper: boolean): string[] {
  const used = (helper?.footprintGb ?? 0) + (frontDesk && !frontDeskReusesHelper ? frontDesk.footprintGb : 0);
  if (fits(used, budget.budgetGb)) return [];
  return [`The chosen models (${gb(used)}) no longer fit the ${gb(budget.budgetGb)} model budget with this speech stack. Pick a smaller front desk or speech preset.`];
}
