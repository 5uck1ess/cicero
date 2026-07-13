import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseManifest, serializeManifest } from "./manifest";
import type { VoiceManifest } from "../types";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../platform/secure-storage";

function unsafeVoiceName(name: string): Error {
  return new Error(`invalid voice name '${name}': expected one local name without path separators`);
}

function pathInfo(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Disk-backed library of cloned voices, one directory per voice under `root`
 * (typically `~/.cicero/voices/`). Each voice dir holds a `voice.yaml`
 * manifest plus the source/trimmed clips.
 */
export class VoiceLibrary {
  private root: string;

  constructor(root: string) {
    const absoluteRoot = resolve(root);
    ensurePrivateDirectorySync(absoluteRoot);
    this.root = realpathSync(absoluteRoot);
  }

  voiceDir(name: string): string {
    if (
      !name || name === "." || name === ".." || isAbsolute(name)
      || name.includes("/") || name.includes("\\") || name.includes("\0")
    ) {
      throw unsafeVoiceName(name);
    }
    const dir = resolve(this.root, name);
    const fromRoot = relative(this.root, dir);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw unsafeVoiceName(name);
    }
    return dir;
  }

  /** Create or tighten a voice directory before provisioning writes audio into it. */
  prepareVoiceDir(name: string): string {
    const dir = this.voiceDir(name);
    const info = pathInfo(dir);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
      throw new Error(`refusing unsafe voice directory '${dir}'`);
    }
    ensurePrivateDirectorySync(dir);
    return dir;
  }

  async list(): Promise<VoiceManifest[]> {
    const out: VoiceManifest[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = this.voiceDir(entry.name);
      const manifestPath = join(dir, "voice.yaml");
      const manifestInfo = pathInfo(manifestPath);
      if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) continue;
      out.push(parseManifest(await Bun.file(manifestPath).text()));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<VoiceManifest | null> {
    const dir = this.voiceDir(name);
    const dirInfo = pathInfo(dir);
    if (!dirInfo) return null;
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`refusing unsafe voice directory '${dir}'`);
    }
    const path = join(dir, "voice.yaml");
    const manifestInfo = pathInfo(path);
    if (!manifestInfo) return null;
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
      throw new Error(`refusing unsafe voice manifest '${path}'`);
    }
    return parseManifest(await Bun.file(path).text());
  }

  async add(manifest: VoiceManifest): Promise<void> {
    const dir = this.prepareVoiceDir(manifest.name);
    // The manifest file is the existence marker — the dir may already exist
    // because provisioning writes the reference clips into it before this call.
    const manifestPath = join(dir, "voice.yaml");
    if (pathInfo(manifestPath)) throw new Error(`voice '${manifest.name}' exists at ${dir}`);
    try {
      await writeFile(manifestPath, serializeManifest(manifest), { flag: "wx", mode: PRIVATE_FILE_MODE });
      ensurePrivateFileSync(manifestPath);
    } catch (err: unknown) {
      throw new Error(`could not save voice '${manifest.name}' manifest`, { cause: err });
    }
  }

  async remove(name: string): Promise<void> {
    const dir = this.voiceDir(name);
    const info = pathInfo(dir);
    if (!info) throw new Error(`voice '${name}' not found`);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`refusing unsafe voice directory '${dir}'`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
