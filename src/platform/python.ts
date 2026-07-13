import { existsSync } from "node:fs";
import { release } from "node:os";
import { posix, win32 } from "node:path";

/** Current MLX wheels used by Cicero require macOS 14 (Darwin 23) or newer. */
export const MLX_MIN_MACOS_MAJOR = 14;
export const MLX_MIN_DARWIN_MAJOR = 23;

export interface PythonResolverOptions {
  /** Override for deterministic tests; defaults to the current OS. */
  platform?: string;
  /** Override for deterministic tests; defaults to the real filesystem. */
  exists?: (path: string) => boolean;
}

function pathApi(platform: string): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

/**
 * Interpreter locations created by Python's venv and `uv venv`.
 *
 * The native layout is tried first, but the other layout is retained as a
 * fallback so a caller can diagnose an unusual/copied environment instead of
 * assuming one hard-coded executable name.
 */
export function venvPythonCandidates(
  venvDir: string,
  platform: string = process.platform,
): string[] {
  const path = pathApi(platform);
  const windows = path.join(venvDir, "Scripts", "python.exe");
  const posixPython = path.join(venvDir, "bin", "python");
  const posixPython3 = path.join(venvDir, "bin", "python3");

  return platform === "win32"
    ? [windows, posixPython, posixPython3]
    : [posixPython, posixPython3, windows];
}

/** Return the first interpreter that exists in a virtual environment. */
export function findVenvPython(
  venvDir: string,
  options: PythonResolverOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  return venvPythonCandidates(venvDir, platform).find(exists);
}

/**
 * Resolve a virtual-environment interpreter for a managed process.
 *
 * If the environment is missing, return its native expected path. The managed
 * server layer can then report the exact missing binary instead of falling
 * through to an unrelated system Python with the wrong packages installed.
 */
export function resolveVenvPython(
  venvDir: string,
  options: PythonResolverOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  return findVenvPython(venvDir, options) ?? venvPythonCandidates(venvDir, platform)[0]!;
}

/** Find an interpreter in the first usable environment from a preference list. */
export function findPythonInVenvs(
  venvDirs: string[],
  options: PythonResolverOptions = {},
): string | undefined {
  for (const venvDir of venvDirs) {
    const python = findVenvPython(venvDir, options);
    if (python) return python;
  }
  return undefined;
}

/** Conventional Python launcher name when no project environment is required. */
export function systemPythonCommand(platform: string = process.platform): string {
  return platform === "win32" ? "python" : "python3";
}

/** Extract the Darwin kernel major used for macOS compatibility checks. */
export function darwinMajorFromRelease(osRelease: string): number | undefined {
  const darwinMajor = Number.parseInt(osRelease.split(".")[0] ?? "", 10);
  if (!Number.isInteger(darwinMajor) || darwinMajor < 10) return undefined;
  return darwinMajor;
}

/** Whether the current platform satisfies the checked-in MLX dependency floor. */
export function supportsCurrentMlx(
  platform: string = process.platform,
  osRelease: string = release(),
): boolean {
  if (platform !== "darwin") return false;
  const darwinMajor = darwinMajorFromRelease(osRelease);
  return darwinMajor !== undefined && darwinMajor >= MLX_MIN_DARWIN_MAJOR;
}
