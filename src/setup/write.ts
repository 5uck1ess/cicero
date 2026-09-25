import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioCppLocalRuntimePaths } from "../backends/tts/audiocpp";
import { parse as parseYaml } from "yaml";
import { acquireConfigUpdateLock, loadConfig } from "../config";
import { redactSnapshotSecrets } from "../operational-state";
import { PRIVATE_FILE_MODE, ensurePrivateDirectorySync, ensurePrivateFileSync } from "../platform/secure-storage";
import { renderDraft, type SetupDraft } from "./draft";
import { AUDIOCPP_MODELS, AUDIOCPP_PORT, audioCppModelPath } from "./audiocpp";

export type ExistingConfig =
  | { status: "missing" }
  | { status: "valid" }
  | { status: "invalid"; error: string }
  | { status: "other-file-error"; error: string }
  | { status: "unsafe"; error: string };

function pathFor(home: string): string { return join(home, "config.yaml"); }

/** Injection point for a competing non-locking writer at the commit boundary. */
export interface SetupCommitOptions { beforeCommit?: () => void; checkout?: string }

const MAX_SERVER_CONFIG_BYTES = 1024 * 1024;
type ServerModel = Record<string, unknown> & { id: string };

function selectedAudioCppModels(draft: SetupDraft, root: string): ServerModel[] {
  const selected = (kind: "stt" | "tts") => {
    const setting = draft[kind];
    return setting && typeof setting === "object" && !Array.isArray(setting)
      && (setting as Record<string, unknown>).backend === "audiocpp";
  };
  const models: ServerModel[] = [];
  if (selected("tts")) models.push({ id: AUDIOCPP_MODELS.tts.id, family: "pocket_tts", path: audioCppModelPath(root, "tts"), task: "tts", mode: "offline",
    load_options: { language: "english" }, session_options: { language: "english", "pocket_tts.voice_state_cache_slots": "16" } });
  if (selected("stt")) models.push({ id: AUDIOCPP_MODELS.stt.id, family: "nemotron_asr", path: audioCppModelPath(root, "stt"), task: "asr", mode: (draft.stt as { streaming?: boolean }).streaming === true ? "streaming" : "offline",
    session_options: { language: "en-US" } });
  return models;
}

/** Add only selected model entries to the machine-local audio.cpp server config. */
export function writeAudioCppServerConfig(draft: SetupDraft, root: string): string | null {
  const selected = selectedAudioCppModels(draft, root);
  if (!selected.length) return null;
  const checkout = lstatSync(root);
  if (!checkout.isDirectory() || checkout.isSymbolicLink()) throw new Error("Refusing unsafe checkout directory");
  const servers = join(root, "servers");
  const directory = lstatSync(servers);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Refusing unsafe servers directory");
  const path = audioCppLocalRuntimePaths(root).serverConfig;
  const lock = acquireConfigUpdateLock(path);
  try {
    let original: ReturnType<typeof lstatSync> | undefined;
    try { original = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (original && (!original.isFile() || original.isSymbolicLink())) throw new Error("Refusing unsafe audio.cpp server config path");
    if (original && original.size > MAX_SERVER_CONFIG_BYTES) throw new Error("audio.cpp server config is too large to merge");
    let config: Record<string, unknown>;
    if (original) {
      // Open without following a replacement symlink and verify the inode.
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let contents: string;
      try {
        const current = fstatSync(fd);
        if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.size > MAX_SERVER_CONFIG_BYTES)
          throw new Error("audio.cpp server config changed during setup; retry");
        const bytes = Buffer.allocUnsafe(MAX_SERVER_CONFIG_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const count = readSync(fd, bytes, size, bytes.length - size, null);
          if (!count) break;
          size += count;
        }
        if (size > MAX_SERVER_CONFIG_BYTES) throw new Error("audio.cpp server config is too large to merge");
        contents = bytes.toString("utf8", 0, size);
      } finally { closeSync(fd); }
      const parsed: unknown = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("audio.cpp server config must be a JSON object");
      config = parsed as Record<string, unknown>;
      if (!Array.isArray(config.models) || config.models.length > 200) throw new Error("audio.cpp server config must have a bounded models array");
      if (config.models.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string")) throw new Error("audio.cpp server config contains an invalid model entry");
    } else config = { host: "127.0.0.1", port: AUDIOCPP_PORT, device: 0, threads: 1, models: [] };
    const models = config.models as ServerModel[];
    const missing = selected.filter((entry) => !models.some((existing) => existing.id === entry.id));
    const streamingNemotron = (draft.stt as { streaming?: boolean } | undefined)?.streaming === true;
    const changedMode = streamingNemotron && models.some((entry) => entry.id === AUDIOCPP_MODELS.stt.id && entry.mode !== "streaming");
    if (!missing.length && !changedMode) return path;
    const updated = { ...config, models: [
      ...models.map((entry) => streamingNemotron && entry.id === AUDIOCPP_MODELS.stt.id ? { ...entry, mode: "streaming" } : entry),
      ...missing,
    ] };
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFileSync(tmp);
      lock.assertOwned();
      if (original) {
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs)
          throw new Error("audio.cpp server config changed during setup; retry");
        renameSync(tmp, path);
      } else {
        try { linkSync(tmp, path); }
        catch (error) {
          if (alreadyExists(error)) throw new Error("audio.cpp server config appeared during setup; retry", { cause: error });
          throw error;
        }
      }
      ensurePrivateFileSync(path);
      return path;
    } finally { try { unlinkSync(tmp); } catch { /* published or already removed */ } }
  } finally { lock.release(); }
}

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

