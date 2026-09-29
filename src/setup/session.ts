import { checkDraft, createDraft, type SetupDraft } from "./draft";
import { classifySetupChecks } from "./checks";
import { speechKind } from "./fit";
import { chosenFitWarnings } from "./helper";
import { SETUP_STEPS, NO_CHOICE_STEP_IDS, type StepContext } from "./steps";
import type { SystemFacts, Tier } from "./system";
import type { PickerDeps } from "./pickers";
import type { Check, DoctorCheckOptions } from "../cli/doctor";

const STALE_CHOICE = "Another choice changed while this one was being checked. Choose it again.";

/** Choices that shape the config; Accounts and Tasks have safe defaults and may be skipped. */
export const REQUIRED_CHOICES: readonly string[] = ["privacy", "system", "frontdesk", "helper", "stt", "tts", "brain"];

export interface ChoiceResult {
  accepted: boolean;
  probe?: { ok: boolean; message: string };
  /** Earlier choices that no longer parse against the new draft, e.g. a cloud agent after Privacy became local. */
  invalidated: { id: string; reason: string }[];
}

export class DraftChangedError extends Error {
  constructor() { super("Draft changed during Check. Run Check again"); this.name = "DraftChangedError"; }
}

export function mergeDraft<T extends Record<string, unknown>>(base: T, contribution: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(contribution)) {
    const previous = merged[key];
    merged[key] = value && typeof value === "object" && !Array.isArray(value) && previous && typeof previous === "object" && !Array.isArray(previous)
      ? mergeDraft(previous as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return merged as T;
}

/**
 * The wizard's choice → draft → check → write-gate pipeline, shared by the
 * setup page and the headless `cicero setup --plan/--apply` modes so both
 * accept and reject exactly the same choices.
 */
export class SetupSession {
  readonly system: SystemFacts;
  draft: SetupDraft;
  revision = 0;
  /** Parsed choices, in the shape each step's contribute() expects. */
  readonly choices = new Map<string, unknown>();
  /** The raw posted choice (with carried-forward secrets) so later drafts can re-parse it. */
  private readonly raws = new Map<string, unknown>();
  private checks: Check[] | null = null;
  private checksRevision: number | null = null;

  constructor(system: SystemFacts, token?: string, private readonly deps: PickerDeps = {}) {
    this.system = system;
    this.draft = createDraft(system.recommendedTier, token);
  }

  context(detected?: unknown): StepContext {
    return { system: this.system, draft: this.draft, choices: this.choices, ...(detected === undefined ? {} : { detected }) };
  }

  async detect(stepId: string, deps: PickerDeps = this.deps): Promise<unknown> {
    const step = SETUP_STEPS.find((item) => item.id === stepId);
    if (!step) throw new Error("Unknown step");
    return step.detect(this.context(), deps);
  }

  async choose(stepId: string, raw: unknown, options: { deps?: PickerDeps; detected?: unknown; probe: boolean }): Promise<ChoiceResult> {
    const step = SETUP_STEPS.find((item) => item.id === stepId && item.available && !NO_CHOICE_STEP_IDS.includes(item.id));
    if (!step) throw new Error("Unknown setup choice");
    const deps = options.deps ?? this.deps;
    const prior = this.choices.get(step.id);
    const priorRaw = this.raws.get(step.id);
    let rawChoice = raw;
    // Re-posting the same option without re-typing a secret keeps the saved one.
    if (rawChoice && typeof rawChoice === "object" && !Array.isArray(rawChoice)
      && prior && typeof prior === "object"
      && (rawChoice as { id?: string }).id === (prior as { id?: string }).id) {
      if (!(rawChoice as { companyId?: unknown }).companyId && typeof (prior as { companyId?: unknown }).companyId === "string")
        rawChoice = { ...(rawChoice as Record<string, unknown>), companyId: (prior as { companyId: string }).companyId };
      const priorKey = (prior as Record<string, unknown>).apiKey ?? (prior as Record<string, unknown>).api_key
        ?? (priorRaw && typeof priorRaw === "object" ? (priorRaw as Record<string, unknown>).apiKey : undefined);
      if (!(rawChoice as { apiKey?: unknown }).apiKey && typeof priorKey === "string") rawChoice = { ...(rawChoice as Record<string, unknown>), apiKey: priorKey };
    }
    const parsed = step.parseChoice(rawChoice, this.context(options.detected), deps);
    if (parsed && typeof parsed === "object" && prior && typeof prior === "object"
      && (parsed as { id?: string }).id === (prior as { id?: string }).id) {
      for (const key of ["apiKey", "api_key"] as const) {
        if (!(parsed as Record<string, unknown>)[key] && (prior as Record<string, unknown>)[key])
          (parsed as Record<string, unknown>)[key] = (prior as Record<string, unknown>)[key];
      }
    }
    let probe: { ok: boolean; message: string } | undefined;
    if (options.probe && step.probeChoice) {
      // The choice was parsed against this revision; one that lands while the probe runs makes it stale.
      const parsedAt = this.revision;
      probe = await step.probeChoice(parsed, deps);
      if (this.revision !== parsedAt) return { accepted: false, probe: { ok: false, message: STALE_CHOICE }, invalidated: [] };
      if (!probe.ok) return { accepted: false, probe, invalidated: [] };
    }
    this.choices.set(step.id, parsed);
    this.raws.set(step.id, rawChoice);
    const invalidated = this.rebuild(step.id);
    this.revision += 1;
    this.checks = null;
    this.checksRevision = null;
    return { accepted: true, ...(probe ? { probe } : {}), invalidated };
  }

  /** Rebuild the draft in step order, re-validating every other stored choice against it. */
  private rebuild(changed: string): { id: string; reason: string }[] {
    const invalidated: { id: string; reason: string }[] = [];
    this.draft = createDraft((this.choices.get("system") as Tier | undefined) ?? this.system.recommendedTier, this.draft.web_voice.token);
    for (const step of SETUP_STEPS) {
      if (!this.choices.has(step.id)) continue;
      if (step.id !== changed) {
        try {
          const reparsed = step.parseChoice(this.raws.get(step.id), this.context(), this.deps);
          const prior = this.choices.get(step.id);
          // Keep carried-forward secrets that the raw form never held.
          if (reparsed && typeof reparsed === "object" && prior && typeof prior === "object") {
            for (const key of ["apiKey", "api_key"] as const) {
              if (!(reparsed as Record<string, unknown>)[key] && (prior as Record<string, unknown>)[key])
                (reparsed as Record<string, unknown>)[key] = (prior as Record<string, unknown>)[key];
            }
          }
          this.choices.set(step.id, reparsed);
        } catch (error) {
          this.choices.delete(step.id);
          this.raws.delete(step.id);
          invalidated.push({ id: step.id, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      this.draft = mergeDraft(this.draft, step.contribute(this.context(), this.choices.get(step.id))) as SetupDraft;
    }
    return invalidated;
  }

  /** Run Check against the current draft; a choice made meanwhile makes the result stale. */
  async check(run: typeof checkDraft = checkDraft, options?: DoctorCheckOptions): Promise<Check[]> {
    const revision = this.revision;
    this.checks = null;
    this.checksRevision = null;
    const result = [...await run(this.draft, options), ...this.fitChecks()];
    if (revision !== this.revision) throw new DraftChangedError();
    this.checks = result;
    this.checksRevision = revision;
    return result;
  }

  /** Stored model choices that no longer fit the budget for the chosen speech engines (e.g. after switching to audio.cpp). */
  private fitChecks(): Check[] {
    const stt = (this.choices.get("stt") as { id?: string } | undefined)?.id;
    const tts = (this.choices.get("tts") as { id?: string } | undefined)?.id;
    if (!stt || !tts) return [];
    return chosenFitWarnings(this.context(), speechKind(this.draft.deployment, stt, tts)).map((detail) => ({ name: "memory fit", level: "warn" as const, detail }));
  }

  /** Checks for the current draft only; null when none ran or they are stale. */
  currentChecks(): Check[] | null {
    return this.checks === null || this.checksRevision !== this.revision ? null : this.checks;
  }

  /** Titles of required steps with no stored choice, in step order. */
  missingChoices(): string[] {
    return REQUIRED_CHOICES.filter((id) => !this.choices.has(id)).map((id) => SETUP_STEPS.find((s) => s.id === id)!.title);
  }

  writeGate(acknowledgeNotReady: boolean): { ok: true } | { ok: false; error: string } {
    const missing = this.missingChoices();
    if (missing.length) return { ok: false, error: `Choose ${missing.join(", ")} before writing` };
    const checks = this.currentChecks();
    if (checks === null) return { ok: false, error: "Run Check again before writing" };
    const groups = classifySetupChecks(checks);
    if (groups.blocking.length > 0) return { ok: false, error: "Resolve config validity failures before writing" };
    if (groups.notReady.length > 0 && !acknowledgeNotReady) return { ok: false, error: "Acknowledge that runtime components are not ready yet before writing" };
    return { ok: true };
  }
}
