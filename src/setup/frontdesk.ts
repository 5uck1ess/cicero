import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "../backends/llm/openai";
import { detectAccounts } from "./accounts";
import { modelBudget, planFit, type FitPlan, type GemmaModel } from "./fit";
import { probeRemoteProviderModels, type PickerDeps } from "./pickers";
import { isLocal } from "./privacy";
import { RUNTIME_ENDPOINTS, RUNTIME_IDS, installHint, listRuntimes, llamaSwapEntry, suggestListedModel, type RuntimeId, type RuntimeListing } from "./runtimes";
import type { StepContext } from "./steps";

/** What answers when you talk: a model (fast, no tools) or an agent (slower, tools). */
export type FrontDeskChoice =
  | { kind: "agent" }
  | { kind: "model"; runtime: RuntimeId; model: string }
  | { kind: "model"; runtime: "cloud"; preset: string; model: string };

export const CLOUD_PRESETS = OPENAI_COMPATIBLE_BACKENDS.filter((id) => id !== "openai-compatible");
const LOCAL_ONLY = "Privacy is local: the front desk must run on this machine";
export const NEEDS_MODEL_FRONT_DESK = "A no-helper setup needs a model front desk";

export interface FrontDeskDetected {
  mode: "local" | "cloud";
  runtimes: Record<RuntimeId, RuntimeListing>;
  cloudPresets: string[];
  cloudKeys: Record<string, "found" | "not found">;
  fit: FitPlan | null;
  recommended: FrontDeskChoice | null;
  /** Cloud mode: the first preset whose key was found. Its model comes from listing it (`/api/provider-models`). */
  cloudSuggestion: string | null;
  reason: string;
  install: { runtime: RuntimeId; hint: string; entry?: string }[];
  disabled: Record<string, string>;
}

function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${name}`);
  return value.trim();
}

/** The fit plan for the current draft; null outside the part 1 hardware scope. */
export function fitFor(ctx: StepContext, speech: Parameters<typeof modelBudget>[1]): FitPlan | null {
  const budget = modelBudget(ctx.system, speech);
  return budget ? planFit(budget.budgetGb, isLocal(ctx) ? "local" : "cloud") : null;
}

function firstRunning(runtimes: Record<RuntimeId, RuntimeListing>): RuntimeListing | null {
  return RUNTIME_IDS.map((id) => runtimes[id]).find((r) => r.running && r.models.length > 0) ?? null;
}

/** Recommend a listed model for a fit target, or a reuse/default when nothing matches. */
export function recommendLocal(runtimes: Record<RuntimeId, RuntimeListing>, target: GemmaModel | null, fallback: GemmaModel | null): { choice: { runtime: RuntimeId; model: string } | null; reason: string } {
  for (const id of RUNTIME_IDS) {
    const r = runtimes[id];
    if (!r.running) continue;
    const listed = target ? suggestListedModel(r.models, target) : null;
    if (listed) return { choice: { runtime: id, model: listed }, reason: `${target!.label} fits this machine and ${RUNTIME_ENDPOINTS[id].label} already serves it.` };
  }
  for (const id of RUNTIME_IDS) {
    const r = runtimes[id];
    if (!r.running) continue;
    const listed = fallback ? suggestListedModel(r.models, fallback) : null;
    if (listed) return { choice: { runtime: id, model: listed }, reason: `${target ? `${target.label} is not listed on ${RUNTIME_ENDPOINTS[id].label} (${installHint(id, target)}). ` : ""}Reusing ${fallback!.label}.` };
  }
  const running = firstRunning(runtimes);
  if (running) return { choice: { runtime: running.id, model: running.models[0]! }, reason: `${target ? `${target.label} is not listed (${installHint(running.id, target)}). ` : "Not sized for this machine. "}Using the first model ${RUNTIME_ENDPOINTS[running.id].label} lists.` };
  return { choice: null, reason: "No local model runtime is running: start llama-swap, Ollama or LM Studio." };
}

export async function detectFrontDesk(ctx: StepContext, deps: PickerDeps = {}, speech: Parameters<typeof modelBudget>[1]): Promise<FrontDeskDetected> {
  const mode = isLocal(ctx) ? "local" : "cloud";
  const [runtimes, accounts] = await Promise.all([listRuntimes(deps), detectAccounts(deps)]);
  const fit = fitFor(ctx, speech);
  const cloudKeys = Object.fromEntries(CLOUD_PRESETS.map((id) => [id, accounts.cloudKeys[id] ?? "not found"])) as Record<string, "found" | "not found">;
  const local = recommendLocal(runtimes, fit?.frontDesk ?? null, fit?.helper ?? null);
  const recommended: FrontDeskChoice | null = local.choice ? { kind: "model", ...local.choice } : null;
  const cloudSuggestion = mode === "cloud" ? CLOUD_PRESETS.find((id) => cloudKeys[id] === "found") ?? null : null;
  const localReason = !fit && !recommended ? "Not sized for this machine. Start Ollama and run ollama pull qwen3.5:0.8b, then check again." : local.reason;
  const reason = cloudSuggestion ? `Your ${cloudSuggestion} key was found: load its models to use it, or keep ${recommended ? "the local model below" : "going once a local runtime runs"}. ${localReason}` : localReason;
  const target = fit?.frontDesk ?? null;
  const install = target ? RUNTIME_IDS.filter((id) => !runtimes[id].running || !suggestListedModel(runtimes[id].models, target))
    .map((id) => ({ runtime: id, hint: installHint(id, target), ...(id === "llama-cpp" ? { entry: llamaSwapEntry(target) } : {}) })) : [];
  return { mode, runtimes, cloudPresets: CLOUD_PRESETS, cloudKeys, fit, recommended, cloudSuggestion, reason, install, disabled: mode === "local" ? { cloud: LOCAL_ONLY } : {} };
}

export function parseFrontDesk(raw: unknown, ctx: StepContext, deps: PickerDeps = {}): FrontDeskChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a front desk");
  const c = raw as Record<string, unknown>;
  if (c.kind === "agent") {
    const helper = ctx.choices?.get("helper") as { id?: string } | undefined;
    if (helper?.id === "none") throw new Error(NEEDS_MODEL_FRONT_DESK);
    return { kind: "agent" };
  }
  if (c.kind !== "model") throw new Error("Choose a model or an agent front desk");
  if (c.runtime === "cloud") {
    if (isLocal(ctx)) throw new Error(LOCAL_ONLY);
    if (typeof c.preset !== "string" || !CLOUD_PRESETS.includes(c.preset)) throw new Error("Choose a supported cloud provider");
    const detected = ctx.detected as FrontDeskDetected | undefined;
    if (detected?.cloudKeys && detected.cloudKeys[c.preset] !== "found")
      throw new Error(`Set ${resolveOpenAiTarget({ backend: c.preset }).apiKeyEnv} in Cicero's environment first`);
    const model = text(c.model, "model");
    if (deps.allowedModels !== undefined && (deps.allowedModels?.id !== c.preset || !deps.allowedModels.models.includes(model)))
      throw new Error("List models from this provider and choose one of them");
    return { kind: "model", runtime: "cloud", preset: c.preset, model };
  }
  if (typeof c.runtime !== "string" || !(RUNTIME_IDS as string[]).includes(c.runtime)) throw new Error("Choose a local model runtime");
  const runtime = c.runtime as RuntimeId;
  const model = text(c.model, "model");
  const detected = ctx.detected as FrontDeskDetected | undefined;
  const listing = detected?.runtimes?.[runtime];
  if (listing && (!listing.running || !listing.models.includes(model))) throw new Error("Start the runtime, load a model, and Re-check before choosing it");
  return { kind: "model", runtime, model };
}

