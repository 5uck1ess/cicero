import { loadConfig } from "../config";
import { redactSnapshotSecrets } from "../operational-state";
import { ACP_AGENTS } from "./agent";
import { classifySetupChecks, type SetupCheckGroups } from "./checks";
import { checkDraft, type SetupDraft } from "./draft";
import { OPENAI_COMPATIBLE_BACKENDS, resolveOpenAiTarget } from "../backends/llm/openai";
import type { FrontDeskDetected } from "./frontdesk";
import type { HelperDetected } from "./helper";
import type { PickerDeps } from "./pickers";
import { runHeadlessProbes, type ProbeOptions, type ProbeResult } from "./probes";
import { draftSecrets, publicChecks, redactStateValue } from "./server";
import { SetupSession } from "./session";
import { CHOICE_STEP_IDS, SETUP_STEPS } from "./steps";
import { detectSystem, type SystemDeps } from "./system";
import { backupInvalidConfig, inspectExistingConfig, writeDraft } from "./write";

/**
 * `cicero setup --plan/--apply/--test`: the wizard's session without the page,
 * so a person's AI agent can set Cicero up and get exactly the same checks.
 */
export interface AnswersFile { version: 1; privacy: { mode: "local" | "cloud"; allow?: string[] }; steps: Record<string, unknown> }
export interface PlanOptions { privacy: "local" | "cloud"; agent?: string; systemDeps?: SystemDeps; pickerDeps?: PickerDeps }
export interface PlanOutput {
  version: 1;
  detected: Record<string, unknown>;
  recommended: AnswersFile;
  reasons: Record<string, string>;
  blocked: { step: string; reason: string; fix: string[] }[];
}
export interface ApplyOptions { home: string; answers: unknown; acknowledgeNotReady: boolean; backupInvalid: boolean; systemDeps?: SystemDeps; pickerDeps?: PickerDeps; check?: typeof checkDraft; now?: () => number }
export interface ApplyOutput { ok: boolean; written?: string; backup?: string; checks: SetupCheckGroups | null; error?: string; step?: string }

const CLOUD_AGENTS = new Set(["claude-code", "codex", "gemini", "qwen", ...ACP_AGENTS.filter((a) => a.cloud).map((a) => a.id)]);

const KEY_VARIABLES = [...new Set([...OPENAI_COMPATIBLE_BACKENDS.map((id) => resolveOpenAiTarget({ backend: id }).apiKeyEnv), "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"])];

/** Exact secret values this run could touch: draft keys plus every API key variable in the environment. */
function secretsOf(draft: SetupDraft, env: Record<string, string | undefined> = process.env): string[] {
  return [...draftSecrets(draft), ...KEY_VARIABLES.map((name) => env[name]).filter((v): v is string => typeof v === "string" && v.length >= 8)];
}

/**
 * Redact exact secret values everywhere (as the setup page does). The broader
 * pattern redaction runs only on free-text error and message fields: on
 * structured fields it would mangle model ids, repos and paths.
 */
function safe<T>(value: T, secrets: readonly string[]): T {
  const scrub = (v: unknown, key?: string): unknown => typeof v === "string" ? (key === "error" || key === "message" ? redactSnapshotSecrets(v) : v)
    : Array.isArray(v) ? v.map((x) => scrub(x)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)])) : v;
  return scrub(redactStateValue(value, secrets)) as T;
}

function fixesFor(step: string, detected: unknown): string[] {
  if (step === "frontdesk" || step === "helper") {
    const d = detected as Partial<FrontDeskDetected & HelperDetected>;
    const install = (d.install ?? []).map((i) => i.entry ? `${i.hint}\n${i.entry}` : i.hint);
    return install.length ? install : ["Start llama-swap, Ollama or LM Studio with a model loaded, then run --plan again."];
  }
  if (step === "brain") return ["Install an agent (see docs/brains.md), or pass --agent <id> with an installed one."];
  return [];
}

