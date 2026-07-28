/**
 * Typing transcribed speech into whatever window has focus.
 *
 * Every platform here drives a synthetic keyboard rather than the clipboard.
 * That is deliberate: the clipboard is shared operator state, and a dictation
 * feature that overwrites whatever you had copied — or worse, restores it a
 * beat late and races a real paste — is a bug that is very hard to attribute.
 *
 * The text being typed is a speech-to-text result: model output, therefore
 * untrusted. It is length-bounded before it reaches a synthetic keyboard, and
 * every platform receives it over stdin rather than argv so there is no shell
 * quoting boundary to get wrong.
 */

/** Cap on a single dictated insert. Long enough for a paragraph, bounded for a synthetic keyboard. */
export const MAX_INJECTED_CHARS = 10_000;

export type InjectionMethod = "applescript" | "sendkeys" | "xdotool";

export type TextInjectionSupport =
  | { kind: "supported"; method: InjectionMethod }
  | { kind: "unsupported"; reason: string; fix?: string };

export interface TextInjectionSpec {
  command: string[];
  /** Script/text delivered on stdin — never argv, so quoting cannot be got wrong. */
  stdin: string;
}

export interface InjectionEnvironment {
  platform?: NodeJS.Platform;
  /** Session type as reported by the desktop (`XDG_SESSION_TYPE`). */
  sessionType?: string;
  /** Set by a Wayland compositor. */
  waylandDisplay?: string;
  /** Resolves whether a helper binary is on PATH. */
  hasBinary?: (name: string) => boolean;
}

/**
 * Decide whether this machine can type into a focused field, and how.
 *
 * Wayland is reported unsupported on purpose. It blocks global synthetic input
 * by design; `xdotool` there silently reaches only XWayland clients, so a
 * "working" injector would type into some apps and quietly do nothing in
 * others. A clear refusal is better than a feature that fails per-window.
 */
export function resolveTextInjection(env: InjectionEnvironment = {}): TextInjectionSupport {
  const platform = env.platform ?? process.platform;
  const hasBinary = env.hasBinary ?? (() => true);

  if (platform === "darwin") return { kind: "supported", method: "applescript" };
  if (platform === "win32") return { kind: "supported", method: "sendkeys" };

  if (platform === "linux") {
    const sessionType = (env.sessionType ?? "").toLowerCase();
    const wayland = sessionType === "wayland" || Boolean(env.waylandDisplay);
    if (wayland) {
      return {
        kind: "unsupported",
        reason: "Wayland blocks synthetic keyboard input to other applications",
        fix: "Log in to an X11/Xorg session for dictation, or run a compositor that exposes a remote-desktop portal. "
          + "ydotool can work but needs a uinput device your user may write to, which is a machine-wide privilege change.",
      };
    }
    if (!hasBinary("xdotool")) {
      return {
        kind: "unsupported",
        reason: "xdotool is not installed",
        fix: "Install it with your package manager (for example: apt install xdotool).",
      };
    }
    return { kind: "supported", method: "xdotool" };
  }

  return { kind: "unsupported", reason: `dictation typing is not implemented for ${platform}` };
}

/**
 * Prepare an STT transcript for a synthetic keyboard.
 *
 * Model output is untrusted, so this normalizes line endings to `\n` (a lone
 * carriage return would sit raw inside an AppleScript string literal and split
 * the statement), drops every other control character, and bounds the length.
 * Tabs and newlines survive because they are legitimate dictated whitespace.
 */
export function boundInjectedText(text: string): { text: string; truncated: boolean } {
  const normalized = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]+/g, "");
  if (normalized.length <= MAX_INJECTED_CHARS) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, MAX_INJECTED_CHARS), truncated: true };
}

/**
 * AppleScript string literals accept only escaped backslashes and quotes, and
 * cannot carry a raw newline — so a multi-line transcript becomes alternating
 * `keystroke "line"` and `keystroke return` statements.
 */
export function appleScriptFor(text: string): string {
  const literal = (line: string): string => `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const statements = text.split("\n").flatMap((line, index) => {
    const parts = index === 0 ? [] : ["\tkeystroke return"];
    if (line.length > 0) parts.push(`\tkeystroke ${literal(line)}`);
    return parts;
  });
  return [
    'tell application "System Events"',
    ...(statements.length > 0 ? statements : ['\tkeystroke ""']),
    "end tell",
    "",
  ].join("\n");
}

/**
 * SendKeys treats `+^%~(){}[]` as syntax, so each must be brace-escaped or it
 * silently becomes a modifier or grouping instruction instead of a character.
 * Newlines become `{ENTER}`.
 */
export function sendKeysFor(text: string): string {
  const escaped = text
    .replace(/[+^%~(){}[\]]/g, (character) => `{${character}}`)
    .replace(/\r\n|\r|\n/g, "{ENTER}");
  // The PowerShell single-quoted string only needs its own quote doubled.
  const powershellLiteral = `'${escaped.replace(/'/g, "''")}'`;
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    `[System.Windows.Forms.SendKeys]::SendWait(${powershellLiteral})`,
    "",
  ].join("\n");
}

/** Build the exact command and stdin payload that types `text` into the focused field. */
export function buildTextInjection(text: string, method: InjectionMethod): TextInjectionSpec {
  switch (method) {
    case "applescript":
      // `osascript -` reads the script from stdin.
      return { command: ["osascript", "-"], stdin: appleScriptFor(text) };
    case "sendkeys":
      // `-Command -` reads the script from stdin; -NoProfile keeps operator profiles out.
      return {
        command: ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"],
        stdin: sendKeysFor(text),
      };
    case "xdotool":
      // `--file -` takes the literal text on stdin, so there is nothing to escape.
      return {
        command: ["xdotool", "type", "--clearmodifiers", "--delay", "12", "--file", "-"],
        stdin: text,
      };
  }
}
