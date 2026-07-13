import type { Tool } from "../tool";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isSensitiveReadPath } from "../sensitive-path";

export interface FileToolOptions {
  /** Filesystem boundary for every file operation (default: process.cwd()). */
  root?: string;
  /** Largest file whose contents may be returned to the model. */
  maxReadBytes?: number;
  /** Largest model-authored write accepted in one action. */
  maxWriteBytes?: number;
  /** Maximum directory entries returned to the model. */
  maxListEntries?: number;
}

export interface FileTools {
  listDirTool: Tool;
  readFileTool: Tool;
  writeFileTool: Tool;
}

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 500;

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve an existing path through symlinks and keep it inside the workspace. */
function existingPath(root: string, input: unknown): string {
  const candidate = resolve(root, String(input));
  const canonical = realpathSync(candidate);
  if (!isInside(root, canonical)) throw new Error(`path is outside the compute workspace: ${String(input)}`);
  return canonical;
}

/** Resolve a write target; its existing parent and any existing target are canonicalized. */
function writablePath(root: string, input: unknown): string {
  const candidate = resolve(root, String(input));
  const parent = realpathSync(dirname(candidate));
  if (!isInside(root, parent)) throw new Error(`path is outside the compute workspace: ${String(input)}`);
  if (existsSync(candidate)) {
    const canonical = realpathSync(candidate);
    if (!isInside(root, canonical)) throw new Error(`path is outside the compute workspace: ${String(input)}`);
    if (lstatSync(candidate).isSymbolicLink()) {
      // In-root symlinks are safe after containment validation; return the
      // canonical target so a later replacement cannot retarget the write.
      return canonical;
    }
    return canonical;
  }
  // dirname() may use a platform alias (/var -> /private/var on macOS). Build
  // the new target from the canonical parent before the containment check.
  const canonical = resolve(parent, basename(candidate));
  if (!isInside(root, canonical)) throw new Error(`path is outside the compute workspace: ${String(input)}`);
  return canonical;
}

/** Build file tools bound to one explicit workspace boundary. */
export function createFileTools(options: FileToolOptions = {}): FileTools {
  const root = realpathSync(resolve(options.root ?? process.cwd()));
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

  const listDirTool: Tool = {
    name: "list_dir",
    description: `list entries in a directory inside the compute workspace (${root})`,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prepare(args) {
      const requested = String(args.path ?? "");
      const path = existingPath(root, requested);
      return {
        args: { ...args, path },
        confirmation: `list directory ${path}`,
      };
    },
    async run(args) {
      try {
        const entries = readdirSync(existingPath(root, args.path));
        const visible = entries.slice(0, maxListEntries);
        if (entries.length > visible.length) visible.push(`... (${entries.length - visible.length} more entries omitted)`);
        return { ok: true, output: visible.join("\n") || "(empty)" };
      } catch (err: unknown) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const readFileTool: Tool = {
    name: "read_file",
    description: `read a UTF-8 text file inside the compute workspace (${root}, max ${maxReadBytes} bytes)`,
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    prepare(args) {
      const requested = String(args.path ?? "");
      const path = existingPath(root, requested);
      const size = statSync(path).size;
      if (size > maxReadBytes) {
        throw new Error(`file is ${size} bytes; compute read limit is ${maxReadBytes} bytes`);
      }
      const alias = resolve(root, requested);
      return {
        args: { ...args, path },
        confirmation: alias === path
          ? `read file ${path}`
          : `read file ${path} (requested through ${alias})`,
        security: {
          sensitiveRead: isSensitiveReadPath(requested) || isSensitiveReadPath(path),
        },
      };
    },
    async run(args) {
      try {
        const path = existingPath(root, args.path);
        const size = statSync(path).size;
        if (size > maxReadBytes) {
          return { ok: false, output: `file is ${size} bytes; compute read limit is ${maxReadBytes} bytes` };
        }
        return { ok: true, output: await Bun.file(path).text() };
      } catch (err: unknown) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const writeFileTool: Tool = {
    name: "write_file",
    description: `write text inside the compute workspace (${root}, max ${maxWriteBytes} bytes)`,
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    prepare(args) {
      const path = writablePath(root, args.path);
      const content = String(args.content ?? "");
      const bytes = new TextEncoder().encode(content).byteLength;
      if (bytes > maxWriteBytes) {
        throw new Error(`write is ${bytes} bytes; compute write limit is ${maxWriteBytes} bytes`);
      }
      return {
        args: { ...args, path, content },
        confirmation: `write ${bytes} byte${bytes === 1 ? "" : "s"} to ${path}`,
      };
    },
    async run(args) {
      try {
        const content = String(args.content ?? "");
        const bytes = new TextEncoder().encode(content).byteLength;
        if (bytes > maxWriteBytes) {
          return { ok: false, output: `write is ${bytes} bytes; compute write limit is ${maxWriteBytes} bytes` };
        }
        const path = writablePath(root, args.path);
        await Bun.write(path, content);
        return { ok: true, output: `wrote ${path}` };
      } catch (err: unknown) {
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  return { listDirTool, readFileTool, writeFileTool };
}
