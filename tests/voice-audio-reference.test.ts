import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureAudioCppSafeReference,
  type AudioCppReferenceOptions,
} from "../src/voice/audio-reference";
import { inspectWav } from "../src/voice/audio-utils";
import { decodeWav } from "../src/platform/wav";
import { writeWavFixture } from "./helpers/wav";

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(durationSeconds: number): string {
  const wav = writeWavFixture(durationSeconds);
  fixtureDirs.push(wav.dir);
  return wav.path;
}

function cacheRoot(input: string): string {
  return join(dirname(input), ".audiocpp-cache");
}

function ownedReference(
  input: string,
  options: AudioCppReferenceOptions = {},
): Promise<string> {
  return ensureAudioCppSafeReference(input, {
    cacheRoot: cacheRoot(input),
    ...options,
  });
}

function decoded(path: string): Float32Array {
  const bytes = readFileSync(path);
  return decodeWav(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer).samples;
}

function writeTone(path: string, sample = 2_000): void {
  const bytes = readFileSync(path);
  for (let offset = 44; offset + 1 < bytes.byteLength; offset += 2) {
    bytes.writeInt16LE(sample, offset);
  }
  writeFileSync(path, bytes);
}

test("audio.cpp snapshots an initially safe reference into process-owned storage", async () => {
  const source = fixture(17.5);
  const original = readFileSync(source);
  const safe = await ownedReference(source);

  expect(safe).not.toBe(source);
  expect(safe).toContain(join(".audiocpp-cache", "leases"));
  expect(readFileSync(safe)).toEqual(original);
  expect((await inspectWav(safe)).duration_s).toBe(17.5);
  if (process.platform !== "win32") expect(statSync(safe).mode & 0o777).toBe(0o600);

  writeTone(source);
  expect(readFileSync(safe)).toEqual(original);
});

test.skipIf(Bun.which("ffmpeg") === null)(
  "a reference near the 18s window edge is trimmed to the safe target (2026-07-12 live artifact incident)",
  async () => {
    // 17.5–18s references poison pocket-tts conditioning (whispered or dropped
    // first words, junk syllables). They must be re-derived, not used as-is.
    const source = fixture(18);
    const safe = await ownedReference(source);
    expect(safe).not.toBe(source);
    expect((await inspectWav(safe)).duration_s).toBeCloseTo(17.5, 3);
  },
);

test.skipIf(Bun.which("ffmpeg") === null)(
  "audio.cpp derives and reuses one <=18 second content-addressed object",
  async () => {
    const source = fixture(20);
    const safe = await ownedReference(source);
    expect(safe).not.toBe(source);
    expect(basename(safe)).toMatch(/^[a-f0-9]{64}\.wav$/);
    expect(existsSync(safe)).toBe(true);
    expect((await inspectWav(safe)).duration_s).toBeLessThanOrEqual(18);
    const derivativeMtime = statSync(safe, { bigint: true }).mtimeNs;

    await Bun.sleep(5);
    expect(await ownedReference(source)).toBe(safe);
    expect(statSync(safe, { bigint: true }).mtimeNs).toBe(derivativeMtime);
    expect(readdirSync(join(cacheRoot(source), "staging"))).toEqual([]);
    expect(readdirSync(join(cacheRoot(source), "objects")).filter((name) => name.endsWith(".wav")))
      .toHaveLength(1);
  },
);

test.skipIf(Bun.which("ffmpeg") === null)(
  "audio.cpp publishes a new object when a long source changes in place",
  async () => {
    const source = fixture(20);
    const replacement = fixture(20);
    const firstPath = await ownedReference(source);
    const firstBytes = readFileSync(firstPath);

    writeTone(replacement);
    writeFileSync(source, readFileSync(replacement));
    const secondPath = await ownedReference(source);

    expect(secondPath).not.toBe(firstPath);
    expect(readFileSync(firstPath)).toEqual(firstBytes);
    expect(decoded(secondPath).some((sample) => Math.abs(sample) > 0.01)).toBe(true);
  },
);

