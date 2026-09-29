import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { collectChecks, runDoctor } from "../../src/cli/doctor";

test("doctor --json prints the same checks as collectChecks, with counts, and no key values", async () => {
  const home = mkdtempSync(join(tmpdir(), "cicero-doctor-json-"));
  try {
    writeFileSync(join(home, "config.yaml"), [
      "privacy:", "  mode: local",
      "brain:", "  backend: openai-compatible", "  mode: subprocess", "  base_url: https://example.test/v1", "  model: m", "  api_key: synthetic-doctor-marker-123",
    ].join("\n"));
    const config = loadConfig({}, { home });
    const options = { ciceroHome: home, which: () => null, runCommand: (async () => { throw new Error("no commands in tests"); }) as never, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch };
    const expected = await collectChecks(config, options);
    let printed = "";
    const code = await runDoctor({ json: true, write: (line) => { printed += line; }, checks: () => collectChecks(config, options) });
    const parsed = JSON.parse(printed) as { version: number; checks: unknown[]; fails: number; warns: number };
    expect(parsed.version).toBe(1);
    expect(parsed.checks).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(parsed.fails).toBe(expected.filter((c) => c.level === "fail").length);
    expect(parsed.warns).toBe(expected.filter((c) => c.level === "warn").length);
    expect(code).toBe(parsed.fails ? 1 : 0);
    expect(expected.some((c) => c.name === "privacy: brain endpoint")).toBe(true);
    expect(printed).not.toContain("synthetic-doctor-marker-123");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
