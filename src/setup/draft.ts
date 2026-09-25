import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../config";
import { collectChecks, type Check, type DoctorCheckOptions } from "../cli/doctor";
import { PRIVATE_FILE_MODE, ensurePrivateDirectorySync } from "../platform/secure-storage";
import type { Tier } from "./system";

export interface SetupDraft {
  deployment: Tier;
  headless: true;
  brain: { mode: "subprocess" | "tab-inject"; [key: string]: unknown };
  web_voice: { enabled: true; token: string };
  [key: string]: unknown;
}

export function createDraft(tier: Tier, token = randomBytes(32).toString("hex")): SetupDraft {
  return { deployment: tier, headless: true, brain: { mode: "subprocess" }, web_voice: { enabled: true, token } };
}

const EXPLANATIONS: Record<string, string> = {
  deployment: "Starting preset for the local speech and language engines.",
  headless: "Uses the browser microphone and speaker instead of local audio devices.",
  brain: "Configures the coding agent Cicero will voice.",
  "brain.mode": "Chooses subprocess or local-terminal tab injection for the coding agent.",
  "brain.backend": "Selects the coding agent adapter.",
  "brain.binary": "Executable used for the ACP agent.",
  "brain.binary_args": "Arguments passed directly to the ACP executable.",
  "brain.base_url": "OpenAI-compatible endpoint for the brain.",
  "brain.model": "Model requested by the brain endpoint.",
  "brain.api_key": "Private authentication key for the brain endpoint.",
  "brain.ollama_model": "Local Ollama model used by the brain.",
  llm: "Configures the conversational language model.",
  "llm.backend": "Selects the language model runtime or API.",
  "llm.model": "Model to load or request.",
  "llm.baseUrl": "Base URL of the OpenAI-compatible language model API.",
  "llm.apiKey": "Private authentication key for the language model API.",
  notify: "Configures optional notifications.",
  "notify.kanban": "Watches one external task board.",
  "notify.kanban.enabled": "Enables task board notifications.",
  "notify.kanban.preset": "Selects the board JSON normalization rules.",
  "notify.kanban.command": "Argv command that lists board tasks as JSON.",
  "notify.kanban.task_command": "Argv prefix that fetches one task's detail.",
  stt: "Configures microphone speech recognition.",
  "stt.backend": "Selects the speech-to-text engine.",
  "stt.host": "Host of an existing Wyoming speech-to-text server.",
  "stt.port": "Port of the speech-to-text server.",
  "stt.model": "Model ID served by the speech-to-text engine.",
  tts: "Configures spoken responses.",
  "tts.backend": "Selects the text-to-speech engine.",
  "tts.host": "Host of an existing Wyoming text-to-speech server.",
  "tts.port": "Port of the text-to-speech server.",
  "tts.model": "Model ID served by the text-to-speech engine.",
  "tts.apiKey": "Private ElevenLabs authentication key.",
  web_voice: "Enables the browser microphone and speaker client.",
  "web_voice.enabled": "Starts web voice with Cicero.",
  "web_voice.token": "Stable private pairing credential; keep this file private.",
};

/** Add one plain-English comment immediately before every leaf and mapping key. */
export function renderDraft(draft: object): string {
  const lines: string[] = [];
  function visit(object: Record<string, unknown>, prefix = "", depth = 0): void {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const indent = "  ".repeat(depth);
      lines.push(`${indent}# ${EXPLANATIONS[path] ?? `Configures ${path.replaceAll("_", " ")}.`}`);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        lines.push(`${indent}${key}:`);
        visit(value as Record<string, unknown>, path, depth + 1);
      } else {
        const serialized = stringifyYaml({ [key]: value }).trimEnd();
        lines.push(serialized.split("\n").map((line) => `${indent}${line}`).join("\n"));
      }
    }
  }
  visit(draft as Record<string, unknown>);
  return `${lines.join("\n")}\n`;
}

export async function checkDraft(draft: SetupDraft, options: DoctorCheckOptions = {}): Promise<Check[]> {
  const home = mkdtempSync(join(tmpdir(), "cicero-setup-check-"));
  try {
    ensurePrivateDirectorySync(home);
    writeFileSync(join(home, "config.yaml"), renderDraft(draft), { flag: "wx", mode: PRIVATE_FILE_MODE });
    const config = loadConfig({}, { home });
    return await collectChecks(config, { ...options, ciceroHome: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
