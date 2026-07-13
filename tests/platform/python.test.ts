import { describe, expect, test } from "bun:test";
import {
  findPythonInVenvs,
  findVenvPython,
  darwinMajorFromRelease,
  MLX_MIN_DARWIN_MAJOR,
  MLX_MIN_MACOS_MAJOR,
  resolveVenvPython,
  supportsCurrentMlx,
  systemPythonCommand,
  venvPythonCandidates,
} from "../../src/platform/python";

describe("Python virtual-environment resolver", () => {
  test("uses the Windows Scripts/python.exe layout", () => {
    const expected = String.raw`C:\cicero\.venv-stt\Scripts\python.exe`;
    const seen: string[] = [];
    const resolved = resolveVenvPython(String.raw`C:\cicero\.venv-stt`, {
      platform: "win32",
      exists: (path) => {
        seen.push(path);
        return path === expected;
      },
    });

    expect(resolved).toBe(expected);
    expect(seen).toEqual([expected]);
    expect(systemPythonCommand("win32")).toBe("python");
  });

  test("accepts both POSIX bin/python and bin/python3", () => {
    expect(venvPythonCandidates("/opt/cicero/.venv", "linux")).toEqual([
      "/opt/cicero/.venv/bin/python",
      "/opt/cicero/.venv/bin/python3",
      "/opt/cicero/.venv/Scripts/python.exe",
    ]);

    const python = findVenvPython("/opt/cicero/.venv", {
      platform: "linux",
      exists: (path) => path.endsWith("/bin/python"),
    });
    const python3 = findVenvPython("/opt/cicero/.venv", {
      platform: "linux",
      exists: (path) => path.endsWith("/bin/python3"),
    });
    expect(python).toBe("/opt/cicero/.venv/bin/python");
    expect(python3).toBe("/opt/cicero/.venv/bin/python3");
    expect(systemPythonCommand("linux")).toBe("python3");
  });

  test("returns the native expected path when a required venv is missing", () => {
    expect(resolveVenvPython("/srv/cicero/.venv-ser", {
      platform: "linux",
      exists: () => false,
    })).toBe("/srv/cicero/.venv-ser/bin/python");

    expect(resolveVenvPython(String.raw`D:\cicero\.venv-ser`, {
      platform: "win32",
      exists: () => false,
    })).toBe(String.raw`D:\cicero\.venv-ser\Scripts\python.exe`);
  });

  test("searches fallback environments in order", () => {
    const expected = "/repo/.venv-stt/bin/python";
    expect(findPythonInVenvs(["/repo/.venv", "/repo/.venv-stt"], {
      platform: "darwin",
      exists: (path) => path === expected,
    })).toBe(expected);
  });

  test("enforces the current macOS 14+ floor for MLX wheels", () => {
    expect(MLX_MIN_MACOS_MAJOR).toBe(14);
    expect(MLX_MIN_DARWIN_MAJOR).toBe(23);
    expect(darwinMajorFromRelease("22.6.0")).toBe(22);
    expect(darwinMajorFromRelease("23.0.0")).toBe(23);
    expect(darwinMajorFromRelease("not-a-release")).toBeUndefined();
    expect(supportsCurrentMlx("darwin", "22.6.0")).toBe(false);
    expect(supportsCurrentMlx("darwin", "23.0.0")).toBe(true);
    expect(supportsCurrentMlx("darwin", "25.5.0")).toBe(true);
    expect(supportsCurrentMlx("linux", "5.15.0")).toBe(false);
    expect(supportsCurrentMlx("win32", "10.0.26100")).toBe(false);
  });
});
