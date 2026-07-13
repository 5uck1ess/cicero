import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ActionConfigReloader } from "../src/actions-reload";
import { loadActionSnapshot, loadConfig, type RuntimeConfig } from "../src/config";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timed out waiting for actions reload")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function actionDocument(name: string, command: string): string {
  return stringifyYaml({
    actions: {
      [name]: {
        category: "cli",
        command,
        tts_mode: "full",
        examples: [`run ${name}`],
      },
    },
  });
}

describe("ActionConfigReloader", () => {
  let home: string;
  let actionsPath: string;
  let reloader: ActionConfigReloader | null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cicero-actions-reload-"));
    actionsPath = join(home, "actions.yaml");
    reloader = null;
  });

  afterEach(() => {
    reloader?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  function startReloading(
    config: RuntimeConfig,
    onReload: (customCount: number) => void,
    onError: (error: Error) => void = () => {},
  ): void {
    reloader = new ActionConfigReloader(actionsPath, config, {
      debounceMs: 10,
      onReload,
      onError,
    });
    reloader.start();
  }

  test("treats an absent file as built-ins only and rejects ignored or malformed actions", () => {
    const missing = loadActionSnapshot(actionsPath);
    expect(missing.customCount).toBe(0);
    expect(missing.actions.tab_switch).toBeDefined();

    writeFileSync(actionsPath, "version: 1\n");
    expect(() => loadActionSnapshot(actionsPath)).toThrow(
      /version is not supported; actions\.yaml must contain only an actions mapping/,
    );

    for (const document of ["actions:\n", "actions: []\n"]) {
      writeFileSync(actionsPath, document);
      expect(() => loadActionSnapshot(actionsPath)).toThrow(/actions\.yaml#actions[\s\S]*document root must be a mapping/);
    }
  });

  test("deleting a formerly dangerous custom action removes it instead of merging stale state", () => {
    writeFileSync(actionsPath, actionDocument("dangerous_deploy", "rm -rf /srv/app"));
    const config = loadConfig({}, { home });
    expect(config.actions.dangerous_deploy).toBeDefined();
    reloader = new ActionConfigReloader(actionsPath, config);

    writeFileSync(actionsPath, "actions: {}\n");
    expect(reloader.reloadNow()).toBe(true);

    expect(config.actions.dangerous_deploy).toBeUndefined();
    expect(config.actions.tab_switch).toBeDefined();
  });

  test("retains the last-known-good actions when a reload is invalid", () => {
    writeFileSync(actionsPath, actionDocument("safe_before", "echo safe"));
    const config = loadConfig({}, { home });
    let reported: Error | null = null;
    reloader = new ActionConfigReloader(actionsPath, config, {
      onError: (error) => { reported = error; },
    });

    writeFileSync(actionsPath, [
      "actions:",
      "  broken:",
      "    category: executable",
      "    command: 42",
      "    tts_mode: verbose",
      "    examples: nope",
      "    timeout_s: -1",
      "    output_limit: 999999999",
      "",
    ].join("\n"));
    expect(reloader.reloadNow()).toBe(false);

    expect(reported?.message).toMatch(
      /actions\.broken\.category[\s\S]*actions\.broken\.timeout_s[\s\S]*actions\.broken\.output_limit/,
    );
    expect(config.actions.safe_before?.command).toBe("echo safe");
    expect(config.actions.broken).toBeUndefined();
  });

  test("observes an atomic rename replacement through the parent directory", async () => {
    writeFileSync(actionsPath, actionDocument("old_action", "echo old"));
    const config = loadConfig({}, { home });
    const reloaded = deferred<number>();
    startReloading(config, reloaded.resolve);

    const replacement = join(home, ".actions.yaml.new");
    writeFileSync(replacement, actionDocument("new_action", "echo new"));
    renameSync(replacement, actionsPath);
    expect(await within(reloaded.promise)).toBe(1);

    expect(config.actions.old_action).toBeUndefined();
    expect(config.actions.new_action?.command).toBe("echo new");
  });

  test("stop clears a queued reload and blocks late directory events", async () => {
    try {
      writeFileSync(actionsPath, actionDocument("before_stop", "echo before"));
      const config = loadConfig({}, { home });
      let reloads = 0;
      reloader = new ActionConfigReloader(actionsPath, config, {
        debounceMs: 50,
        onReload: () => { reloads += 1; },
      });
      reloader.start();

      writeFileSync(actionsPath, actionDocument("after_stop", "echo after"));
      const internals = reloader as unknown as { timer: ReturnType<typeof setTimeout> | null };
      for (let attempt = 0; attempt < 20 && !internals.timer; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(internals.timer).not.toBeNull();

      reloader.stop();
      expect(internals.timer).toBeNull();
      writeFileSync(join(home, "unrelated.pid"), "gone soon\n");
      await Bun.sleep(80);

      expect(reloads).toBe(0);
      expect(config.actions.before_stop).toBeDefined();
      expect(config.actions.after_stop).toBeUndefined();
    } catch (error: unknown) {
      throw new Error(`reloader stop barrier test failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });

  test("removing actions.yaml drops custom actions back to the built-in snapshot", () => {
    writeFileSync(actionsPath, actionDocument("temporary_action", "echo temporary"));
    const config = loadConfig({}, { home });
    reloader = new ActionConfigReloader(actionsPath, config);

    unlinkSync(actionsPath);
    expect(reloader.reloadNow()).toBe(true);
    expect(config.actions.temporary_action).toBeUndefined();
    expect(config.actions.tab_list).toBeDefined();
  });
});
