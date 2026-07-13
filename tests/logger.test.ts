import { expect, test } from "bun:test";
import { dashBus } from "../src/dashboard/bus";
import { log, logError, redactLogSecrets } from "../src/logger";

test("redactLogSecrets removes URL query tokens without hiding the endpoint", () => {
  expect(redactLogSecrets("Voice: https://host:8085/?token=super-secret&record=0")).toBe(
    "Voice: https://host:8085/?token=<redacted>&record=0",
  );
});

test("log never exposes a URL token to the console or dashboard history", () => {
  const secret = "unique-dashboard-secret-for-redaction-test";
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    log("ok", `Voice: https://host:8085/?token=${secret}`);
  } finally {
    console.log = original;
  }

  const history = dashBus.snapshot().history ?? [];
  expect(output.join("\n")).not.toContain(secret);
  expect(JSON.stringify(history)).not.toContain(secret);
  expect(output.join("\n")).toContain("?token=<redacted>");
});

test("logError redacts URL tokens from error stacks", () => {
  const secret = "unique-error-stack-secret";
  const output: string[] = [];
  const original = console.error;
  const error = new Error("request failed");
  error.stack = `Error: request failed at https://host:8085/ws?token=${secret}&protocol=2`;
  console.error = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    logError("Web request failed", error);
  } finally {
    console.error = original;
  }

  expect(output.join("\n")).not.toContain(secret);
  expect(output.join("\n")).toContain("?token=<redacted>&protocol=2");
});
