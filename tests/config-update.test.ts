import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { acquireConfigUpdateLock, loadConfig, updateConfigFields } from "../src/config";

const mode = (file: string): number => statSync(file).mode & 0o777;

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

describe("updateConfigFields", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cicero-cfg-"));
    path = join(dir, "config.yaml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeParticipantOwner(pid: number, identity?: string): string {
    const token = crypto.randomUUID();
    const ownerPath = `${path}.update-lock-${pid}-${token}.owner.json`;
    writeFileSync(ownerPath, JSON.stringify({
      pid,
      token,
      acquiredAtMs: 0,
      ticket: Number.MAX_SAFE_INTEGER,
      ...(identity ? { identity } : {}),
    }));
    return ownerPath;
  }

  test("writes fields to a fresh config file", async () => {
    updateConfigFields({ voice: "jarvis", voice_ref_audio: "/v/jarvis.wav" }, path);
    expect(existsSync(path)).toBe(true);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.voice).toBe("jarvis");
    expect(parsed.voice_ref_audio).toBe("/v/jarvis.wav");
  });

  test("merges into existing config without clobbering other keys", async () => {
    updateConfigFields({ voice: "jarvis", tts_enabled: true }, path);
    updateConfigFields({ voice: "athena" }, path);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.voice).toBe("athena"); // overwritten
    expect(parsed.tts_enabled).toBe(true); // preserved
  });

  test("a concurrent config command reads after an in-progress swap commit", async () => {
    updateConfigFields({
      voice: "old-voice",
      stt: { backend: "faster-whisper", model: "old-model" },
    }, path);

    const lock = acquireConfigUpdateLock(path);
    const configModule = new URL("../src/config.ts", import.meta.url).href;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { updateConfigFields } from ${JSON.stringify(configModule)};`,
        `process.stdout.write("ready\\n");`,
        `updateConfigFields({ voice: "new-voice" }, process.env.CICERO_TEST_CONFIG_PATH);`,
        `process.stdout.write("done\\n");`,
      ].join("\n"),
    ], {
      env: { ...process.env, CICERO_TEST_CONFIG_PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (!output.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, { stream: true });
      }
      expect(output.split("\n")[0]).toBe("ready");

      // Model the swap's atomic rename while it owns the same lease. The voice
      // command cannot have taken its stale snapshot yet.
      writeFileSync(path, stringifyYaml({
        voice: "old-voice",
        stt: { backend: "faster-whisper", model: "new-model" },
      }));
    } finally {
      lock.release();
    }
    const exitCode = await child.exited;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    reader.releaseLock();

    expect(exitCode).toBe(0);
    expect(output).toContain("done");
    expect(parseYaml(readFileSync(path, "utf8"))).toMatchObject({
      voice: "new-voice",
      stt: { backend: "faster-whisper", model: "new-model" },
    });
  });

  test("a crashed writer's stale lease does not block the next config update", () => {
    const lockPath = `${path}.update-lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "synthetic-stale-owner",
      acquiredAtMs: 0,
    }));

    updateConfigFields({ voice: "recovered" }, path);

    expect(parseYaml(readFileSync(path, "utf8")).voice).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("two racing stale takeovers serialize their config commits", async () => {
    const lockPath = `${path}.update-lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      token: "synthetic-stale-owner",
      acquiredAtMs: 0,
    }));
    writeFileSync(path, "{}\n");

    const gate = join(dir, "lease-race");
    const configModule = new URL("../src/config.ts", import.meta.url).href;
    const yamlModule = new URL("../node_modules/yaml/dist/index.js", import.meta.url).href;
    const script = [
      `import { readFileSync, renameSync, writeFileSync } from "node:fs";`,
      `import { acquireConfigUpdateLock } from ${JSON.stringify(configModule)};`,
      `import { parse as parseYaml, stringify as stringifyYaml } from ${JSON.stringify(yamlModule)};`,
      `const configPath = process.env.CICERO_TEST_CONFIG_PATH;`,
      `const gate = process.env.CICERO_TEST_GATE;`,
      `const label = process.env.CICERO_TEST_LABEL;`,
      `const lock = acquireConfigUpdateLock(configPath);`,
      `try {`,
      `  await Bun.write(gate + "." + label + ".acquired", "ready");`,
      `  while (!(await Bun.file(gate + "." + label + ".go").exists())) await Bun.sleep(5);`,
      `  const snapshot = parseYaml(readFileSync(configPath, "utf8")) ?? {};`,
      `  snapshot["writer_" + label] = true;`,
      `  const temporary = configPath + ".tmp-" + label;`,
      `  writeFileSync(temporary, stringifyYaml(snapshot), { flag: "wx" });`,
      `  lock.assertOwned();`,
      `  renameSync(temporary, configPath);`,
      `  await Bun.write(gate + "." + label + ".committed", "done");`,
      `} finally {`,
      `  lock.release();`,
      `}`,
    ].join("\n");
    const children = new Map(["b", "c"].map((label) => [
      label,
      Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          CICERO_TEST_CONFIG_PATH: path,
          CICERO_TEST_GATE: gate,
          CICERO_TEST_LABEL: label,
        },
        stdout: "ignore",
        stderr: "pipe",
      }),
    ] as const));
    const acquired = (label: string): boolean => existsSync(`${gate}.${label}.acquired`);

    expect(await waitUntil(() => acquired("b") || acquired("c"))).toBe(true);
    await Bun.sleep(150);
    const first = acquired("b") ? "b" : "c";
    const second = first === "b" ? "c" : "b";
    const secondAcquiredBeforeRelease = acquired(second);

    writeFileSync(`${gate}.${first}.go`, "go");
    if (secondAcquiredBeforeRelease) writeFileSync(`${gate}.${second}.go`, "go");
    expect(await children.get(first)!.exited).toBe(0);
    if (!secondAcquiredBeforeRelease) {
      expect(await waitUntil(() => acquired(second))).toBe(true);
      writeFileSync(`${gate}.${second}.go`, "go");
    }
    expect(await children.get(second)!.exited).toBe(0);

    expect(secondAcquiredBeforeRelease).toBe(false);
    expect(existsSync(`${gate}.b.committed`)).toBe(true);
    expect(existsSync(`${gate}.c.committed`)).toBe(true);
    expect(parseYaml(readFileSync(path, "utf8"))).toEqual({
      writer_b: true,
      writer_c: true,
    });
  }, 10_000);

  test("a stale owner with a live reused PID and mismatched identity is reclaimed", () => {
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    const ownerPath = writeParticipantOwner(process.ppid, "test:stale-parent");
    let foreignIdentityReads = 0;

    const lock = acquireConfigUpdateLock(path, {
      processIdentitySync: (pid) => {
        if (pid === process.pid) return { kind: "identified", value: "test:config-writer" };
        if (pid === process.ppid) {
          foreignIdentityReads += 1;
          return { kind: "identified", value: "test:current-parent" };
        }
        return { kind: "not-running" };
      },
    });

    expect(foreignIdentityReads).toBe(2);
    expect(existsSync(ownerPath)).toBe(false);
    lock.release();
    updateConfigFields({ voice: "recovered-after-pid-reuse" }, path);
    expect(parseYaml(readFileSync(path, "utf8")).voice).toBe("recovered-after-pid-reuse");
  });

  test("a live owner with a matching process identity is not reclaimed", () => {
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    const ownerPath = writeParticipantOwner(process.ppid, "test:current-parent");

    expect(() => acquireConfigUpdateLock(path, {
      processIdentitySync: (pid) => {
        if (pid === process.pid) return { kind: "identified", value: "test:config-writer" };
        if (pid === process.ppid) return { kind: "identified", value: "test:current-parent" };
        return { kind: "not-running" };
      },
    })).toThrow("Config update lease tickets are exhausted");

    expect(existsSync(ownerPath)).toBe(true);
  });

  test("a fresh identity check preserves a live participant after PID reuse", () => {
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    const ownerPath = writeParticipantOwner(process.ppid, "test:replacement-parent");
    // A second same-PID participant pins cache write-back: it must reuse the
    // fresh "keep" result instead of spawning another identity lookup.
    const secondOwnerPath = writeParticipantOwner(process.ppid, "test:replacement-parent");
    let foreignIdentityReads = 0;
    let lock: ReturnType<typeof acquireConfigUpdateLock> | undefined;
    let acquisitionError: unknown;

    try {
      lock = acquireConfigUpdateLock(path, {
        processIdentitySync: (pid) => {
          if (pid === process.pid) return { kind: "identified", value: "test:config-writer" };
          if (pid === process.ppid) {
            foreignIdentityReads += 1;
            return {
              kind: "identified",
              value: foreignIdentityReads === 1
                ? "test:departed-parent"
                : "test:replacement-parent",
            };
          }
          return { kind: "not-running" };
        },
      });
    } catch (error) {
      acquisitionError = error;
    } finally {
      lock?.release();
    }

    expect(acquisitionError).toBeInstanceOf(Error);
    expect((acquisitionError as Error).message).toContain(
      "Config update lease tickets are exhausted",
    );
    expect(foreignIdentityReads).toBe(2);
    expect(existsSync(ownerPath)).toBe(true);
    expect(existsSync(secondOwnerPath)).toBe(true);
  });

  test("an identity-free owner falls back to liveness and remains valid", () => {
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    const ownerPath = writeParticipantOwner(process.ppid);
    let foreignIdentityReads = 0;

    expect(() => acquireConfigUpdateLock(path, {
      processIdentitySync: (pid) => {
        if (pid === process.ppid) foreignIdentityReads += 1;
        return { kind: "identified", value: "test:config-writer" };
      },
    })).toThrow("Config update lease tickets are exhausted");

    expect(foreignIdentityReads).toBe(0);
    expect(existsSync(ownerPath)).toBe(true);
  });

  test("an old lease held by a live PID is not stolen", async () => {
    const lockPath = `${path}.update-lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "synthetic-live-owner",
      acquiredAtMs: 0,
    }));
    const acquiredPath = join(dir, "live-owner-contender-acquired");
    const configModule = new URL("../src/config.ts", import.meta.url).href;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { acquireConfigUpdateLock } from ${JSON.stringify(configModule)};`,
        `const lock = acquireConfigUpdateLock(process.env.CICERO_TEST_CONFIG_PATH);`,
        `await Bun.write(process.env.CICERO_TEST_ACQUIRED_PATH, "acquired");`,
        `lock.release();`,
      ].join("\n"),
    ], {
      env: {
        ...process.env,
        CICERO_TEST_CONFIG_PATH: path,
        CICERO_TEST_ACQUIRED_PATH: acquiredPath,
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    await Bun.sleep(200);
    expect(existsSync(acquiredPath)).toBe(false);
    rmSync(lockPath, { recursive: true, force: true });
    expect(await child.exited).toBe(0);
    expect(existsSync(acquiredPath)).toBe(true);
  }, 5_000);

  test("a failed release cleanup is retried by a later same-process config rewrite", () => {
    let failedOnce = false;
    const lock = acquireConfigUpdateLock(path, {
      unlinkSync: (lockPath) => {
        if (!failedOnce && lockPath.endsWith(".owner.json")) {
          failedOnce = true;
          throw Object.assign(new Error("synthetic sharing violation"), { code: "EPERM" });
        }
        unlinkSync(lockPath);
      },
    });

    lock.release();
    expect(failedOnce).toBe(true);
    expect(readdirSync(dir).some((entry) => entry.endsWith(".owner.json"))).toBe(true);

    updateConfigFields({ voice: "recovered-without-restart" }, path);

    expect(parseYaml(readFileSync(path, "utf8")).voice).toBe("recovered-without-restart");
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("a different live writer cannot take over an unconfirmed release", async () => {
    let failedOnce = false;
    const lock = acquireConfigUpdateLock(path, {
      unlinkSync: (lockPath) => {
        if (!failedOnce && lockPath.endsWith(".owner.json")) {
          failedOnce = true;
          throw Object.assign(new Error("synthetic sharing violation"), { code: "EPERM" });
        }
        unlinkSync(lockPath);
      },
    });
    lock.release();

    const acquiredPath = join(dir, "pending-cleanup-contender-acquired");
    const configModule = new URL("../src/config.ts", import.meta.url).href;
    const child = Bun.spawn([
      process.execPath,
      "-e",
      [
        `import { acquireConfigUpdateLock } from ${JSON.stringify(configModule)};`,
        `const lock = acquireConfigUpdateLock(process.env.CICERO_TEST_CONFIG_PATH);`,
        `await Bun.write(process.env.CICERO_TEST_ACQUIRED_PATH, "acquired");`,
        `lock.release();`,
      ].join("\n"),
    ], {
      env: {
        ...process.env,
        CICERO_TEST_CONFIG_PATH: path,
        CICERO_TEST_ACQUIRED_PATH: acquiredPath,
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    await Bun.sleep(200);
    expect(existsSync(acquiredPath)).toBe(false);

    lock.release();
    expect(await child.exited).toBe(0);
    expect(existsSync(acquiredPath)).toBe(true);
  }, 5_000);

  test("a failed acquisition rollback cleanup is retried by a later same-process rewrite", () => {
    let choosingFailure = false;
    let ownerRollbackFailure = false;
    expect(() => acquireConfigUpdateLock(path, {
      unlinkSync: (lockPath) => {
        if (!choosingFailure && lockPath.endsWith(".choosing")) {
          choosingFailure = true;
          throw Object.assign(new Error("synthetic choosing cleanup failure"), { code: "EPERM" });
        }
        if (!ownerRollbackFailure && lockPath.endsWith(".owner.json")) {
          ownerRollbackFailure = true;
          throw Object.assign(new Error("synthetic owner rollback failure"), { code: "EPERM" });
        }
        unlinkSync(lockPath);
      },
    })).toThrow("synthetic choosing cleanup failure");
    expect(ownerRollbackFailure).toBe(true);
    expect(readdirSync(dir).some((entry) => entry.endsWith(".owner.json"))).toBe(true);

    updateConfigFields({ voice: "rollback-recovered" }, path);

    expect(parseYaml(readFileSync(path, "utf8")).voice).toBe("rollback-recovered");
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("a partial owner publication is cleaned up before a later same-process rewrite", () => {
    let ownerWriteFailed = false;
    expect(() => acquireConfigUpdateLock(path, {
      writeFileSync: (lockPath, data, options) => {
        if (lockPath.endsWith(".owner.json")) {
          ownerWriteFailed = true;
          writeFileSync(lockPath, data.slice(0, -1), options);
          throw Object.assign(new Error("synthetic partial owner write"), { code: "ENOSPC" });
        }
        writeFileSync(lockPath, data, options);
      },
    })).toThrow("synthetic partial owner write");
    expect(ownerWriteFailed).toBe(true);

    updateConfigFields({ voice: "partial-publication-recovered" }, path);

    expect(parseYaml(readFileSync(path, "utf8")).voice).toBe("partial-publication-recovered");
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("a writer that lost its lease cannot publish its prepared rewrite", () => {
    writeFileSync(path, "voice: retained\n");

    expect(() => updateConfigFields({ voice: "must-not-commit" }, path, {
      validateBeforeCommit: () => {
        const owner = readdirSync(dir).find((entry) =>
          entry.startsWith("config.yaml.update-lock-") && entry.endsWith(".owner.json")
        );
        expect(owner).toBeDefined();
        unlinkSync(join(dir, owner!));
      },
    })).toThrow("Lost the config update lease before committing");

    expect(readFileSync(path, "utf8")).toBe("voice: retained\n");
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("deep-merges nested tts object", async () => {
    updateConfigFields({ tts: { backend: "vibevoice", voice: "Ryan" } }, path);
    updateConfigFields({ tts: { backend: "elevenlabs" } }, path);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.tts.backend).toBe("elevenlabs"); // overwritten
    expect(parsed.tts.voice).toBe("Ryan"); // preserved by deep merge
  });

  test("can replace provider-owned top-level fields without retaining stale nested values", () => {
    writeFileSync(path, [
      "voice_ref_audio: /stale.wav",
      "voice_ref_text: stale transcript",
      "tts:",
      "  backend: audiocpp",
      "  port: 8092",
      "  model: pocket-tts",
      "  refAudio: /stale.wav",
      "brain:",
      "  backend: acp",
      "",
    ].join("\n"));

    updateConfigFields(
      { tts: { backend: "elevenlabs", voice: "cloud-id" } },
      path,
      { replaceTopLevel: ["tts", "voice_ref_audio", "voice_ref_text"] },
    );

    expect(parseYaml(readFileSync(path, "utf-8"))).toEqual({
      tts: { backend: "elevenlabs", voice: "cloud-id" },
      brain: { backend: "acp" },
    });
  });

  test("updates empty and comment-only config documents", () => {
    for (const original of ["", "# keep this note\n"]) {
      writeFileSync(path, original);

      updateConfigFields({ voice: "athena" }, path);

      expect(parseYaml(readFileSync(path, "utf-8"))).toEqual({ voice: "athena" });
    }
  });

  test("refuses malformed YAML without changing a byte or leaving a temp file", () => {
    const original = Buffer.from("voice: old\nbrain: [unterminated\n# keep this recovery note\n");
    writeFileSync(path, original);

    expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(
      /Refusing to update .*existing file is not valid mapping YAML.*Fix it manually or move it aside.*original file was not changed/,
    );

    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("refuses non-mapping YAML without rewriting the original document", () => {
    for (const original of ["null\n", "- voice\n- old\n", "plain scalar\n"]) {
      writeFileSync(path, original);
      expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(/document root must be a mapping/);
      expect(readFileSync(path, "utf-8")).toBe(original);
    }
  });

  test.skipIf(process.platform === "win32")("writes private modes and tightens an existing config", () => {
    chmodSync(dir, 0o755);
    writeFileSync(path, "voice: old\n", { mode: 0o644 });

    updateConfigFields({ voice: "athena" }, path);

    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);

    const freshPath = join(dir, "fresh.yaml");
    updateConfigFields({ voice: "new" }, freshPath);
    expect(mode(freshPath)).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("loading tightens an existing config without changing its data", () => {
    chmodSync(dir, 0o755);
    writeFileSync(path, "voice: jarvis\n", { mode: 0o644 });

    expect(loadConfig({}, { home: dir }).raw.voice).toBe("jarvis");
    expect(mode(path)).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("refuses to read or overwrite a config symlink", () => {
    const target = join(dir, "outside.yaml");
    writeFileSync(target, "voice: untouched\n");
    symlinkSync(target, path, "file");

    expect(() => loadConfig({}, { home: dir })).toThrow(/unsafe private file/);
    expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(/unsafe private file/);
    expect(readFileSync(target, "utf-8")).toBe("voice: untouched\n");
  });
});
