import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TTSProvider } from "../src/backends/tts/provider";
import type { AudioPlayer } from "../src/platform/audio";
import { writeSecureTempAudio } from "../src/platform/secure-temp-audio";
import { TTSSpeaker } from "../src/speaker/tts-speaker";
import { encodeWav } from "../src/platform/wav";
import type { Speaker } from "../src/types";

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cicero-secure-audio-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => { /* best-effort test cleanup */ });
  }
}

test("writes the exact view bytes with private POSIX permissions", async () => {
  await withTempDirectory(async (directory) => {
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const view = new Uint8Array(backing.buffer, 1, 3);
    const path = await writeSecureTempAudio(view, { directory, prefix: "exact" });

    expect([...await readFile(path)]).toEqual([1, 2, 3]);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});

test("repairs creation mode to 0600 under a restrictive POSIX umask", async () => {
  if (process.platform === "win32") return;

  await withTempDirectory(async (directory) => {
    const moduleUrl = pathToFileURL(
      join(import.meta.dir, "../src/platform/secure-temp-audio.ts"),
    ).href;
    const script = [
      `import { stat } from "node:fs/promises";`,
      `import { writeSecureTempAudio } from ${JSON.stringify(moduleUrl)};`,
      `process.umask(0o777);`,
      `const path = await writeSecureTempAudio(new Uint8Array([1]), { directory: process.argv[1], prefix: "umask" });`,
      `console.log(((await stat(path)).mode & 0o777).toString(8));`,
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "-e", script, directory], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout.trim()).toBe("600");
  });
});

test("exclusive creation preserves an existing candidate and retries", async () => {
  await withTempDirectory(async (directory) => {
    const claimed = join(directory, "exclusive-claimed.wav");
    await writeFile(claimed, new Uint8Array([7, 7, 7]));
    const ids = ["claimed", "fresh"];

    const path = await writeSecureTempAudio(new Uint8Array([1, 2, 3]), {
      directory,
      prefix: "exclusive",
      randomId: () => ids.shift() ?? "fallback",
    });

    expect(path).toBe(join(directory, "exclusive-fresh.wav"));
    expect([...await readFile(claimed)]).toEqual([7, 7, 7]);
    expect([...await readFile(path)]).toEqual([1, 2, 3]);
  });
});

test("exclusive creation never follows or clobbers a symlink candidate", async () => {
  if (process.platform === "win32") return;

  await withTempDirectory(async (directory) => {
    const target = join(directory, "target.wav");
    const candidate = join(directory, "symlink-claimed.wav");
    await writeFile(target, new Uint8Array([4, 5, 6]));
    await symlink(target, candidate);
    const ids = ["claimed", "fresh"];

    const path = await writeSecureTempAudio(new Uint8Array([9, 8, 7]), {
      directory,
      prefix: "symlink",
      randomId: () => ids.shift() ?? "fallback",
    });

    expect((await lstat(candidate)).isSymbolicLink()).toBe(true);
    expect([...await readFile(target)]).toEqual([4, 5, 6]);
    expect([...await readFile(path)]).toEqual([9, 8, 7]);
  });
});

test("concurrent writes always receive unique paths", async () => {
  await withTempDirectory(async (directory) => {
    const paths = await Promise.all(
      Array.from({ length: 64 }, (_, value) =>
        writeSecureTempAudio(new Uint8Array([value]), { directory, prefix: "concurrent" })
      ),
    );

    expect(new Set(paths).size).toBe(paths.length);
    for (let value = 0; value < paths.length; value++) {
      expect([...await readFile(paths[value]!)]).toEqual([value]);
    }
  });
});

test("TTSSpeaker removes private audio when playback fails", async () => {
  const wav = encodeWav(new Int16Array([1])).buffer as ArrayBuffer;
  const provider: TTSProvider = {
    name: "test-tts",
    generateAudio: () => Promise.resolve(wav),
    health: () => Promise.resolve(true),
  };
  let playedPath = "";
  const player: AudioPlayer = {
    async play(path: string): Promise<void> {
      playedPath = path;
      expect(existsSync(path)).toBe(true);
      throw new Error("playback failed");
    },
    stopAll: () => Promise.resolve(),
  };
  let fallbacks = 0;
  const fallback: Speaker = {
    speak: () => { fallbacks++; return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  };

  const speaker = new TTSSpeaker(provider, player, fallback);
  await speaker.speak("private words");

  expect(fallbacks).toBe(1);
  expect(playedPath).not.toBe("");
  expect(existsSync(playedPath)).toBe(false);
});

test("TTSSpeaker rejects malformed provider audio before writing or playback", async () => {
  const provider: TTSProvider = {
    name: "test-tts",
    generateAudio: () => Promise.resolve(new ArrayBuffer(8)),
    health: () => Promise.resolve(true),
  };
  let plays = 0;
  const player: AudioPlayer = {
    play: () => { plays++; return Promise.resolve(); },
    stopAll: () => Promise.resolve(),
  };
  let fallbacks = 0;
  const fallback: Speaker = {
    speak: () => { fallbacks++; return Promise.resolve(); },
    health: () => Promise.resolve(true),
    stop: () => Promise.resolve(),
  };
  await new TTSSpeaker(provider, player, fallback).speak("invalid clip");
  expect(plays).toBe(0);
  expect(fallbacks).toBe(1);
});
