import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ActionExecutor } from "../../src/executor";
import { compileShellCommand } from "../../src/executor/shell-template";
import { resolveActionCommandLimits } from "../../src/action-command-limits";
import type { RuntimeConfig } from "../../src/config";
import type { ActionConfig, Brain, RouterResult, Speaker, TerminalAdapter } from "../../src/types";
import type { ContextStore } from "../../src/brain/context-store";
import type { LLMProvider } from "../../src/backends/llm/provider";

async function runTemplate(template: string, params: Record<string, string>): Promise<string> {
  try {
    const command = compileShellCommand(template, params);
    const proc = Bun.spawn(["sh", "-c", command.script, "cicero-action", ...command.args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`shell exited ${exitCode}: ${stderr}`);
    return stdout;
  } catch (error) {
    throw new Error(`failed to run compiled action: ${(error as Error).message}`, { cause: error });
  }
}

function makeExecutor(
  category: "terminal" | "cli" | "local",
  command: string,
  brain: Brain = { injectContext: () => {} } as unknown as Brain,
  limits: Pick<ActionConfig, "timeout_s" | "output_limit"> = {},
): ActionExecutor {
  const config = {
    actions: {
      secure_action: {
        category,
        command,
        tts_mode: "full",
        examples: [],
        ...limits,
      },
    },
  } as unknown as RuntimeConfig;
  const unused = {} as unknown;
  return new ActionExecutor(
    config,
    unused as TerminalAdapter,
    brain,
    unused as Speaker,
    unused as ContextStore,
    unused as LLMProvider,
  );
}

function route(category: "terminal" | "cli" | "local", payload: string): RouterResult {
  return {
    intent: "secure_action",
    category,
    params: { payload },
    confidence: 1,
  };
}

describe("compileShellCommand", () => {
  test("keeps adversarial values literal in unquoted, double-quoted, and single-quoted placeholders", async () => {
    try {
      const payload = "voice; $(printf substitution) `printf legacy`\n'quote' \"double\" \\ glob-*";
      const output = await runTemplate(
        `printf '<%s>\\n' {payload}; printf '<%s>\\n' "prefix:{payload}:suffix"; printf '<%s>\\n' 'prefix:{payload}:suffix'`,
        { payload },
      );

      expect(output).toBe(`<${payload}>\n<prefix:${payload}:suffix>\n<prefix:${payload}:suffix>\n`);
    } catch (error) {
      throw new Error("adversarial placeholder test failed", { cause: error });
    }
  });

  test("preserves trusted pipelines and expands every occurrence of a normal placeholder", async () => {
    try {
      const output = await runTemplate(
        `printf '%s|%s\\n' {name} {name} | tr '[:lower:]' '[:upper:]'`,
        { name: "Ada Lovelace" },
      );

      expect(output).toBe("ADA LOVELACE|ADA LOVELACE\n");
    } catch (error) {
      throw new Error("pipeline placeholder test failed", { cause: error });
    }
  });

  test("preserves values inside nested command substitutions", async () => {
    try {
      const payload = "two words glob-*; $(printf nested)";
      const output = await runTemplate(
        `printf '<%s>\\n' "$(printf '%s' {payload})"; printf '<%s>\\n' "\`printf '%s' {payload}\`"`,
        { payload },
      );

      expect(output).toBe(`<${payload}>\n<${payload}>\n`);
    } catch (error) {
      throw new Error("nested substitution placeholder test failed", { cause: error });
    }
  });

  test("does not confuse escaped placeholders or shell parameter expansion with action parameters", () => {
    expect(compileShellCommand(`printf '%s' \\{name}`, { name: "runtime" })).toEqual({
      script: `printf '%s' \\{name}`,
      args: [],
      display: `printf '%s' \\{name}`,
    });
    expect(compileShellCommand(`printf '%s' "\${HOME}"`, { HOME: "runtime" })).toEqual({
      script: `printf '%s' "\${HOME}"`,
      args: [],
      display: `printf '%s' "\${HOME}"`,
    });
  });

  test("keeps case-pattern terminators inside command-substitution context", () => {
    const command = compileShellCommand(
      `printf '<%s>\\n' "$(case {kind} in alpha) printf '%s' {payload} ;; *) printf other ;; esac)"`,
      { kind: "alpha", payload: "two words; literal" },
    );
    // The unparenthesized `alpha)` is a case-arm terminator, not the end of
    // `$()`. The payload must therefore keep its own double-quoted expansion
    // instead of inheriting the outer quote context.
    expect(command.script).toContain(`alpha) printf '%s' "\${2}"`);
  });

  test("describes only used runtime bindings without making them shell source", () => {
    const command = compileShellCommand("search notes for {query} with {api_token}", {
      query: "real\nquery; $(still literal)",
      api_token: "must-not-appear",
      unused: "do not disclose",
    });
    expect(command.display).toBe(
      'search notes for {query} with {api_token} [params: query="real\\nquery; $(still literal)", api_token="[redacted]"]',
    );
    expect(command.display).not.toContain("do not disclose");
    expect(command.display).not.toContain("must-not-appear");
  });
});

for (const category of ["terminal", "cli", "local"] as const) {
  test(`${category} action parameters cannot create shell side effects`, async () => {
    const marker = join(tmpdir(), `cicero-action-injection-${category}-${process.pid}-${crypto.randomUUID()}`);
    const payload = `spoken; printf injected > ${marker}; $(printf substituted > ${marker}); \`printf legacy > ${marker}\`\n'quoted' \"double\"`;

    try {
      const executor = makeExecutor(category, `printf '%s' {payload}`);
      const result = await executor.execute(route(category, payload), payload);

      expect(result.success).toBe(true);
      expect(result.output).toBe(payload);
      expect(existsSync(marker)).toBe(false);
    } catch (error) {
      throw new Error(`${category} action injection test failed`, { cause: error });
    } finally {
      rmSync(marker, { force: true });
    }
  });
}

test("CLI brain context records resolved action parameters", async () => {
  try {
    const contexts: string[] = [];
    const brain = {
      injectContext: (value: string) => { contexts.push(value); },
    } as unknown as Brain;
    const executor = makeExecutor("cli", `printf '%s' {payload}`, brain);

    const result = await executor.execute(route("cli", "the real query"), "the real query");

    expect(result.success).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain('payload="the real query"');
    expect(contexts[0]).toContain("[Output] the real query");
  } catch (error) {
    throw new Error("resolved command context test failed", { cause: error });
  }
});

test("action execution drains verbose stderr concurrently and reports failures", async () => {
  try {
    const verbose = makeExecutor(
      "cli",
      `i=0; while [ "$i" -lt 5000 ]; do printf 'diagnostic-line-0123456789\\n' >&2; i=$((i + 1)); done; printf ok`,
    );
    const completed = await verbose.execute(route("cli", "unused"), "unused");
    expect(completed).toMatchObject({ success: true, output: "ok" });

    const failing = makeExecutor("local", `printf 'specific failure' >&2; exit 7`);
    const failed = await failing.execute(route("local", "unused"), "unused");
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("Exit code 7: specific failure");

    const noisyFailure = makeExecutor(
      "local",
      `printf 'root-cause-marker:' >&2; i=0; while [ "$i" -lt 1200 ]; do printf x >&2; i=$((i + 1)); done; printf ':tail-marker' >&2; exit 9`,
    );
    const noisy = await noisyFailure.execute(route("local", "unused"), "unused");
    expect(noisy.error).toContain("root-cause-marker");
    expect(noisy.error).toContain("diagnostic output truncated");
    expect(noisy.error).toContain("tail-marker");
  } catch (error) {
    throw new Error(`action pipe-drain test failed: ${(error as Error).message}`, { cause: error });
  }
});

test("action output is bounded with explicit truncation metadata", async () => {
  try {
    const executor = makeExecutor(
      "cli",
      `i=0; while [ "$i" -lt 10000 ]; do printf '0123456789'; i=$((i + 1)); done`,
    );
    const result = await executor.execute(route("cli", "unused"), "unused");

    expect(result.success).toBe(true);
    expect(result.output).toEndWith("[stdout truncated]");
    expect(result.output.length).toBeLessThan(66_000);
  } catch (error) {
    throw new Error("default action output bound regression failed", { cause: error });
  }
});

test("a valid long-running action receives its configured absolute budget", () => {
  expect(resolveActionCommandLimits({ timeout_s: 90.5, output_limit: 131072 })).toEqual({
    timeoutMs: 90_500,
    outputLimitBytes: 131072,
  });
});

test("per-action timeout and output overrides remain bounded", async () => {
  try {
    const deadline = makeExecutor(
      "local",
      "sleep 2",
      undefined,
      { timeout_s: 0.02 },
    );
    const timedOut = await deadline.execute(route("local", "unused"), "unused");
    expect(timedOut.success).toBe(false);
    expect(timedOut.error).toContain("20ms wall deadline");
    expect(timedOut.duration_ms).toBeLessThan(1_000);

    const output = makeExecutor(
      "cli",
      `i=0; while [ "$i" -lt 1000 ]; do printf x; i=$((i + 1)); done`,
      undefined,
      { output_limit: 32 },
    );
    const truncated = await output.execute(route("cli", "unused"), "unused");
    expect(truncated.success).toBe(true);
    expect(truncated.output).toBe(`${"x".repeat(32)}\n[stdout truncated]`);
  } catch (error) {
    throw new Error("per-action limit override regression failed", { cause: error });
  }
});

test("invalid programmatic action bounds fail before spawning", async () => {
  const marker = join(tmpdir(), `cicero-invalid-action-limit-${process.pid}-${crypto.randomUUID()}`);
  try {
    const executor = makeExecutor(
      "local",
      `printf spawned > ${marker}`,
      undefined,
      { timeout_s: Number.POSITIVE_INFINITY, output_limit: 32 },
    );
    const result = await executor.execute(route("local", "unused"), "unused");
    expect(result.success).toBe(false);
    expect(result.error).toContain("action timeout_s");
    expect(existsSync(marker)).toBe(false);
  } catch (error) {
    throw new Error("invalid action limit fail-closed regression failed", { cause: error });
  } finally {
    rmSync(marker, { force: true });
  }
});

test("action cancellation terminates and reaps TERM-resistant shell work", async () => {
  try {
    const executor = makeExecutor("local", `trap '' TERM; while :; do :; done`);
    const controller = new AbortController();
    const running = executor.execute(route("local", "unused"), "unused", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("turn cancelled")), 50);
    const result = await running;

    expect(result.success).toBe(false);
    expect(result.error).toContain("command was aborted");
    expect(result.duration_ms).toBeLessThan(1_000);
  } catch (error) {
    throw new Error("action cancellation regression failed", { cause: error });
  }
});