export function inspectExistingConfig(home: string): ExistingConfig {
  ensurePrivateDirectorySync(home);
  const path = pathFor(home);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) return { status: "unsafe", error: "config.yaml is not a regular file; refusing to follow or replace it" };
  // Isolate config.yaml from actions.yaml so an actions failure never offers
  // to back up a valid config. Both checks still use the real loadConfig path.
  const validationHome = mkdtempSync(join(tmpdir(), "cicero-setup-inspect-"));
  try {
    ensurePrivateDirectorySync(validationHome);
    ensurePrivateFileSync(path);
    writeFileSync(join(validationHome, "config.yaml"), readFileSync(path), { flag: "wx", mode: PRIVATE_FILE_MODE });
    try {
      loadConfig({}, { home: validationHome });
    } catch (error) {
      return { status: "invalid", error: redactSnapshotSecrets(error instanceof Error ? error.message : String(error)) };
    }
  } finally {
    rmSync(validationHome, { recursive: true, force: true });
  }
  try {
    loadConfig({}, { home });
    return { status: "valid" };
  } catch (error) {
    return { status: "other-file-error", error: redactSnapshotSecrets(error instanceof Error ? error.message : String(error)) };
  }
}

export function backupInvalidConfig(home: string, now: () => number = Date.now, options: SetupCommitOptions = {}): string {
  const path = pathFor(home);
  const lock = acquireConfigUpdateLock(path);
  try {
    const state = inspectExistingConfig(home);
    if (state.status !== "invalid") throw new Error("Only an invalid existing config can be backed up by setup");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing unsafe config.yaml path");
    const backup = `${path}.bak-${new Date(now()).toISOString().replaceAll(":", "-")}`;
    let linked = false;
    try {
      options.beforeCommit?.();
      lock.assertOwned();
      // Hard-link creation is exclusive: an existing backup is never replaced.
      try { linkSync(path, backup); linked = true; }
      catch (error) {
        if (alreadyExists(error)) throw new Error("Backup name already exists; retry setup", { cause: error });
        throw error;
      }
      ensurePrivateFileSync(backup);
      const source = lstatSync(path);
      const saved = lstatSync(backup);
      if (!source.isFile() || source.isSymbolicLink()
        || source.dev !== info.dev || source.ino !== info.ino
        || source.dev !== saved.dev || source.ino !== saved.ino) {
        throw new Error("config.yaml changed before backup; refusing to remove it");
      }
      lock.assertOwned();
      unlinkSync(path);
      return backup;
    } catch (error) {
      if (linked) { try { unlinkSync(backup); } catch { /* keep the source on cleanup failure */ } }
      throw error;
    }
  } finally {
    lock.release();
  }
}

export function writeDraft(home: string, draft: SetupDraft, options: SetupCommitOptions = {}): string {
  const text = renderDraft(draft);
  if (JSON.stringify(parseYaml(text)) !== JSON.stringify(draft)) throw new Error("Rendered draft did not round-trip to the selected settings");
  const validationHome = mkdtempSync(join(tmpdir(), "cicero-setup-validate-"));
  try {
    ensurePrivateDirectorySync(validationHome);
    writeFileSync(join(validationHome, "config.yaml"), text, { flag: "wx", mode: PRIVATE_FILE_MODE });
    loadConfig({}, { home: validationHome });
  } finally {
    rmSync(validationHome, { recursive: true, force: true });
  }
  const path = pathFor(home);
  const lock = acquireConfigUpdateLock(path);
  try {
    const state = inspectExistingConfig(home);
    if (state.status === "valid") throw new Error("config.yaml already exists and is valid; edit it or back it up manually");
    if (state.status === "invalid") throw new Error(`config.yaml is invalid: ${state.error}. Use the explicit back up and start fresh action first`);
    if (state.status === "other-file-error") throw new Error(`Other Cicero home file is invalid: ${state.error}. Fix it before setup can write`);
    if (state.status === "unsafe") throw new Error(state.error);
    writeAudioCppServerConfig(draft, options.checkout ?? join(import.meta.dir, "..", ".."));
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(tmp, text, { flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFileSync(tmp);
      if (inspectExistingConfig(home).status !== "missing") throw new Error("config.yaml appeared during setup; refusing to replace it");
      options.beforeCommit?.();
      lock.assertOwned();
      // linkSync publishes the already-validated private temp file only when
      // config.yaml is absent. renameSync could replace a competing writer.
      try { linkSync(tmp, path); }
      catch (error) {
        if (alreadyExists(error)) throw new Error("config.yaml appeared during setup; refusing to replace it", { cause: error });
        throw error;
      }
      ensurePrivateFileSync(path);
      return path;
    } finally {
      try { unlinkSync(tmp); } catch { /* linked file remains, or temp was absent */ }
    }
  } finally {
    lock.release();
  }
}
