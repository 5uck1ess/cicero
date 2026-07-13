import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger";

export interface InstallClaudeCodeHookOptions {
  settingsPath?: string;
  port: number;
  token: string;
}

export interface InstallCodexHookOptions {
  hooksPath?: string;
  command?: string;
}

type HookEntry =
  | { type: "command"; command: string; timeout?: number }
  | { type: "http"; url: string; timeout?: number; headers?: Record<string, string> }
  | { type: string; [key: string]: unknown };

interface MatcherEntry {
  matcher?: string;
  hooks: HookEntry[];
}

interface ExistingSettings {
  value: Record<string, unknown>;
  raw: string | null;
}

interface SettingsWriteResult {
  changed: boolean;
  backupPath?: string;
}

const CICERO_HOOK_URL_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/speak$/;
const CICERO_CODEX_FORWARD_PATTERN = /\bcicero\s+hook\s+forward\s+codex\b/;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function buildHookEntry(port: number, token: string): HookEntry {
  return {
    type: "http",
    url: `http://localhost:${port}/speak`,
    timeout: 5,
    headers: { Authorization: `Bearer ${token}` },
  };
}

function buildCodexHookEntry(command: string): HookEntry {
  return {
    type: "command",
    command,
    timeout: 5,
  };
}

function isCiceroHook(entry: HookEntry): boolean {
  if (entry.type === "http" && typeof entry.url === "string") {
    return CICERO_HOOK_URL_PATTERN.test(entry.url);
  }
  // Legacy: drop curl-based entries from earlier installer versions
  if (entry.type === "command" && typeof entry.command === "string") {
    return entry.command.includes("cicero-sidecar-hook")
      || CICERO_CODEX_FORWARD_PATTERN.test(entry.command);
  }
  return false;
}

function isHookEntry(value: unknown): value is HookEntry {
  return value !== null
    && typeof value === "object"
    && "type" in value
    && typeof value.type === "string";
}

function isMatcherEntry(value: unknown): value is MatcherEntry {
  if (value === null || typeof value !== "object") return false;
  if (!("hooks" in value) || !Array.isArray(value.hooks) || !value.hooks.every(isHookEntry)) {
    return false;
  }
  return !("matcher" in value) || typeof value.matcher === "string";
}

