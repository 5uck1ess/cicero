import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { acquireConfigUpdateLock, loadConfig } from "../config";
import { redactSnapshotSecrets } from "../operational-state";
import { PRIVATE_FILE_MODE, ensurePrivateDirectorySync, ensurePrivateFileSync } from "../platform/secure-storage";
import { renderDraft, type SetupDraft } from "./draft";

export type ExistingConfig =
  | { status: "missing" }
  | { status: "valid" }
  | { status: "invalid"; error: string }
  | { status: "other-file-error"; error: string }
  | { status: "unsafe"; error: string };

function pathFor(home: string): string { return join(home, "config.yaml"); }

/** Injection point for a competing non-locking writer at the commit boundary. */
export interface SetupCommitOptions { beforeCommit?: () => void }

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
