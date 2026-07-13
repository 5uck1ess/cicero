import type { AgentAction } from "./actions";
import { isSensitiveReadPath } from "./sensitive-path";

export { isSensitiveReadPath } from "./sensitive-path";

export type ActionDisposition = "allow" | "confirm" | "deny";

const READ_ONLY_TOOLS = new Set(["list_dir", "read_file", "finish"]);
const MUTATING_TOOLS = new Set(["write_file", "shell", "open_app", "browser"]);

// DEFENSE-IN-DEPTH ONLY. The real safety gate is the human confirm step on every
// mutating action (see classifyAction below) — regex shell-parsing can never be
// exhaustive, so this list does not claim to. It hard-stops the most destructive,
// unambiguous commands before they ever reach the confirm prompt.
const DANGEROUS_SHELL = [
  // rm with a recursive/force flag (any order, short bundled or long) aimed at
  // root, home, or a top-level glob — e.g. `rm -rf /`, `rm -fr "/"`, `rm -r -f ~`,
  // `rm -rf /*`. Targeted paths like `rm -rf ./build` fall through to confirm.
  /\brm\b[^|;&\n]*\s-\w*[rf]\w*\b[^|;&\n]*\s["']?(\/|~|\$HOME)\*?["']?(\s|$)/i,
  /\brm\b[^|;&\n]*--(recursive|force)\b[^|;&\n]*\s["']?(\/|~|\$HOME)\*?["']?(\s|$)/i,
  // recursive delete of root/home via find (-delete or -exec)
  /\bfind\s+["']?(\/|~|\$HOME)[^|;&\n]*\s-(delete|exec)\b/i,
  // privilege escalation
  /\b(sudo|doas|pkexec)\b/i,
  // filesystem creation
  /\b(mkfs|newfs)\b/i,
  // raw writes to a block device (dd in either arg order, or shell redirect)
  /\bdd\b[^|;&\n]*\b(if|of)=/i,
  />\s*\/dev\/(sd[a-z]|nvme\d|disk\d)/i,
  // piping a download straight into a shell interpreter
  /\|\s*(sh|bash|zsh|dash)\b/i,
  // fork bomb (tolerant of surrounding whitespace)
  /:\s*\(\s*\)\s*\{[^}]*\|\s*:[^}]*\}\s*;\s*:/,
];

export function classifyAction(action: AgentAction): ActionDisposition {
  if (
    action.tool === "read_file"
    && (action.security?.sensitiveRead === true || isSensitiveReadPath(action.args.path))
  ) return "confirm";
  if (READ_ONLY_TOOLS.has(action.tool)) return "allow";
  if (!MUTATING_TOOLS.has(action.tool)) return "deny";

  if (action.tool === "shell") {
    const command = String(action.args.command ?? "");
    if (DANGEROUS_SHELL.some((pattern) => pattern.test(command))) return "deny";
  }
  return "confirm";
}
