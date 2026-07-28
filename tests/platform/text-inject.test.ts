import { describe, expect, test } from "bun:test";
import {
  MAX_INJECTED_CHARS,
  appleScriptFor,
  boundInjectedText,
  buildTextInjection,
  resolveTextInjection,
  sendKeysFor,
} from "../../src/platform/text-inject";

describe("injection support resolution", () => {
  test("macOS and Windows are supported without a helper binary", () => {
    expect(resolveTextInjection({ platform: "darwin" })).toEqual({ kind: "supported", method: "applescript" });
    expect(resolveTextInjection({ platform: "win32" })).toEqual({ kind: "supported", method: "sendkeys" });
  });

  test("Linux under X11 is supported when xdotool is installed", () => {
    const support = resolveTextInjection({
      platform: "linux",
      sessionType: "x11",
      hasBinary: (name) => name === "xdotool",
    });
    expect(support).toEqual({ kind: "supported", method: "xdotool" });
  });

  test("Linux without xdotool reports an actionable fix rather than failing at type time", () => {
    const support = resolveTextInjection({ platform: "linux", sessionType: "x11", hasBinary: () => false });
    expect(support.kind).toBe("unsupported");
    if (support.kind !== "unsupported") throw new Error("unreachable");
    expect(support.reason).toContain("xdotool");
    expect(support.fix).toContain("install");
  });

  // Wayland must be refused even though xdotool exists there: it would reach
  // XWayland clients only, so dictation would work in some windows and silently
  // do nothing in others. Per-window mystery failure is worse than a clear no.
  test("Wayland is refused even when xdotool is present", () => {
    const bySessionType = resolveTextInjection({
      platform: "linux",
      sessionType: "wayland",
      hasBinary: () => true,
    });
    expect(bySessionType.kind).toBe("unsupported");
    if (bySessionType.kind !== "unsupported") throw new Error("unreachable");
    expect(bySessionType.reason).toContain("Wayland");

    // Detected from the compositor's variable too, not just XDG_SESSION_TYPE.
    const byDisplay = resolveTextInjection({
      platform: "linux",
      waylandDisplay: "wayland-0",
      hasBinary: () => true,
    });
    expect(byDisplay.kind).toBe("unsupported");
  });

  test("an unknown platform is refused by name", () => {
    const support = resolveTextInjection({ platform: "freebsd" as NodeJS.Platform });
    expect(support.kind).toBe("unsupported");
    if (support.kind !== "unsupported") throw new Error("unreachable");
    expect(support.reason).toContain("freebsd");
  });
});

