import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config";
import { checkDraft, createDraft, renderDraft } from "../../src/setup/draft";
import { backupInvalidConfig, inspectExistingConfig, writeDraft } from "../../src/setup/write";

const homes: string[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "cicero-setup-test-")); homes.push(path); return path; }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("setup draft and write", () => {
  test("annotated YAML parses exactly and loads through real config", () => {
    const dir = home();
    const draft = createDraft("local-cpu", "a".repeat(64));
    const text = renderDraft(draft);
    expect(parseYaml(text)).toEqual(draft);
    expect(text).toContain("# Stable private pairing credential");
    expect(text).toContain("# Uses the browser microphone and speaker instead of local audio devices.");
    expect(text).toContain("# Chooses subprocess or local-terminal tab injection for the coding agent.");
    expect(draft).toMatchObject({ headless: true, brain: { mode: "subprocess" } });
    writeDraft(dir, draft);
    expect(loadConfig({}, { home: dir }).raw.deployment).toBe("local-cpu");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe(text);
  });
  test("real doctor has no tab-inject failure for the browser-only draft", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 503 });
    try {
      const checks = await checkDraft(createDraft("local-cpu", "c".repeat(64)), {
        platform: "linux", detectedTerminal: "none", which: (binary) => binary === "openssl" ? "/fixture/openssl" : null,
      });
      expect(checks.some((check) => check.name === "brain mode (tab-inject)" && check.level === "fail")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("an invalid draft is rejected by the real loader before Write", async () => {
    const dir = home();
    const draft = createDraft("local-cpu", "too-short");
    await expect(checkDraft(draft)).rejects.toThrow("web_voice.token");
    expect(() => writeDraft(dir, draft)).toThrow("web_voice.token");
    expect(existsSync(join(dir, "config.yaml"))).toBe(false);
  });
  test("valid existing config is refused", () => {
    const dir = home(); const draft = createDraft("local-cpu", "b".repeat(64));
    writeDraft(dir, draft);
    expect(inspectExistingConfig(dir).status).toBe("valid");
    expect(() => writeDraft(dir, draft)).toThrow("already exists and is valid");
  });
  test("bad actions.yaml does not make a valid config eligible for backup", () => {
    const dir = home();
    const configPath = join(dir, "config.yaml");
    writeDraft(dir, createDraft("local-cpu", "d".repeat(64)));
    const original = readFileSync(configPath, "utf8");
    writeFileSync(join(dir, "actions.yaml"), "actionz: {}\nactions: {}\n", { mode: 0o600 });
    const state = inspectExistingConfig(dir);
    expect(state.status).toBe("other-file-error");
    if (state.status === "other-file-error") expect(state.error).toContain("actionz is not supported");
    expect(() => backupInvalidConfig(dir)).toThrow("Only an invalid existing config");
    expect(() => writeDraft(dir, createDraft("local-cpu"))).toThrow("Other Cicero home file is invalid");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
  test("invalid config remains until explicit backup", () => {
    const dir = home(); const path = join(dir, "config.yaml");
    writeFileSync(path, "deployment: broken-tier\n", { mode: 0o600 });
    expect(inspectExistingConfig(dir).status).toBe("invalid");
    expect(() => writeDraft(dir, createDraft("local-cpu"))).toThrow("Use the explicit back up");
    expect(existsSync(path)).toBe(true);
    const backup = backupInvalidConfig(dir, () => Date.UTC(2026, 8, 24));
    expect(readFileSync(backup, "utf8")).toBe("deployment: broken-tier\n");
    expect(inspectExistingConfig(dir).status).toBe("missing");
  });
  test("a config created after the final missing check is not replaced", () => {
    const dir = home();
    const path = join(dir, "config.yaml");
    const competing = "deployment: local-cpu\n# written by another process\n";
    expect(() => writeDraft(dir, createDraft("local-cpu"), {
      beforeCommit: () => writeFileSync(path, competing, { flag: "wx", mode: 0o600 }),
    })).toThrow("config.yaml appeared during setup");
    expect(readFileSync(path, "utf8")).toBe(competing);
  });
  test("an existing backup target is not replaced at the commit boundary", () => {
    const dir = home();
    const path = join(dir, "config.yaml");
    const at = Date.UTC(2026, 8, 24);
    const backup = `${path}.bak-${new Date(at).toISOString().replaceAll(":", "-")}`;
    writeFileSync(path, "deployment: broken-tier\n", { mode: 0o600 });
    expect(() => backupInvalidConfig(dir, () => at, {
      beforeCommit: () => writeFileSync(backup, "existing backup", { flag: "wx", mode: 0o600 }),
    })).toThrow("Backup name already exists");
    expect(readFileSync(backup, "utf8")).toBe("existing backup");
    expect(readFileSync(path, "utf8")).toBe("deployment: broken-tier\n");
  });
  test.skipIf(process.platform === "win32")("never follows or replaces config symlinks", () => {
    const dir = home(); const target = join(dir, "target");
    writeFileSync(target, "untouched", { mode: 0o600 });
    symlinkSync(target, join(dir, "config.yaml"));
    expect(inspectExistingConfig(dir).status).toBe("unsafe");
    expect(() => writeDraft(dir, createDraft("local-cpu"))).toThrow();
    expect(() => backupInvalidConfig(dir)).toThrow();
    expect(lstatSync(join(dir, "config.yaml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
});
