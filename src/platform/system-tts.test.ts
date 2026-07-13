import { test, expect } from "bun:test";
import { buildSystemTts } from "./system-tts";

test("macOS uses the `say` command with the text as an argument", () => {
  const spec = buildSystemTts("hello", "darwin");
  expect(spec.cmd).toEqual(["say", "-r", "200", "--", "hello"]);
  expect(spec.stdinText).toBeUndefined();
});

test("Windows uses PowerShell System.Speech and pipes text via stdin", () => {
  const spec = buildSystemTts("hi there", "win32");
  expect(spec.cmd[0]).toBe("powershell");
  expect(spec.cmd.join(" ")).toContain("System.Speech");
  // text goes through stdin, never interpolated into the command (injection-safe)
  expect(spec.stdinText).toBe("hi there");
  expect(spec.cmd.join(" ")).not.toContain("hi there");
});

test("Linux uses spd-say with the text as an argument", () => {
  const spec = buildSystemTts("hello", "linux");
  expect(spec.cmd).toEqual(["spd-say", "-w", "--", "hello"]);
  expect(spec.stdinText).toBeUndefined();
});

test("unknown platform falls back to the Linux spd-say path", () => {
  const spec = buildSystemTts("hey", "freebsd" as NodeJS.Platform);
  expect(spec.cmd[0]).toBe("spd-say");
});

test("leading-dash speech stays after the platform option boundary", () => {
  expect(buildSystemTts("--voice=attacker", "darwin").cmd)
    .toEqual(["say", "-r", "200", "--", "--voice=attacker"]);
  expect(buildSystemTts("--stop", "linux").cmd)
    .toEqual(["spd-say", "-w", "--", "--stop"]);
});
