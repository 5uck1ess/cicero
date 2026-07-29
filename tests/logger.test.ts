import { expect, test } from "bun:test";
import { dashBus } from "../src/dashboard/bus";
import { log, logError, redactLogSecrets } from "../src/logger";
import { clearKnownSecrets, registerKnownSecrets } from "../src/redact";

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

// A remote endpoint routinely quotes the credential it just rejected, that body
// is copied verbatim into the thrown error, and the error message is logged and
// stored in dashboard history. The markers below are synthetic.
test("redactLogSecrets strips a credential reflected back by a provider", () => {
  const cases: Array<[string, string]> = [
    ["classifier returned 401: invalid api key sk-TEST-NOT-A-REAL-KEY-000", "sk-TEST-NOT-A-REAL-KEY-000"],
    ['classifier returned 401: {"error":{"api_key":"TEST-NOT-A-REAL-KEY-000"}}', "TEST-NOT-A-REAL-KEY-000"],
    ["upstream rejected Authorization: Bearer TEST-NOT-A-REAL-KEY-000", "TEST-NOT-A-REAL-KEY-000"],
    ["fetch failed for https://operator:TEST-NOT-A-REAL-PW@host/v1", "TEST-NOT-A-REAL-PW"],
    ["callback https://host/cb?access_token=TEST-NOT-A-REAL-KEY-000&x=1", "TEST-NOT-A-REAL-KEY-000"],
  ];
  for (const [message, secret] of cases) {
    const safe = redactLogSecrets(message);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("<redacted>");
  }
});

// Redaction must not swallow the diagnosis along with the credential.
test("redactLogSecrets leaves ordinary diagnostics intact", () => {
  const message = "classifier returned 503: upstream model qwen3-4b is loading (attempt 2 of 3)";
  expect(redactLogSecrets(message)).toBe(message);
});

// Shape rules cannot catch every key. A configured credential is frequently an
// ordinary-looking string, and a remote 401 routinely quotes the one it just
// rejected -- so the daemon registers what it was configured with.
test("a configured credential is redacted even when it looks like ordinary prose", () => {
  registerKnownSecrets(["correcthorsebattery"]);
  try {
    const safe = redactLogSecrets("classifier returned 401: invalid credential correcthorsebattery");
    expect(safe).not.toContain("correcthorsebattery");
    expect(safe).toContain("<redacted>");
    expect(safe).toContain("invalid credential");
  } finally {
    clearKnownSecrets();
  }
});

test("a registered credential is gone from the console and from dashboard history", () => {
  registerKnownSecrets(["correcthorsebattery"]);
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  try {
    log("warn", "Intent judge unavailable: openai returned 401: invalid credential correcthorsebattery");
  } finally {
    console.log = original;
    clearKnownSecrets();
  }
  const history = dashBus.snapshot().history ?? [];
  expect(output.join(" ")).not.toContain("correcthorsebattery");
  expect(JSON.stringify(history)).not.toContain("correcthorsebattery");
});

// Redacting a two-character "secret" would blank ordinary prose everywhere.
test("a value too short to be a credential is never registered", () => {
  registerKnownSecrets(["ok", "a"]);
  try {
    expect(redactLogSecrets("the server said ok")).toBe("the server said ok");
  } finally {
    clearKnownSecrets();
  }
});
