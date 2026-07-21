import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
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
    const wav = await tempWav(work, 26 * 1024 * 1024);

    const provider = wrapSTTWithTap(fakeProvider(), tapDir);
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect((await readdir(tapDir)).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
  });

  test("a symlinked tap directory disables capture without breaking transcription", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const real = join(work, "real");
    const link = join(work, "link");
    await writeFile(join(work, "placeholder"), "");
    await Bun.write(join(real, ".keep"), "");
    await symlink(real, link);
    const wav = await tempWav(work);

    const provider = wrapSTTWithTap(fakeProvider(), link);
    expect(await provider.transcribe(wav)).toBe("hello world");
    expect((await readdir(real)).filter((f) => f.endsWith(".wav"))).toHaveLength(0);
  });

  test("tap failures never fail the transcription", async () => {
    const work = await mkdtemp(join(tmpdir(), "stt-tap-"));
    const wav = await tempWav(work);
    // A tap dir path that collides with an existing FILE cannot be created.
    const blocked = join(work, "blocked");
    await writeFile(blocked, "i am a file");

    const provider = wrapSTTWithTap(fakeProvider(), blocked);
    expect(await provider.transcribe(wav)).toBe("hello world");
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
