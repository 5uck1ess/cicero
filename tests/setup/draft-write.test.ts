import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../../src/config";
import { checkDraft, createDraft, renderDraft } from "../../src/setup/draft";
import { backupInvalidConfig, inspectExistingConfig, writeAudioCppServerConfig, writeDraft } from "../../src/setup/write";

const homes: string[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "cicero-setup-test-")); homes.push(path); return path; }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("setup draft and write", () => {
  test("audio.cpp save creates only selected models and merges existing JSON without touching entries", () => {
    const root = home(); mkdirSync(join(root, "servers"));
    const configPath = join(root, "servers", "audiocpp_server.local.json");
    const draft = createDraft("local-cuda", "a".repeat(64));
    draft.stt = { backend: "audiocpp", port: 8092, model: "nemotron" };
    writeDraft(home(), draft, { checkout: root });
    const created = JSON.parse(readFileSync(configPath, "utf8"));
    expect(created.models).toEqual([{ id: "nemotron", family: "nemotron_asr", path: join(root, "vendor", "audio.cpp", "models", "nemotron-3.5-asr-streaming-0.6b"), task: "asr", mode: "offline", session_options: { language: "en-US" } }]);
    expect(created).toMatchObject({ host: "127.0.0.1", port: 8092, device: 0, threads: 1 });
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    const existing = { _comment: "keep me", host: "127.0.0.1", port: 8092, custom: { unknown: true }, models: [{ id: "nemotron", family: "custom", path: "/existing", _comment: "leave this entry" }, { id: "other", task: "asr" }] };
    writeFileSync(configPath, JSON.stringify(existing), { mode: 0o600 });
    draft.tts = { backend: "audiocpp", port: 8092, model: "pocket-tts" };
    writeDraft(home(), draft, { checkout: root });
    const merged = JSON.parse(readFileSync(configPath, "utf8"));
    expect(merged._comment).toBe("keep me");
    expect(merged.custom).toEqual({ unknown: true });
    expect(merged.models.slice(0, 2)).toEqual(existing.models);
    expect(merged.models[2]).toMatchObject({ id: "pocket-tts", family: "pocket_tts", path: join(root, "vendor", "audio.cpp", "models", "pocket-tts"), task: "tts", mode: "offline", load_options: { language: "english" }, session_options: { language: "english", "pocket_tts.voice_state_cache_slots": "16" } });
    writeAudioCppServerConfig(draft, root);
    expect(JSON.parse(readFileSync(configPath, "utf8")).models).toHaveLength(3);
  });
  test.skipIf(process.platform === "win32")("audio.cpp server config refuses symlinks", () => {
    const root = home(); mkdirSync(join(root, "servers"));
    const target = join(root, "target.json"); writeFileSync(target, "untouched");
    symlinkSync(target, join(root, "servers", "audiocpp_server.local.json"));
    const draft = createDraft("local-cuda"); draft.tts = { backend: "audiocpp", port: 8092, model: "pocket-tts" };
    expect(() => writeAudioCppServerConfig(draft, root)).toThrow("unsafe");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
  test.skipIf(process.platform === "win32")("audio.cpp server config refuses a symlinked servers directory", () => {
    const root = home(); const target = home();
    symlinkSync(target, join(root, "servers"));
    const draft = createDraft("local-cuda"); draft.stt = { backend: "audiocpp", port: 8092, model: "nemotron" };
    expect(() => writeAudioCppServerConfig(draft, root)).toThrow("unsafe");
    expect(existsSync(join(target, "audiocpp_server.local.json"))).toBe(false);
  });
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
