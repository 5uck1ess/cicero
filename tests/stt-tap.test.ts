import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapSTTWithTap } from "../src/backends/stt/tap";
import type { STTProvider } from "../src/backends/stt/provider";

function fakeProvider(overrides: Partial<STTProvider> = {}): STTProvider {
  return {
    name: "fake-stt",
    transcribe: async () => "hello world",
    transcribeResult: async () => ({ kind: "transcript", text: "hello world" }),
    health: async () => true,
    warmup: async () => {},
    ...overrides,
  };
}

async function tempWav(dir: string, bytes = 64): Promise<string> {
  const file = join(dir, "utterance.wav");
  await writeFile(file, new Uint8Array(bytes));
  return file;
}

describe("stt tap", () => {
  test("records the wav and a sidecar with engine, transcript, and timing", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(fakeProvider(), tapDir);
    expect(await provider.transcribe(wav)).toBe("hello world");

    const files = (await readdir(tapDir)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]!.endsWith(".json")).toBe(true);
    expect(files[1]!.endsWith(".wav")).toBe(true);
    const sidecar = JSON.parse(await readFile(join(tapDir, files[0]!), "utf8"));
    expect(sidecar.engine).toBe("fake-stt");
    expect(sidecar.transcript).toBe("hello world");
    expect(sidecar.stt_ms).toBeGreaterThanOrEqual(0);
    expect(sidecar.audio_bytes).toBe(64);
  });

  test("captures are private: 0700 directory, 0600 files", async () => {
    if (process.platform === "win32") return;
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(fakeProvider(), tapDir);
    await provider.transcribe(wav);

    expect(((await stat(tapDir)).mode & 0o777)).toBe(0o700);
    for (const name of await readdir(tapDir)) {
      expect(((await stat(join(tapDir, name))).mode & 0o777)).toBe(0o600);
    }
  });

  test("transcribeResult path records non-transcript outcomes as markers", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(
      fakeProvider({ transcribeResult: async () => ({ kind: "empty" }) }),
      tapDir,
    );
    const result = await provider.transcribeResult!(wav);
    expect(result.kind).toBe("empty");
    const sidecarName = (await readdir(tapDir)).find((f) => f.endsWith(".json"))!;
    const sidecar = JSON.parse(await readFile(join(tapDir, sidecarName), "utf8"));
    expect(sidecar.transcript).toBe("<empty>");
  });

  test("oversized audio is transcribed but not retained", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work, 200);

    const provider = wrapSTTWithTap(fakeProvider(), tapDir, { maxAudioBytes: 100 });
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect((await readdir(tapDir)).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
  });

  test("pruning keeps the newest utterance pairs and never touches unrelated files", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(fakeProvider(), tapDir, {
      maxRetainedUtterances: 2,
      pruneEvery: 1,
    });
    // Seed unrelated files that sort BEFORE the tap's stamps — the old
    // sort/slice bug deleted exactly these.
    await provider.transcribe(wav); // creates the dir with private modes
    await writeFile(join(tapDir, "000-private.json"), "{}");
    await writeFile(join(tapDir, "clip.wav"), new Uint8Array(4));

    for (let i = 0; i < 4; i++) await provider.transcribe(wav);

    const files = (await readdir(tapDir)).sort();
    expect(files).toContain("000-private.json");
    expect(files).toContain("clip.wav");
    const tapped = files.filter((f) => /Z-\d{3}\.(wav|json)$/.test(f));
    expect(tapped).toHaveLength(4); // 2 retained utterances × (wav + json)
    // Pairs stay intact: every retained stem has both extensions.
    const stems = new Set(tapped.map((f) => f.replace(/\.(wav|json)$/, "")));
    for (const stem of stems) {
      expect(tapped).toContain(`${stem}.wav`);
      expect(tapped).toContain(`${stem}.json`);
    }
  });

  test("a symlink planted at a capture destination is not followed or overwritten", async () => {
    if (process.platform === "win32") return;
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const tapDir = join(work, "tap");
    const wav = await tempWav(work);
    const secret = join(work, "secret.txt");
    await writeFile(secret, "DO NOT REPLACE");

    // Pin the clock so the destination filenames are known, and plant a symlink
    // at BOTH (the .wav copy target and the .json write target), each aimed at
    // the protected file an attacker wants clobbered.
    const fixed = new Date("2026-07-21T12:34:56.789Z");
    const stem = "2026-07-21T12-34-56-789Z-000";
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tapDir, { recursive: true, mode: 0o700 });
    await symlink(secret, join(tapDir, `${stem}.wav`));
    await symlink(secret, join(tapDir, `${stem}.json`));

    const provider = wrapSTTWithTap(fakeProvider(), tapDir, { clock: () => new Date(fixed) });
    // Capture must fail closed (exclusive create refuses the pre-existing link)
    // without disturbing the target or breaking transcription.
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect(await readFile(secret, "utf8")).toBe("DO NOT REPLACE");
  });

  test("a symlinked tap directory disables capture without breaking transcription", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const real = join(work, "real");
    const link = join(work, "link");
    await Bun.write(join(real, ".keep"), "");
    await symlink(real, link);
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(fakeProvider(), link);
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect((await readdir(real)).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
  });

  test("a transient setup failure is retried on the next utterance, not latched", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const wav = await tempWav(work);
    const tapDir = join(work, "tap");
    // Block directory creation with a file at the tap path.
    await writeFile(tapDir, "i am a file");

    const provider = wrapSTTWithTap(fakeProvider(), tapDir);
    expect(await provider.transcribe(wav)).toBe("hello world"); // capture fails silently
    // The blocker goes away (e.g. mount recovered) — the tap must recover too.
    await rm(tapDir);
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect((await readdir(tapDir)).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
  });

  test("delegates optional provider members", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    let warmed = false;
    const provider = wrapSTTWithTap(
      fakeProvider({ warmup: async () => { warmed = true; } }),
      join(work, "tap"),
    );
    await provider.warmup!();
    expect(warmed).toBe(true);
    expect(await provider.health()).toBe(true);
  });
});
