import { PRIVACY_ALLOWANCES } from "../config-validation";
import type { SetupDraft } from "./draft";

export type PrivacyMode = "local" | "cloud";
export type Allowance = (typeof PRIVACY_ALLOWANCES)[number];
export interface PrivacyChoice { mode: PrivacyMode; allow: Allowance[] }

/** What leaves the machine when each item is allowed, in one plain sentence. */
export const PRIVACY_COPY: Record<Allowance, string> = {
  agent: "A cloud coding agent (Claude Code, Codex, Grok) sends your prompts and the code it reads to that company.",
  telegram: "Telegram carries message text.",
  board: "A hosted task board holds task text.",
  speech: "A cloud speech service hears your microphone audio or speaks reply text.",
};

export const PRIVACY_MODES: Record<PrivacyMode, { title: string; detail: string }> = {
  local: { title: "Nothing, unless I allow it", detail: "The front desk, helper and speech run on this machine. Anything else that reaches the network, including a cloud speech service, needs its own allowance." },
  cloud: { title: "Conversation may use cloud models", detail: "The front desk and agents may be cloud services; the helper stays local. Cloud speech, Telegram and task boards still need their own allowance." },
};

export function parsePrivacy(raw: unknown): PrivacyChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose what may leave this machine");
  const { mode, allow } = raw as Record<string, unknown>;
  if (mode !== "local" && mode !== "cloud") throw new Error("Choose what may leave this machine");
  if (allow !== undefined && (!Array.isArray(allow) || allow.some((item) => !(PRIVACY_ALLOWANCES as readonly unknown[]).includes(item))))
    throw new Error(`Allowances must be ${PRIVACY_ALLOWANCES.join(", ")}`);
  return { mode, allow: [...new Set((allow ?? []) as Allowance[])] };
}

/** The draft's privacy policy, or null before the Privacy step is answered. */
export function privacyOf(ctx: { draft: SetupDraft }): PrivacyChoice | null {
  const value = ctx.draft.privacy;
  if (!value || typeof value !== "object") return null;
  const { mode, allow } = value as { mode?: unknown; allow?: unknown };
  if (mode !== "local" && mode !== "cloud") return null;
  return { mode, allow: Array.isArray(allow) ? allow.filter((item): item is Allowance => (PRIVACY_ALLOWANCES as readonly unknown[]).includes(item)) : [] };
}

/** Local mode, or unanswered Privacy (the safe default). */
export function isLocal(ctx: { draft: SetupDraft }): boolean {
  return privacyOf(ctx)?.mode !== "cloud";
}

/** A contribution that adds one allowance to the draft's policy, keeping what is there. */
export function withAllowance(ctx: { draft: SetupDraft }, item: Allowance): { privacy: PrivacyChoice } | Record<string, never> {
  const current = privacyOf(ctx);
  if (!current) return {};
  return { privacy: { mode: current.mode, allow: current.allow.includes(item) ? current.allow : [...current.allow, item] } };
}