describe("bounding untrusted transcript text", () => {
  test("ordinary text passes through untouched", () => {
    expect(boundInjectedText("hello world")).toEqual({ text: "hello world", truncated: false });
  });

  test("an oversized transcript is truncated and reports it", () => {
    const result = boundInjectedText("x".repeat(MAX_INJECTED_CHARS + 500));
    expect(result.text.length).toBe(MAX_INJECTED_CHARS);
    expect(result.truncated).toBe(true);
  });

  // A lone CR would sit raw inside an AppleScript string literal and split the
  // statement, so line endings are normalized before any script is generated.
  test("carriage returns are normalized to newlines", () => {
    expect(boundInjectedText("a\r\nb\rc").text).toBe("a\nb\nc");
  });

  test("other control characters are dropped, tabs and newlines survive", () => {
    const result = boundInjectedText("safe\u0000\u001b[2J\u0007text\tkept\nkept");
    expect(result.text).toBe("safe[2Jtext\tkept\nkept");
    expect(result.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
  });

  test("a transcript that is only control characters becomes empty", () => {
    expect(boundInjectedText("\u0000\u0007\u001b").text).toBe("");
  });

  test("exactly at the cap is not truncated", () => {
    const result = boundInjectedText("x".repeat(MAX_INJECTED_CHARS));
    expect(result.truncated).toBe(false);
  });
});

describe("AppleScript generation", () => {
  test("quotes and backslashes are escaped so the script cannot be broken out of", () => {
    const script = appleScriptFor('say "hi" \\ then stop');
    expect(script).toContain('keystroke "say \\"hi\\" \\\\ then stop"');
    // The generated script must have balanced tell/end tell regardless of input.
    expect(script.startsWith('tell application "System Events"')).toBe(true);
    expect(script.trimEnd().endsWith("end tell")).toBe(true);
  });

  test("newlines become keystroke return, since AppleScript literals cannot hold one", () => {
    const script = appleScriptFor("first\nsecond");
    expect(script).toContain('keystroke "first"');
    expect(script).toContain("keystroke return");
    expect(script).toContain('keystroke "second"');
    expect(script).not.toMatch(/keystroke "first\nsecond"/);
  });

  test("a blank line emits the return but no empty keystroke", () => {
    const script = appleScriptFor("a\n\nb");
    const returns = script.match(/keystroke return/g) ?? [];
    expect(returns.length).toBe(2);
    expect(script).not.toContain('keystroke ""');
  });
});

describe("SendKeys generation", () => {
  // SendKeys reads +^%~(){}[] as syntax. Unescaped, "100%" would press a modifier
  // and "(" would open a grouping — the text would not arrive as typed.
  test("SendKeys metacharacters are brace-escaped", () => {
    const script = sendKeysFor("50% (a+b) ^x ~y {z} [w]");
    expect(script).toContain("50{%} {(}a{+}b{)} {^}x {~}y {{}z{}} {[}w{]}");
  });

  test("newlines become {ENTER} in all three line-ending forms", () => {
    expect(sendKeysFor("a\nb")).toContain("a{ENTER}b");
    expect(sendKeysFor("a\r\nb")).toContain("a{ENTER}b");
    expect(sendKeysFor("a\rb")).toContain("a{ENTER}b");
  });

  test("a single quote is doubled so the PowerShell literal stays closed", () => {
    const script = sendKeysFor("it's fine");
    expect(script).toContain("'it''s fine'");
  });

  test("the profile is skipped so operator PowerShell config cannot interfere", () => {
    expect(buildTextInjection("hi", "sendkeys").command).toContain("-NoProfile");
  });
});

describe("command construction", () => {
  // Text reaches every platform on stdin, never argv: no shell quoting boundary,
  // and no argv length limit on a long dictation.
  test("every method delivers the payload on stdin, not argv", () => {
    for (const method of ["applescript", "sendkeys", "xdotool"] as const) {
      const spec = buildTextInjection("payload text", method);
      expect(spec.stdin.length).toBeGreaterThan(0);
      expect(spec.command.join(" ")).not.toContain("payload text");
    }
  });

  test("xdotool takes the literal text with nothing to escape", () => {
    const spec = buildTextInjection("weird \"quotes\" and $vars and `ticks`", "xdotool");
    expect(spec.command).toEqual(["xdotool", "type", "--clearmodifiers", "--delay", "12", "--file", "-"]);
    expect(spec.stdin).toBe("weird \"quotes\" and $vars and `ticks`");
  });

  test("osascript reads its script from stdin", () => {
    expect(buildTextInjection("hi", "applescript").command).toEqual(["osascript", "-"]);
  });
});

describe("no control character survives into a generated payload", () => {
  const hostile = "line one\u001b[31m\r\nline\u0000 two\u0007";
  for (const method of ["applescript", "sendkeys", "xdotool"] as const) {
    test(`${method} payload is free of raw control characters`, () => {
      const bounded = boundInjectedText(hostile);
      const spec = buildTextInjection(bounded.text, method);
      // Newlines and tabs are legitimate script/text structure; nothing else.
      const offending = spec.stdin.replace(/[\n\t]/g, "");
      expect(offending).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    });
  }
});
