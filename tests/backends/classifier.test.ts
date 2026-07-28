import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClassifierProvider, createProviders } from "../../src/backends/registry";
import { createBackendStartupPolicies } from "../../src/servers/startup-policy";
import { loadConfig as loadConfigRaw } from "../../src/config";
import { validateRuntimeConfig } from "../../src/config-validation";
import { DEFAULT_CONFIG, RuntimeConfig } from "../../src/config";
import { collectChecks } from "../../src/cli/doctor";
import type { LLMBackendConfig } from "../../src/types";

const NO_CONFIG_HOME = join(tmpdir(), "cicero-test-no-config");

/** A config with the classifier section set (or absent when omitted). */
function configWith(classifier?: LLMBackendConfig) {
  const config = loadConfigRaw({}, { home: NO_CONFIG_HOME });
  if (classifier) config.raw.classifier = classifier;
  return config;
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("classifier backend role", () => {
  // Absence must mean "the feature is off", never "borrow the reply model" --
  // a reply-tier model per utterance is exactly the cost this role avoids.
  test("is absent unless configured, and never falls back to the reply model", () => {
    const config = configWith();
    expect(createClassifierProvider(config)).toBeNull();

    const providers = createProviders(config);
    expect(providers.classifier).toBeUndefined();
    expect(providers.llm).toBeDefined();
    // Nothing aliased the reply model into the role.
    expect(providers.classifier as unknown).not.toBe(providers.llm);
  });

  test("is constructed when configured, separately from the reply model", () => {
    const config = configWith({ backend: "llama-cpp", host: "127.0.0.1", port: 8090, model: "small" });
    const providers = createProviders(config);
    expect(providers.classifier).toBeDefined();
    expect(providers.classifier).not.toBe(providers.llm);
  });

  // AGENTS.md: an explicitly configured unsupported backend is an error.
  test("an unsupported backend is an error, not a silent fallback", () => {
    const config = configWith({ backend: "definitely-not-a-backend" });
    expect(() => createClassifierProvider(config)).toThrow(/Unknown classifier backend/);
    // And it blames the classifier key, not llm -- the operator has to know
    // which of the two sections is wrong.
    expect(() => createClassifierProvider(config)).not.toThrow(/llm backend/);
  });

  test("claude-api is rejected for the classifier with a classifier-specific message", () => {
    const config = configWith({ backend: "claude-api" });
    expect(() => createClassifierProvider(config)).toThrow(/classifier backend 'claude-api' is not implemented/);
  });

  // Remote-host and local-managed are different code paths and must be
  // exercised separately (AGENTS.md).
  test("remote-host mode builds against the configured host", async () => {
    let seen = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: "yes" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const config = configWith({ backend: "llama-cpp", host: "classifier-box.local", port: 9099, model: "tiny" });
    const provider = createClassifierProvider(config)!;
    await provider.chatCompletion([{ role: "user", content: "hi" }]);
    expect(seen).toContain("classifier-box.local");
    expect(seen).toContain("9099");
  });

  test("local-managed mode targets localhost and owns a lifecycle", () => {
    const config = configWith({ backend: "mlx-lm", port: 8123, model: "tiny" });
    const provider = createClassifierProvider(config)!;
    expect(provider.name).toBeTruthy();
    // A managed provider is what the ServerManager starts and stops.
    expect(typeof provider.health).toBe("function");
  });
});

describe("classifier startup policy", () => {
  test("there is no policy at all when the role is unconfigured", () => {
    const policies = createBackendStartupPolicies(configWith());
    expect(policies.classifier).toBeUndefined();
  });

  // A per-utterance helper being down must not stop a daemon that can still
  // hold a conversation.
  test("a configured classifier is never a required primary", () => {
    const policies = createBackendStartupPolicies(
      configWith({ backend: "llama-cpp", host: "127.0.0.1", port: 8090 }),
    );
    expect(policies.classifier).toBeDefined();
    expect(policies.classifier?.required).toBe(false);
    expect(policies.classifier?.configKey).toBe("classifier.backend");
  });
});

describe("classifier config validation", () => {
  /** Collect the issues validateRuntimeConfig reports for a classifier section. */
  function issuesFor(classifier: unknown): string[] {
    const config = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    config.classifier = classifier;
    try {
      validateRuntimeConfig(config, "test config");
      return [];
    } catch (error) {
      return String((error as Error).message).split("\n");
    }
  }

  test("a well-formed classifier section is accepted", () => {
    expect(issuesFor({ backend: "llama-cpp", host: "127.0.0.1", port: 8090, model: "tiny" })).toEqual([]);
  });

  // Cicero's validation is fail-fast on unknown keys; the new section must be
  // held to the same standard rather than silently accepting typos.
  test("an unknown key inside classifier is rejected", () => {
    const issues = issuesFor({ backend: "llama-cpp", modle: "typo" });
    expect(issues.some((i) => i.includes("classifier") && i.includes("modle"))).toBe(true);
  });

  test("a non-http baseUrl is rejected", () => {
    expect(issuesFor({ backend: "openai", baseUrl: "ftp://nope" }).some((i) => i.includes("classifier.baseUrl"))).toBe(true);
  });

  test("an out-of-range port is rejected", () => {
    expect(issuesFor({ backend: "llama-cpp", port: 99_999 }).some((i) => i.includes("classifier.port"))).toBe(true);
  });
});

describe("classifier doctor coverage", () => {
  function doctorConfig(classifier?: LLMBackendConfig): RuntimeConfig {
    return new RuntimeConfig({
      ...structuredClone(DEFAULT_CONFIG),
      headless: true,
      classifier,
    });
  }

  // Absence is a valid choice, not a problem to report.
  test("says nothing when the role is unconfigured", async () => {
    const checks = await collectChecks(doctorConfig(), { which: (b: string) => `/mock/${b}` });
    expect(checks.some((check) => check.name.startsWith("classifier"))).toBe(false);
  });

  // Configured-but-unreachable is a problem: features that depend on it will
  // decline turns, and the operator should learn it here rather than from a
  // feature that quietly does nothing.
  test("warns when configured but unreachable, naming classifier.backend", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    const checks = await collectChecks(
      doctorConfig({ backend: "llama-cpp", host: "127.0.0.1", port: 8090, model: "tiny" }),
      { which: (b: string) => `/mock/${b}` },
    );
    const check = checks.find((c) => c.name.startsWith("classifier"));
    expect(check).toBeDefined();
    expect(check!.level).not.toBe("ok");
    // The message must blame the right section; llm and classifier are
    // configured separately and either could be the broken one.
    const text = `${check!.detail ?? ""} ${check!.hint ?? ""}`;
    expect(text).toContain("classifier.backend");
    expect(text).not.toContain("llm.backend");
  });
});
