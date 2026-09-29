import { resolveOpenAiTarget } from "../backends/llm/openai";
import { GEMMA_MODELS, fitWarnings, modelBudget, type FitPlan, type GemmaId, type GemmaModel, type SpeechKind } from "./fit";
import { currentFit, fitFor, recommendLocal, type FrontDeskChoice } from "./frontdesk";
import { LAYA_LANES_REQUIRED, type PickerDeps } from "./pickers";
import { isLocal } from "./privacy";
import { RUNTIME_ENDPOINTS, RUNTIME_IDS, listRuntimes, suggestListedModel, type RuntimeId, type RuntimeListing } from "./runtimes";
import type { StepContext } from "./steps";

/**
 * The helper: a small local model that summarizes long replies and old
 * history, and is the conversational `llm`. It replaces the Router step.
 */
export type HelperChoice = { id: "none" } | { id: "model"; runtime: RuntimeId; model: string; gemma: GemmaId | null; compact: boolean };

const LOCAL_NEEDS_HELPER = "Local mode needs a local helper";
const NO_HELPER_NEEDS_MODEL = "A no-helper setup needs a model front desk";
export const CPU_DEFAULT_MODEL = "qwen3.5:0.8b";

export interface HelperDetected {
  mode: "local" | "cloud";
  runtimes: Record<RuntimeId, RuntimeListing>;
  fit: FitPlan | null;
  recommended: HelperChoice | null;
  reason: string;
  disabled: Record<string, string>;
  warnings: string[];
}