export async function planSetup(o: PlanOptions): Promise<PlanOutput> {
  const system = await detectSystem(o.systemDeps);
  const session = new SetupSession(system, undefined, o.pickerDeps);
  const detected: Record<string, unknown> = {};
  const steps: Record<string, unknown> = {};
  const reasons: Record<string, string> = {};
  const blocked: PlanOutput["blocked"] = [];
  for (const id of CHOICE_STEP_IDS) {
    const step = SETUP_STEPS.find((s) => s.id === id)!;
    const found = await session.detect(id, o.pickerDeps);
    detected[id] = found;
    let rec = step.recommend?.(found, session.context(found)) ?? { choice: null, reason: "No recommendation" };
    if (id === "privacy") rec = { choice: { mode: o.privacy }, reason: o.privacy === "local" ? "Nothing leaves this machine unless allowed." : "The front desk and agents may use cloud services." };
    if (id === "board") rec = { choice: { id: "none" }, reason: "Sending task text to a board is your call: add { id, allowBoard: true } yourself." };
    // A CLI agent can't sit behind a model front desk (escalation is ACP only), so it answers directly.
    if (id === "frontdesk" && o.agent && !ACP_AGENTS.some((a) => a.id === o.agent) && o.agent !== "none")
      rec = { choice: { kind: "agent" }, reason: `You chose ${o.agent}, which answers directly; a model front desk can only hand off to an ACP agent.` };
    if (id === "brain" && o.agent) {
      const needsAllow = o.privacy === "local" && CLOUD_AGENTS.has(o.agent);
      rec = { choice: { id: o.agent, ...(needsAllow ? { allowCloud: true } : {}) }, reason: `You chose ${o.agent}.${needsAllow ? " It reaches the cloud, so this adds \"agent\" to privacy.allow." : ""}` };
    }
    reasons[id] = rec.reason;
    // The Agent step's options depend on the front desk; with that blocked, its error is only a consequence.
    const block = (reason: string) => id === "brain" && !steps.frontdesk
      ? blocked.push({ step: id, reason: `Waits for the Front desk step (${reason})`, fix: ["Fix the frontdesk step first, then run --plan again."] })
      : blocked.push({ step: id, reason, fix: fixesFor(id, found) });
    if (rec.choice === null || rec.choice === undefined) { block(rec.reason); continue; }
    try {
      const result = await session.choose(id, rec.choice, { deps: o.pickerDeps, detected: found, probe: false });
      if (!result.accepted) { block(result.probe?.message ?? "Rejected"); continue; }
      steps[id] = rec.choice;
    } catch (error) {
      block(error instanceof Error ? error.message : String(error));
    }
  }
  const privacy = (session.draft.privacy as AnswersFile["privacy"] | undefined) ?? { mode: o.privacy };
  if (steps.privacy) steps.privacy = privacy;
  return safe({ version: 1, detected, recommended: { version: 1, privacy, steps }, reasons, blocked }, secretsOf(session.draft, o.pickerDeps?.env));
}

/** Strict answers-file validation: exactly the choice steps, privacy mirrored. */
export function validateAnswers(raw: unknown): AnswersFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The answers file must be a JSON object");
  const a = raw as Record<string, unknown>;
  if (a.version !== 1) throw new Error("version must be 1");
  if (!a.steps || typeof a.steps !== "object" || Array.isArray(a.steps)) throw new Error("steps must be an object");
  const steps = a.steps as Record<string, unknown>;
  for (const id of Object.keys(steps)) if (!CHOICE_STEP_IDS.includes(id)) throw new Error(`steps.${id} is not accepted`);
  for (const id of CHOICE_STEP_IDS) if (!(id in steps)) throw new Error(`steps.${id} is required`);
  const privacy = steps.privacy as { mode?: unknown; allow?: unknown };
  const top = a.privacy as { mode?: unknown; allow?: unknown } | undefined;
  if (!top || top.mode !== privacy?.mode || JSON.stringify(top.allow ?? []) !== JSON.stringify(privacy?.allow ?? []))
    throw new Error("privacy must equal steps.privacy");
  return { version: 1, privacy: top as AnswersFile["privacy"], steps };
}

export async function applySetup(o: ApplyOptions): Promise<ApplyOutput> {
  let answers: AnswersFile;
  try { answers = validateAnswers(o.answers); }
  catch (error) { return { ok: false, checks: null, error: error instanceof Error ? error.message : String(error) }; }
  const system = await detectSystem(o.systemDeps);
  const session = new SetupSession(system, undefined, o.pickerDeps);
  const fail = (step: string | undefined, error: unknown): ApplyOutput =>
    safe({ ok: false, checks: null, ...(step ? { step } : {}), error: error instanceof Error ? error.message : String(error) }, secretsOf(session.draft, o.pickerDeps?.env));
  for (const id of CHOICE_STEP_IDS) {
    try {
      const found = await session.detect(id, o.pickerDeps);
      const result = await session.choose(id, answers.steps[id], { deps: o.pickerDeps, detected: found, probe: true });
      if (!result.accepted) return fail(id, result.probe?.message ?? "Rejected");
      if (result.invalidated.length) return fail(result.invalidated[0]!.id, result.invalidated[0]!.reason);
    } catch (error) { return fail(id, error); }
  }
  let backup: string | undefined;
  try {
    if (o.backupInvalid && inspectExistingConfig(o.home).status === "invalid") backup = backupInvalidConfig(o.home, o.now);
    const checks = await session.check(o.check);
    const groups = classifySetupChecks(publicChecks(checks, session.draft)!);
    const gate = session.writeGate(o.acknowledgeNotReady);
    if (!gate.ok) return safe({ ok: false, checks: groups, error: gate.error, ...(backup ? { backup } : {}) }, secretsOf(session.draft, o.pickerDeps?.env));
    const written = writeDraft(o.home, session.draft);
    return safe({ ok: true, written, checks: groups, ...(backup ? { backup } : {}) }, secretsOf(session.draft, o.pickerDeps?.env));
  } catch (error) {
    return { ...fail(undefined, error), ...(backup ? { backup } : {}) };
  }
}

/** Run the Test-step probes against a written config. */
export async function testSetup(o: { home: string; timeoutMs?: number; deps?: ProbeOptions["deps"]; signal?: AbortSignal }): Promise<ProbeResult[]> {
  const config = loadConfig({}, { home: o.home });
  const raw = config.raw as unknown as Record<string, unknown>;
  const results = await runHeadlessProbes(raw, { signal: o.signal ?? new AbortController().signal, timeoutMs: o.timeoutMs, deps: o.deps });
  return safe(results, secretsOf(raw as SetupDraft, o.deps?.env));
}
