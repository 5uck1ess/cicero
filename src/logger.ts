import chalk from "chalk";
import { dashBus } from "./dashboard/bus";

type LogIcon = "mic" | "text" | "brain" | "run" | "result" | "speak" | "error" | "warn" | "info" | "ok";

const ICONS: Record<LogIcon, string> = {
  mic: "🎤",
  text: "📝",
  brain: "🧠",
  run: "⚡",
  result: "📋",
  speak: "🔊",
  error: "❌",
  warn: "⚠️",
  info: "ℹ️",
  ok: "✓",
};

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

const QUERY_TOKEN = /([?&]token=)[^&#\s]+/gi;

/** Keep bearer-like URL credentials out of terminal output and dashboard history. */
export function redactLogSecrets(message: string): string {
  return message.replace(QUERY_TOKEN, "$1<redacted>");
}

export function log(icon: LogIcon, message: string): void {
  const safeMessage = redactLogSecrets(message);
  const ts = chalk.gray(`[${timestamp()}]`);
  const ic = ICONS[icon] || "•";
  console.log(`${ts} ${ic} ${safeMessage}`);
  dashBus.log(ic, safeMessage);
}

export function logStep(step: number, total: number, message: string): void {
  const safeMessage = redactLogSecrets(message);
  const ts = chalk.gray(`[${timestamp()}]`);
  const prefix = chalk.cyan(`[${step}/${total}]`);
  console.log(`${ts} ${prefix} ${safeMessage}`);
  dashBus.log("⚙️", safeMessage);
}

export function logError(message: string, error?: Error): void {
  log("error", chalk.red(message));
  if (error?.stack) {
    console.error(chalk.gray(redactLogSecrets(error.stack)));
  }
}

export function logBanner(): void {
  console.log(chalk.bold("\n  Cicero — Voice-Controlled Terminal Assistant\n"));
}