function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${name}`);
  return value.trim();
}

/** The Gemma size a listed model name looks like, for fit warnings. */
export function gemmaOf(model: string): GemmaId | null {
  return GEMMA_MODELS.find((g) => suggestListedModel([model], g))?.id ?? null;
}

const frontDeskOf = (ctx: StepContext) => ctx.choices?.get("frontdesk") as FrontDeskChoice | undefined;
const byId = (id: GemmaId | null | undefined): GemmaModel | null => GEMMA_MODELS.find((g) => g.id === id) ?? null;

/** Warnings when the chosen helper and front desk no longer fit the budget for this speech stack. */
export function chosenFitWarnings(ctx: StepContext, speech: SpeechKind): string[] {
  const budget = modelBudget(ctx.system, speech);
  const helper = ctx.choices?.get("helper") as HelperChoice | undefined;
  const front = frontDeskOf(ctx);
  if (!budget || !helper || helper.id !== "model") return [];
  const localFront = front?.kind === "model" && front.runtime !== "cloud" ? front : null;
  const reuses = Boolean(localFront && localFront.runtime === helper.runtime && localFront.model === helper.model);
  return fitWarnings(budget, byId(helper.gemma), localFront ? byId(gemmaOf(localFront.model)) : null, reuses);
}

export async function detectHelper(ctx: StepContext, deps: PickerDeps = {}, speech: SpeechKind): Promise<HelperDetected> {
  const mode = isLocal(ctx) ? "local" : "cloud";
  const runtimes = await listRuntimes(deps);
  const fit = fitFor(ctx, speech);
  const front = frontDeskOf(ctx);
  const cloudFront = front?.kind === "model" && front.runtime === "cloud";
  const local = recommendLocal(runtimes, fit?.helper ?? null, GEMMA_MODELS.find((g) => g.id === "e2b") ?? null);
  let recommended: HelperChoice | null = local.choice ? { id: "model", ...local.choice, gemma: gemmaOf(local.choice.model), compact: true } : null;
  let reason = local.reason;
  if (!fit && !recommended) reason = `Not sized for this machine. Start Ollama and run ollama pull ${CPU_DEFAULT_MODEL}, then check again.`;
  if (mode === "cloud" && cloudFront && (!recommended || (fit && !fit.helper))) {
    recommended = { id: "none" };
    reason = fit && !fit.helper ? fit.reason : "No local model runtime is running; your cloud front desk also runs the conversation.";
  }
  const disabled: Record<string, string> = { laya: `Needs a checkpoint trained on your roster. ${LAYA_LANES_REQUIRED}` };
  if (mode === "local" && fit?.localHelperImpossible) {
    recommended = null;
    reason = fit.reason;
    disabled.model = fit.reason;
  }
  if (mode === "local") disabled.none = LOCAL_NEEDS_HELPER;
  else if (!cloudFront) disabled.none = NO_HELPER_NEEDS_MODEL;
  return { mode, runtimes, fit, recommended, reason, disabled, warnings: chosenFitWarnings(ctx, speech) };
}

export function parseHelper(raw: unknown, ctx: StepContext): HelperChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a helper");
  const c = raw as Record<string, unknown>;
  const front = frontDeskOf(ctx);
  if (c.id === "none") {
    if (isLocal(ctx)) throw new Error(LOCAL_NEEDS_HELPER);
    if (!(front?.kind === "model" && front.runtime === "cloud")) throw new Error(NO_HELPER_NEEDS_MODEL);
    return { id: "none" };
  }
  if (c.id === "laya") throw new Error(`Laya is not available in this setup. ${LAYA_LANES_REQUIRED}`);
  if (c.id !== "model") throw new Error("Choose a helper model or none");
  if (typeof c.runtime !== "string" || !(RUNTIME_IDS as string[]).includes(c.runtime)) throw new Error("Choose a local model runtime");
  const runtime = c.runtime as RuntimeId;
  const model = text(c.model, "model");
  if (c.compact !== undefined && typeof c.compact !== "boolean") throw new Error("Compress long conversations must be on or off");
  const detected = ctx.detected as HelperDetected | undefined;
  const fit = currentFit(ctx);
  if (isLocal(ctx) && fit?.localHelperImpossible) throw new Error(fit.reason);
  const listing = detected?.runtimes?.[runtime];
  if (listing && (!listing.running || !listing.models.includes(model))) throw new Error("Start the runtime, load a model, and Re-check before choosing it");
  if (listing?.singleModel && front?.kind === "model" && front.runtime === runtime && front.model !== model)
    throw new Error(`${RUNTIME_ENDPOINTS[runtime].label} serves one model here: use ${front.model} for the helper too, or run llama-swap or Ollama to serve two`);
  return { id: "model", runtime, model, gemma: gemmaOf(model), compact: c.compact !== false };
}

export function contributeHelper(ctx: StepContext, c: HelperChoice): Record<string, unknown> {
  if (c.id === "none") {
    const front = frontDeskOf(ctx);
    if (!(front?.kind === "model" && front.runtime === "cloud")) return {};
    const target = resolveOpenAiTarget({ backend: front.preset });
    // An explicit llm keeps the tier preset from adding a local llama-server; the key stays in the environment.
    return { llm: { backend: "openai", baseUrl: target.baseUrl, model: front.model, apiKeyEnv: target.apiKeyEnv } };
  }
  const base = RUNTIME_ENDPOINTS[c.runtime].baseUrl;
  return {
    web_voice: { tldr: { summarizer_url: base, summarizer_model: c.model } },
    llm: { backend: "openai", baseUrl: base, model: c.model },
    ...(c.compact ? { brain: { history_compaction: { enabled: true } } } : {}),
  };
}

/** Re-list at choice time: ok only while the runtime still lists the model. */
export async function probeHelper(c: HelperChoice, deps: PickerDeps = {}): Promise<{ ok: boolean; message: string }> {
  if (c.id === "none") return { ok: true, message: "No helper: long replies end with \"say details\"" };
  const r = (await listRuntimes(deps))[c.runtime];
  const label = RUNTIME_ENDPOINTS[c.runtime].label;
  if (!r.running) return { ok: false, message: `${label} is not running` };
  return r.models.includes(c.model) ? { ok: true, message: `${label} serves ${c.model}` } : { ok: false, message: `${label} does not list ${c.model}; load it and try again` };
}