test.skipIf(Bun.which("ffmpeg") === null)(
  "audio.cpp reconverts a long source when its bound derived object is corrupted",
  async () => {
    try {
      const source = fixture(20);
      const firstLease = await ownedReference(source);
      const expected = readFileSync(firstLease);
      const object = join(cacheRoot(source), "objects", basename(firstLease));
      const corrupted = readFileSync(object);
      corrupted[44] = (corrupted[44] ?? 0) ^ 0xff;
      writeFileSync(object, corrupted);
      expect(readFileSync(firstLease)).not.toEqual(expected);

      const repairedLease = await ownedReference(source);
      expect(repairedLease).toBe(firstLease);
      expect(readFileSync(repairedLease)).toEqual(expected);
      expect(readFileSync(object)).toEqual(expected);
      expect((await inspectWav(repairedLease)).duration_s).toBeLessThanOrEqual(18);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);

test.skipIf(process.platform === "win32" || Bun.which("ffmpeg") === null)(
  "audio.cpp refuses a symlink replacing a bound derived object",
  async () => {
    try {
      const source = fixture(20);
      const target = fixture(1);
      const lease = await ownedReference(source);
      const object = join(cacheRoot(source), "objects", basename(lease));
      const targetBytes = readFileSync(target);
      rmSync(object);
      symlinkSync(target, object);

      await expect(ownedReference(source)).rejects.toThrow(/unsafe private file/);
      expect(readFileSync(target)).toEqual(targetBytes);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
);

test("audio.cpp snapshots a preferred provisioned derivative without exposing its path", async () => {
  const source = fixture(20);
  const provisionedSource = fixture(17.5);
  writeTone(provisionedSource);
  const provisioned = join(dirname(source), "trimmed-18s.wav");
  writeFileSync(provisioned, readFileSync(provisionedSource), { mode: 0o644 });

  const safe = await ownedReference(source, { preferProvisionedDerivative: true });
  expect(safe).not.toBe(provisioned);
  expect(readFileSync(safe)).toEqual(readFileSync(provisioned));
  expect(decoded(safe).some((sample) => Math.abs(sample) > 0.01)).toBe(true);
  if (process.platform !== "win32") expect(statSync(provisioned).mode & 0o777).toBe(0o644);
});

test.skipIf(Bun.which("ffmpeg") === null)(
  "a direct reference ignores an unrelated sibling provisioned derivative",
  async () => {
    const source = fixture(20);
    const siblingSource = fixture(17.5);
    writeTone(siblingSource);
    writeFileSync(
      join(dirname(source), "trimmed-18s.wav"),
      readFileSync(siblingSource),
      { mode: 0o644 },
    );

    const safe = await ownedReference(source);
    expect(decoded(safe).every((sample) => sample === 0)).toBe(true);
    expect((await inspectWav(safe)).duration_s).toBeCloseTo(17.5, 3);
  },
);

test("audio.cpp rejects an unreadable direct reference before allocating cache state", async () => {
  await expect(ensureAudioCppSafeReference("/missing/cicero-reference.wav", {
    cacheRoot: join(import.meta.dir, ".missing-reference-cache"),
  })).rejects.toThrow(/not locally readable/);
});

test.skipIf(process.platform === "win32")(
  "audio.cpp refuses a symlink occupying a content-addressed object name",
  async () => {
    const source = fixture(2);
    const target = fixture(1);
    const root = cacheRoot(source);
    for (const directory of [root, join(root, "objects"), join(root, "staging"), join(root, "leases")]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
    const object = join(root, "objects", `${hash}.wav`);
    const original = readFileSync(target);
    symlinkSync(target, object);

    await expect(ownedReference(source)).rejects.toThrow(/unsafe private file/);
    expect(readFileSync(target)).toEqual(original);
  },
);

test("audio.cpp repairs an unpinned regular cache object without trusting its bytes", async () => {
  const source = fixture(2);
  const original = readFileSync(source);
  const firstLease = await ownedReference(source);
  const object = join(cacheRoot(source), "objects", basename(firstLease));

  // The object and process lease deliberately share an inode. Corrupting one
  // exercises both publication repair and stale-lease replacement.
  writeTone(object);
  expect(readFileSync(firstLease)).not.toEqual(original);

  const repairedLease = await ownedReference(source);
  expect(repairedLease).toBe(firstLease);
  expect(readFileSync(repairedLease)).toEqual(original);
  expect(readFileSync(object)).toEqual(original);
});

test.skipIf(Bun.which("ffmpeg") === null)(
  "twelve concurrent first-use calls serialize one same-reference publication",
  async () => {
    const source = fixture(20);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ownedReference(source)),
    );
    expect(new Set(results).size).toBe(1);
    expect(readdirSync(join(cacheRoot(source), "staging"))).toEqual([]);
    expect(readdirSync(join(cacheRoot(source), "objects")).filter((name) => name.endsWith(".wav")))
      .toHaveLength(1);
  },
);

test("concurrent equal-content paths converge on one process lease", async () => {
  const source = fixture(2);
  const root = cacheRoot(source);
  const aliases = Array.from({ length: 12 }, (_, index) => {
    const alias = join(dirname(source), `same-content-${index}.wav`);
    writeFileSync(alias, readFileSync(source));
    return alias;
  });

  const results = await Promise.all(aliases.map((alias) => (
    ensureAudioCppSafeReference(alias, { cacheRoot: root })
  )));
  expect(new Set(results).size).toBe(1);
  const processLeaseDirectories = readdirSync(join(root, "leases"));
  expect(processLeaseDirectories).toHaveLength(1);
  expect(readdirSync(join(root, "leases", processLeaseDirectories[0]!))).toHaveLength(1);
});

test.skipIf(Bun.which("ffmpeg") === null)(
  "concurrent processes atomically converge on one complete content object",
  async () => {
    const source = fixture(20);
    const root = cacheRoot(source);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/voice/audio-reference.ts")).href;
    const script = [
      `import { ensureAudioCppSafeReference } from ${JSON.stringify(moduleUrl)};`,
      `import { basename } from "node:path";`,
      `const result = await ensureAudioCppSafeReference(${JSON.stringify(source)}, { cacheRoot: ${JSON.stringify(root)} });`,
      `console.log(basename(result));`,
    ].join("\n");
    const bun = Bun.which("bun");
    if (!bun) throw new Error("bun executable not found");
    const children = Array.from({ length: 8 }, () => Bun.spawn(
      [bun, "-e", script],
      { stdout: "pipe", stderr: "pipe" },
    ));
    const results = await Promise.all(children.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`child reference publication failed: ${stderr}`);
      return stdout.trim();
    }));

    expect(new Set(results).size).toBe(1);
    const objects = readdirSync(join(root, "objects")).filter((name) => name.endsWith(".wav"));
    expect(objects).toEqual([results[0]]);
    expect(readdirSync(join(root, "staging"))).toEqual([]);
    expect(readdirSync(join(root, "leases"))).toEqual([]); // child exit cleanup released every lease
    expect((await inspectWav(join(root, "objects", objects[0]!))).duration_s)
      .toBeLessThanOrEqual(18);
  },
);

test("the process-owned lease cache evicts beyond its exact count bound", async () => {
  const template = fixture(0.01);
  const root = cacheRoot(template);
  for (let index = 0; index < 65; index++) {
    const bytes = readFileSync(template);
    bytes.writeInt16LE(index + 1, 44);
    const source = join(dirname(template), `reference-${index}.wav`);
    writeFileSync(source, bytes);
    await ensureAudioCppSafeReference(source, { cacheRoot: root });
  }

  const processLeaseDirectories = readdirSync(join(root, "leases"));
  expect(processLeaseDirectories).toHaveLength(1);
  expect(readdirSync(join(root, "leases", processLeaseDirectories[0]!)))
    .toHaveLength(64);
});
