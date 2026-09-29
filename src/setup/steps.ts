import type { SetupDraft } from "./draft";
import type { SystemFacts, Tier } from "./system";
import { contributeBoard, contributeSpeech, detectBoard, detectSpeech, parseBoard, parseSpeech, probeBoard, type PickerDeps } from "./pickers";
import { contributeAgent, detectAgent, parseAgent, type AgentChoice } from "./agent";
import { modelBudget, planFit, speechKind, type SpeechKind } from "./fit";
import { isLocal, withAllowance } from "./privacy";
import { detectAccounts, parseAccounts, type AccountsDetected } from "./accounts";
import { contributeFrontDesk, detectFrontDesk, parseFrontDesk, probeFrontDesk, type FrontDeskChoice, type FrontDeskDetected } from "./frontdesk";
import { contributeHelper, detectHelper, parseHelper, probeHelper, type HelperChoice, type HelperDetected } from "./helper";
import { PRIVACY_COPY, PRIVACY_MODES, parsePrivacy, type PrivacyChoice } from "./privacy";

export interface StepContext { system: SystemFacts; draft: SetupDraft; detected?: unknown; choices?: ReadonlyMap<string, unknown> }
export interface StepExplain { what: string; why: string; happens: string; learnMore: string }
export interface SetupStep<Choice = unknown> {
  id: string;
  title: string;
  pipeline?: "mic" | "stt" | "brain" | "tts" | "speaker";
  explain: StepExplain;
  detect(context: StepContext, deps?: PickerDeps): Promise<unknown>;
  parseChoice(raw: unknown, context: StepContext, deps?: PickerDeps): Choice;
  contribute(context: StepContext, choice: Choice): Record<string, unknown>;
  available: boolean;
  probeChoice?(choice: Choice, deps?: PickerDeps): Promise<{ ok: boolean; message: string }>;
  /** Deterministic default choice for `cicero setup --plan`; absent on steps with no choice. */
  recommend?(detected: unknown, context: StepContext): { choice: unknown; reason: string };
}
function step(id: string, title: string, what: string, learnMore: string, pipeline?: SetupStep["pipeline"]): SetupStep {
  return { id, title, pipeline, available: false,
    explain: { what, why: "Coming in a later release.", happens: "This preview does not change configuration for this step.", learnMore },
    async detect() { return null; }, parseChoice() { throw new Error("This step is not available yet"); }, contribute() { return {}; } };
}
const info = (what: string, why: string, happens: string, learnMore: string): StepExplain => ({ what, why, happens, learnMore });
const noop = { async detect() { return null; }, parseChoice() { throw new Error("This step has no choice"); }, contribute() { return {}; } };
export const SETUP_STEPS: readonly SetupStep[] = [
  { id: "privacy", title: "Privacy", available: true, pipeline: "mic",
    explain: info("What may leave this machine?", "Nothing leaves unless you allow it, one item at a time. This is a declared policy that the wizard and cicero doctor enforce, not a firewall: doctor cannot see what a CLI agent does on the network.", "Your answer goes into privacy.", "docs/using.md"),
    async detect() { return { options: ["local", "cloud"], recommended: "local", modes: PRIVACY_MODES, copy: PRIVACY_COPY }; },
    recommend() { return { choice: { mode: "local" }, reason: "Nothing leaves this machine unless you allow it." }; },
    parseChoice: (raw) => parsePrivacy(raw),
    contribute(_ctx, c) { const p = c as PrivacyChoice; return { privacy: p.allow.length ? p : { mode: p.mode } }; } },
  { id: "system", title: "Machine", available: true, pipeline: "mic",
    explain: info("Checks platform, memory, disk, and GPU, and works out how much memory models may use at once.", "The recommended tier follows detected hardware; you can change it. The model budget sizes the helper and a local front desk.", "Read-only hardware checks run. Your choice stays in memory until Save.", "docs/setup.md"),
    async detect(ctx, deps) {
      const kind = await plannedSpeechKind(ctx, deps);
      const budget = modelBudget(ctx.system, kind);
      return { ...ctx.system, budget, fit: budget ? planFit(budget.budgetGb, isLocal(ctx) ? "local" : "cloud") : null };
    },
    recommend(_detected, { system }) { return { choice: system.recommendedTier, reason: system.reason }; },
    parseChoice(raw) { if (!["local-mlx", "local-cuda", "local-cpu"].includes(raw as string)) throw new Error("Choose a supported tier"); return raw as Tier; },
    contribute(_ctx, choice) { return { deployment: choice }; } },
  { id: "accounts", title: "Accounts", available: true, pipeline: "brain",
    explain: info("Shows which login or API key each agent will most likely use, and who bills it.", "An API key in your environment can silently override a subscription login. \"Use my subscription\" removes that key from the agent's environment only, so it falls back to your login.", "Read-only: logins and keys are reported as found or not found, never read or stored. Only your choice is kept.", "docs/setup.md"),
    detect(_ctx, deps) { return detectAccounts(deps); },
    recommend(detected) { const d = detected as AccountsDetected; return { choice: { useSubscription: d.recommended }, reason: d.reason }; },
    parseChoice(raw, ctx) { return parseAccounts(raw, ctx.detected as AccountsDetected | undefined); },
    contribute() { return {}; } },
  { id: "frontdesk", title: "Front desk", available: true, pipeline: "brain",
    explain: info("What answers when you talk: a model (fast, no tools) or an agent (slower, can use tools).", "A local model answers in about a second and hands coding work to your agent. In local privacy mode it must run on this machine.", "Lists models from llama-swap/llama.cpp, Ollama and LM Studio on their default ports. A model choice goes into brain; an agent choice leaves brain to the Agent step.", "docs/setup.md"),
    async detect(ctx, deps) { return detectFrontDesk(ctx, deps, await plannedSpeechKind(ctx, deps)); },
    recommend(detected) { const d = detected as FrontDeskDetected; return { choice: d.recommended, reason: d.reason }; },
    parseChoice: parseFrontDesk, contribute(_ctx, c) { return contributeFrontDesk(c as FrontDeskChoice); },
    probeChoice(c, deps) { return probeFrontDesk(c as FrontDeskChoice, deps); } },
  { id: "helper", title: "Helper", available: true, pipeline: "brain",
    explain: info("A small local model that summarizes long replies and old conversation history.", "It keeps spoken replies short (\"say details\" for the rest) and lets long sessions continue without dropping context. In local privacy mode it is required.", "Lists the same local runtimes as Front desk. Your choice goes into web_voice.tldr, llm and brain.history_compaction.", "docs/setup.md"),
    async detect(ctx, deps) { return detectHelper(ctx, deps, await plannedSpeechKind(ctx, deps)); },
    recommend(detected) { const d = detected as HelperDetected; return { choice: d.recommended, reason: d.reason }; },
    parseChoice: (raw, ctx) => parseHelper(raw, ctx), contribute(ctx, c) { return contributeHelper(ctx, c as HelperChoice); },
    probeChoice(c, deps) { return probeHelper(c as HelperChoice, deps); } },
  { id: "stt", title: "Hear", available: true, pipeline: "stt",
    explain: info("Speech-to-text turns microphone audio into words.", "The hardware tier determines the starting engine; installed venvs and ports are shown.", "Only checks installation and port readiness. The engine choice goes into stt.", "docs/setup.md"),
    detect(ctx, deps) { return detectSpeech("stt", ctx, deps); },
    recommend(detected) { return { choice: { id: (detected as { recommended: string }).recommended }, reason: "Recommended for this machine." }; },
    parseChoice(raw, ctx) { return parseSpeech("stt", raw, ctx); }, contribute(_ctx, c) { return contributeSpeech("stt", c as ReturnType<typeof parseSpeech>); } },
  { id: "tts", title: "Speak", available: true, pipeline: "tts",
    explain: info("Text-to-speech turns replies into audio.", "The hardware tier determines the starting voice engine; voice cloning is optional.", "Only checks installation and port readiness. The engine choice goes into tts.", "docs/voice-cloning.md"),
    detect(ctx, deps) { return detectSpeech("tts", ctx, deps); },
    recommend(detected) { return { choice: { id: (detected as { recommended: string }).recommended }, reason: "Recommended for this machine." }; },
    parseChoice(raw, ctx) { return parseSpeech("tts", raw, ctx); }, contribute(_ctx, c) { return contributeSpeech("tts", c as ReturnType<typeof parseSpeech>); } },
  { id: "brain", title: "Agent", available: true, pipeline: "brain",
    explain: info("A coding agent handles coding work while Cicero carries your voice.", "With a model front desk, the front desk hands a turn to this agent when you say \"think hard\"; that suits one-off deep questions, not follow-ups. With an agent front desk, this agent answers everything.", "Checks PATH and --version; ACP agents stay unverified until their first call. Your choice goes into brain, or brain.escalate with a model front desk.", "docs/brains.md"),
    detect: detectAgent,
    recommend(detected) { const d = detected as Awaited<ReturnType<typeof detectAgent>>; return { choice: { id: d.recommended }, reason: d.reason }; },
    parseChoice: parseAgent, contribute(ctx, c) { return contributeAgent(ctx, c as AgentChoice); } },
  { id: "board", title: "Tasks", available: true, pipeline: "brain",
    explain: info("An optional external board supplies task notifications.", "An installed board CLI is suggested; only one board can be watched.", "A bounded read-only list probe runs; the preset argv goes into notify.kanban.", "docs/notifications.md"),
    detect: detectBoard,
    recommend() { return { choice: { id: "none" }, reason: "Sending task text to a board is your call; add one on the Tasks step." }; },
    parseChoice: parseBoard, contribute(ctx, c) { const board = c as ReturnType<typeof parseBoard>; return board.id === "none" ? {} : { ...withAllowance(ctx, "board"), ...contributeBoard(board) }; }, probeChoice: probeBoard },
  step("channels", "Channels", "Channels carry messages and calls beyond the browser.", "docs/channels.md", "speaker"),
  step("install", "Install", "Selected local engines need their runtime and model files.", "docs/setup.md"),
  { id: "check", title: "Check", available: true, pipeline: "speaker", explain: info("Runs the real Cicero doctor against a private temporary copy of the draft.", "Failures block writing; warnings show what still needs attention.", "The temporary copy is removed after checks finish.", "docs/setup.md"), ...noop },
  { id: "write", title: "Save", available: true, pipeline: "speaker", explain: info("Reviews and writes your private, annotated config.yaml.", "The comments explain each setting for later edits.", "Only a missing config may be written. An invalid existing config needs an explicit backup first.", "docs/setup.md"), ...noop },
  { id: "handoff", title: "Hand-off", available: true, pipeline: "speaker", explain: info("Start Cicero and pair a phone after setup exits.", "The stable web voice token survives daemon restarts.", "This page closes the setup server; it does not start the daemon.", "docs/setup.md"), ...noop },
];

/**
 * The speech stack the model budget reserves memory for: the chosen Hear and
 * Speak engines once both are set, otherwise what those steps would recommend.
 */
export async function plannedSpeechKind(ctx: StepContext, deps?: PickerDeps): Promise<SpeechKind> {
  const stt = (ctx.draft.stt as { backend?: string } | undefined)?.backend;
  const tts = (ctx.draft.tts as { backend?: string } | undefined)?.backend;
  if (stt && tts) return speechKind(ctx.draft.deployment, stt, tts);
  const [hear, speak] = await Promise.all([detectSpeech("stt", ctx, deps), detectSpeech("tts", ctx, deps)]);
  return speechKind(ctx.draft.deployment, stt ?? hear.recommended, tts ?? speak.recommended);
}

/** Steps that take no choice: they are never posted to /api/choice or listed in an answers file. */
export const NO_CHOICE_STEP_IDS: readonly string[] = ["test", "check", "write", "handoff"];
/** Available steps that take a choice, in order: exactly the keys of an answers file. */
export const CHOICE_STEP_IDS: readonly string[] = SETUP_STEPS.filter((item) => item.available && !NO_CHOICE_STEP_IDS.includes(item.id)).map((item) => item.id);