async function readExistingSettings(
  settingsPath: string,
): Promise<ExistingSettings> {
  try {
    const stat = await lstat(settingsPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlinked hook settings file: ${settingsPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Hook settings path is not a regular file: ${settingsPath}`);
    }
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
    await mkdir(dirname(settingsPath), { recursive: true });
    return { value: {}, raw: null };
  }

  const raw = await Bun.file(settingsPath).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backupPath = await backupSettings(settingsPath, raw);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse ${settingsPath}: ${reason}. ` +
        `A backup was saved to ${backupPath}. ` +
        `Fix the JSON in the original file (or delete it and re-run) and try again.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Unexpected shape in ${settingsPath}: top-level value must be a JSON object. ` +
        `Found ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}. ` +
        `Move the file aside and re-run.`,
    );
  }

  return { value: parsed as Record<string, unknown>, raw };
}

async function backupSettings(settingsPath: string, raw: string): Promise<string> {
  const backupPath = `${settingsPath}.cicero-bak.${Date.now()}.${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(backupPath, "wx", 0o600);
    await handle.writeFile(raw, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    return backupPath;
  } catch (error: unknown) {
    if (handle) await handle.close().catch(() => {});
    await unlink(backupPath).catch((unlinkError: unknown) => {
      if (!hasCode(unlinkError, "ENOENT")) throw unlinkError;
    });
    throw error;
  }
}

function changedDuringInstall(settingsPath: string): Error {
  return new Error(
    `Hook settings changed during installation: ${settingsPath}. ` +
      `Re-run to merge the latest file.`,
  );
}

async function makeExistingSettingsPrivate(settingsPath: string): Promise<void> {
  const handle = await open(settingsPath, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(settingsPath)]);
    if (current.isSymbolicLink()) {
      throw new Error(`Refusing symlinked hook settings file: ${settingsPath}`);
    }
    if (!current.isFile()) {
      throw new Error(`Hook settings path is not a regular file: ${settingsPath}`);
    }
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw changedDuringInstall(settingsPath);
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function writeSettingsAtomically(
  settingsPath: string,
  settings: Record<string, unknown>,
  original: string | null,
): Promise<SettingsWriteResult> {
  const serialized = JSON.stringify(settings, null, 2);
  if (original === serialized) {
    await makeExistingSettingsPrivate(settingsPath);
    return { changed: false };
  }

  const parent = dirname(settingsPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parent,
    `.${basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null = null;
  let backupPath: string | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      const current = await lstat(settingsPath);
      if (current.isSymbolicLink()) {
        throw new Error(`Refusing symlinked hook settings file: ${settingsPath}`);
      }
      if (!current.isFile()) {
        throw new Error(`Hook settings path is not a regular file: ${settingsPath}`);
      }
      if (original === null) throw changedDuringInstall(settingsPath);
      const latest = await Bun.file(settingsPath).text();
      if (latest !== original) throw changedDuringInstall(settingsPath);
      backupPath = await backupSettings(settingsPath, latest);
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (original !== null) throw changedDuringInstall(settingsPath);
    }

    await rename(temporaryPath, settingsPath);
    return { changed: true, backupPath };
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

function logInstall(settingsPath: string, result: SettingsWriteResult): void {
  if (!result.changed) {
    log("ok", `Cicero hook already current in ${settingsPath}`);
    return;
  }
  if (result.backupPath) {
    log("ok", `Backed up existing hook settings to ${result.backupPath}`);
  }
  log("ok", `Installed Cicero hook into ${settingsPath}`);
}

export async function installClaudeCodeHook(
  opts: InstallClaudeCodeHookOptions,
): Promise<void> {
  try {
    const tokenBytes = Buffer.byteLength(opts.token);
    if (tokenBytes < 32 || tokenBytes > 256 || /\s/.test(opts.token)) {
      throw new Error("Claude Code hook token must be 32-256 bytes without whitespace");
    }
    const settingsPath = opts.settingsPath ?? `${homedir()}/.claude/settings.json`;
    const existing = await readExistingSettings(settingsPath);
    const settings = existing.value;

    const rawHooks = settings.hooks;
    if (rawHooks !== undefined && (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks))) {
      throw new Error(
        `Unexpected shape in ${settingsPath}: 'hooks' field must be a JSON object. ` +
          `Move the file aside and re-run.`,
      );
    }
    const hooks = (rawHooks ?? {}) as Record<string, unknown>;
    const rawStopList = hooks.Stop;
    if (rawStopList !== undefined && (!Array.isArray(rawStopList) || !rawStopList.every(isMatcherEntry))) {
      throw new Error(
        `Unexpected shape in ${settingsPath}: 'hooks.Stop' must be an array of hook groups. ` +
          `Move the file aside and re-run.`,
      );
    }
    const stopList: MatcherEntry[] = rawStopList ?? [];

    for (const entry of stopList) {
      entry.hooks = entry.hooks.filter((hook) => !isCiceroHook(hook));
    }

    let catchAll = stopList.find((entry) => entry.matcher === ".*");
    if (!catchAll) {
      catchAll = { matcher: ".*", hooks: [] };
      stopList.push(catchAll);
    }

    catchAll.hooks.push(buildHookEntry(opts.port, opts.token));

    hooks.Stop = stopList;
    settings.hooks = hooks;

    const result = await writeSettingsAtomically(settingsPath, settings, existing.raw);
    logInstall(settingsPath, result);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to install Cicero hook: ${reason}`, { cause: error });
  }
}

/** Install a native Codex Stop command hook without disturbing other hooks. */
export async function installCodexHook(
  opts: InstallCodexHookOptions = {},
): Promise<void> {
  try {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const hooksPath = opts.hooksPath ?? join(codexHome, "hooks.json");
    const existing = await readExistingSettings(hooksPath);
    const settings = existing.value;

    const rawHooks = settings.hooks;
    if (rawHooks !== undefined && (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks))) {
      throw new Error(
        `Unexpected shape in ${hooksPath}: 'hooks' field must be a JSON object. ` +
          `Move the file aside and re-run.`,
      );
    }
    const hooks = (rawHooks ?? {}) as Record<string, unknown>;
    const rawStopList = hooks.Stop;
    if (rawStopList !== undefined && (!Array.isArray(rawStopList) || !rawStopList.every(isMatcherEntry))) {
      throw new Error(
        `Unexpected shape in ${hooksPath}: 'hooks.Stop' must be an array of hook groups. ` +
          `Move the file aside and re-run.`,
      );
    }
    const stopList: MatcherEntry[] = (rawStopList ?? [])
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((hook) => !isCiceroHook(hook)),
      }))
      .filter((entry) => entry.hooks.length > 0);
    stopList.push({
      hooks: [buildCodexHookEntry(opts.command ?? "cicero hook forward codex")],
    });

    hooks.Stop = stopList;
    settings.hooks = hooks;
    const result = await writeSettingsAtomically(hooksPath, settings, existing.raw);
    logInstall(hooksPath, result);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to install Cicero Codex hook: ${reason}`, { cause: error });
  }
}