export function contributeFrontDesk(c: FrontDeskChoice): Record<string, unknown> {
  if (c.kind === "agent") return {};
  if (c.runtime === "cloud") return { brain: { backend: c.preset, mode: "subprocess", model: c.model } };
  if (c.runtime === "ollama") return { brain: { backend: "ollama", mode: "subprocess", ollama_model: c.model } };
  return { brain: { backend: "openai-compatible", mode: "subprocess", base_url: RUNTIME_ENDPOINTS[c.runtime].baseUrl, model: c.model } };
}

/** Re-list at choice time: a model that went away, or a cloud model the key can't see, is refused. */
export async function probeFrontDesk(c: FrontDeskChoice, deps: PickerDeps = {}): Promise<{ ok: boolean; message: string }> {
  if (c.kind === "agent") return { ok: true, message: "The Agent step picks the agent" };
  if (c.runtime === "cloud") {
    const env = deps.env ?? process.env;
    const apiKey = env[resolveOpenAiTarget({ backend: c.preset }).apiKeyEnv];
    try {
      const listed = await probeRemoteProviderModels({ id: c.preset, ...(apiKey ? { apiKey } : {}) }, deps);
      return listed.models.includes(c.model) ? { ok: true, message: `${c.preset} serves ${c.model}` } : { ok: false, message: `${c.preset} does not list ${c.model}` };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Could not list models" }; }
  }
  const runtimes = await listRuntimes(deps);
  const r = runtimes[c.runtime];
  if (!r.running) return { ok: false, message: `${RUNTIME_ENDPOINTS[c.runtime].label} is not running` };
  return r.models.includes(c.model) ? { ok: true, message: `${RUNTIME_ENDPOINTS[c.runtime].label} serves ${c.model}` } : { ok: false, message: `${RUNTIME_ENDPOINTS[c.runtime].label} does not list ${c.model}; load it and try again` };
}
