import { test, expect } from "bun:test";
import {
  installClaudeCodeHook,
  installCodexHook,
} from "../src/sidecar/install-claude-code-hook";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "test-hook-token-that-is-at-least-32-bytes";

test("writes a new settings.json with the hook entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  if (process.platform !== "win32") chmodSync(dir, 0o775);

  await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  const entry = data.hooks.Stop[0].hooks[0];
  expect(entry.type).toBe("http");
  expect(entry.url).toBe("http://localhost:8084/speak");
  expect(entry.timeout).toBe(5);
  expect(entry.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  expect(readdirSync(dir)).toEqual(["settings.json"]);
  if (process.platform !== "win32") {
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o775);
  }
});

test("writes an idempotent native Codex Stop hook without clobbering other hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-codex-hook-test-"));
  const hooksPath = join(dir, "hooks.json");
  try {
    const original = JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo preserve" }],
        }],
      },
      preserve: true,
    });
    writeFileSync(hooksPath, original);

    await installCodexHook({ hooksPath });
    await installCodexHook({ hooksPath });

    const data = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(data.preserve).toBe(true);
    expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("echo preserve");
    expect(data.hooks.Stop).toHaveLength(1);
    expect(data.hooks.Stop[0]).toEqual({
      hooks: [{
        type: "command",
        command: "cicero hook forward codex",
        timeout: 5,
      }],
    });
    const backups = readdirSync(dir).filter((name) => name.includes(".cicero-bak."));
    expect(backups).toHaveLength(1);
    const backupPath = join(dir, backups[0]!);
    expect(readFileSync(backupPath, "utf8")).toBe(original);
    if (process.platform !== "win32") {
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex hook install replaces only a previous Cicero forwarder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-codex-hook-test-"));
  const hooksPath = join(dir, "hooks.json");
  try {
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: "cicero hook forward codex" },
            { type: "command", command: "echo keep" },
          ],
        }],
      },
    }));

    await installCodexHook({ hooksPath, command: "/opt/cicero hook forward codex" });

    const data = JSON.parse(readFileSync(hooksPath, "utf8"));
    const commands = data.hooks.Stop.flatMap((group: { hooks: Array<{ command: string }> }) =>
      group.hooks.map((hook) => hook.command));
    expect(commands).toEqual(["echo keep", "/opt/cicero hook forward codex"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merges into an existing settings.json without clobbering other hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: ".*", hooks: [{ type: "command", command: "echo pre" }] },
        ],
      },
      otherKey: "preserve me",
    })
  );

  await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.otherKey).toBe("preserve me");
  expect(data.hooks.PreToolUse).toHaveLength(1);
  expect(data.hooks.Stop[0].hooks[0].type).toBe("http");
  expect(data.hooks.Stop[0].hooks[0].url).toBe("http://localhost:8084/speak");
});

test("is idempotent — running twice doesn't duplicate the hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");

  await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });
  if (process.platform !== "win32") chmodSync(settingsPath, 0o644);
  await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.hooks.Stop).toHaveLength(1);
  expect(data.hooks.Stop[0].hooks).toHaveLength(1);
  expect(readdirSync(dir)).toEqual(["settings.json"]);
  if (process.platform !== "win32") {
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  }
});

test("backs up and refuses to write when existing settings.json is malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, '{"hooks": { trailing comma, }');

  let err: Error | null = null;
  try {
    await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });
  } catch (e) {
    err = e as Error;
  }

  expect(err).not.toBeNull();
  expect(err!.message).toContain("Failed to parse");
  expect(err!.message).toContain("backup was saved");

  // Original file is untouched, backup exists alongside it.
  const original = readFileSync(settingsPath, "utf8");
  expect(original).toContain("trailing comma");
  const backups = readdirSync(dir).filter((n) => n.includes(".cicero-bak."));
  expect(backups).toHaveLength(1);
});

test("refuses to write when top-level JSON is not an object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "[]");

  let err: Error | null = null;
  try {
    await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });
  } catch (e) {
    err = e as Error;
  }

  expect(err).not.toBeNull();
  expect(err!.message).toContain("must be a JSON object");
});

test("refuses to write when 'hooks' field is not an object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hooks: "oops" }));

  let err: Error | null = null;
  try {
    await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });
  } catch (e) {
    err = e as Error;
  }

  expect(err).not.toBeNull();
  expect(err!.message).toContain("'hooks' field must be a JSON object");
});

test("replaces legacy curl/command-type Cicero entries with http entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command:
                  "# cicero-sidecar-hook curl -sX POST http://localhost:8084/speak ...",
              },
              { type: "command", command: "echo unrelated" },
            ],
          },
        ],
      },
    })
  );

  await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });

  const data = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(data.hooks.Stop[0].hooks).toHaveLength(2);
  expect(data.hooks.Stop[0].hooks[0].command).toBe("echo unrelated");
  expect(data.hooks.Stop[0].hooks[1].type).toBe("http");
});

test("rejects a weak credential before creating settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  try {
    await expect(
      installClaudeCodeHook({ settingsPath, port: 8084, token: "short" }),
    ).rejects.toThrow("token must be 32-256 bytes");
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "refuses to replace a symlinked hook settings file",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
    const targetPath = join(dir, "unrelated.json");
    const settingsPath = join(dir, "settings.json");
    try {
      writeFileSync(targetPath, JSON.stringify({ preserve: true }));
      symlinkSync(targetPath, settingsPath);

      await expect(
        installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN }),
      ).rejects.toThrow("Refusing symlinked hook settings file");
      expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ preserve: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("removes stale Cicero hooks from every Stop group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "http", url: "http://localhost:7000/speak" }] },
          {
            matcher: ".*",
            hooks: [
              { type: "http", url: "http://127.0.0.1:7001/speak" },
              { type: "command", command: "echo preserve" },
            ],
          },
        ],
      },
    }));

    await installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN });
    const data = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(data.hooks.Stop[0].hooks).toEqual([]);
    expect(data.hooks.Stop[1].hooks).toHaveLength(2);
    expect(data.hooks.Stop[1].hooks[0].command).toBe("echo preserve");
    expect(data.hooks.Stop[1].hooks[1].url).toBe("http://localhost:8084/speak");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses malformed Stop groups without changing settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cicero-hook-test-"));
  const settingsPath = join(dir, "settings.json");
  const original = JSON.stringify({ hooks: { Stop: [{ matcher: ".*", hooks: [null] }] } });
  try {
    writeFileSync(settingsPath, original);
    await expect(
      installClaudeCodeHook({ settingsPath, port: 8084, token: TOKEN }),
    ).rejects.toThrow("'hooks.Stop' must be an array of hook groups");
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
