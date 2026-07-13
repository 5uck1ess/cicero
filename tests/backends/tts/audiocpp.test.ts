import { test, expect, afterEach } from "bun:test";
import { AudioCppProvider } from "../../../src/backends/tts/audiocpp";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeWavFixture } from "../../helpers/wav";
import { inspectWav } from "../../../src/voice/audio-utils";
import {
  ensureAudioCppSafeReference,
  type AudioCppReferenceLease,
} from "../../../src/voice/audio-reference";

const realFetch = globalThis.fetch;
const fixtureDirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function referenceWav(): string {
  const fixture = writeWavFixture();
  fixtureDirs.push(fixture.dir);
  return fixture.path;
}

function referenceCacheRoot(reference: string): string {
  return join(dirname(reference), ".audiocpp-cache");
}

function captureFetch(body: BodyInit, status = 200, contentType = "audio/wav") {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof fetch;
  return calls;
}

test("posts text + model to /v1/audio/speech and returns the audio bytes", async () => {
  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  const calls = captureFetch(wav);
  const p = new AudioCppProvider({ backend: "audiocpp" });
  const audio = await p.generateAudio("hello");

  expect(new Uint8Array(audio)).toEqual(wav);
  expect(calls[0].url).toBe("http://localhost:8092/v1/audio/speech");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.input).toBe("hello");
  expect(sent.model).toBe("pocket-tts"); // default family
  expect(sent.voice).toBeUndefined();
  expect(sent.voice_ref).toBeUndefined();
});

test("clones via voice_ref when refAudio is configured (and it wins over voice)", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const p = new AudioCppProvider({
    backend: "audiocpp",
    voice: "alba",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  });
  await p.generateAudio("hi");
  const sent = JSON.parse(String(calls[0].init.body));
  expect(sent.voice_ref).not.toBe(reference);
  expect(readFileSync(sent.voice_ref)).toEqual(readFileSync(reference));
  expect(sent.voice).toBeUndefined();
});

test("sequential renders reuse one fingerprinted held reference lease", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("first");
  const firstLease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  expect(await firstLease.isCurrent()).toBe(true);
  await provider.generateAudio("second");

  const secondLease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  expect(secondLease).toBe(firstLease);
  expect(provider.heldReferences.size).toBe(1);
  expect(JSON.parse(String(calls[0].init.body)).voice_ref)
    .toBe(JSON.parse(String(calls[1].init.body)).voice_ref);
  expect(readFileSync(secondLease.path)).toEqual(readFileSync(reference));
  await provider.stop();
});

test("provider stop drains renders and releases its held reference leases", async () => {
  captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("hold");
  const lease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  expect(await lease.isCurrent()).toBe(true);
  await provider.stop();
  expect(provider.heldReferences.size).toBe(0);
  expect(await lease.isCurrent()).toBe(false);
});

test("provider stop closes admission before its asynchronous drain", async () => {
  captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("hold");
  const lease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  const stopping = provider.stop();
  const lateRender = provider.generateAudio("too late");

  await expect(lateRender).rejects.toThrow(/provider is stopped/);
  await stopping;
  expect(provider.heldReferences.size).toBe(0);
  expect(await lease.isCurrent()).toBe(false);
});

test("the last concurrent start or stop call owns render admission", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    host: "192.0.2.10",
  });

  await provider.stop();
  const supersededStart = provider.start();
  const winningStop = provider.stop();
  await Promise.all([supersededStart, winningStop]);
  await expect(provider.generateAudio("must remain stopped")).rejects.toThrow(/provider is stopped/);

  const supersededStop = provider.stop();
  const winningStart = provider.start();
  await Promise.all([supersededStop, winningStart]);
  await expect(provider.generateAudio("running again")).resolves.toBeInstanceOf(ArrayBuffer);
  expect(calls).toHaveLength(1);
  await provider.stop();
});

test("a changed configured source invalidates and replaces the held lease", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("before");
  const firstLease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  const firstPath = JSON.parse(String(calls[0].init.body)).voice_ref as string;
  const replacement = readFileSync(reference);
  replacement.writeInt16LE(12_345, 44);
  writeFileSync(reference, replacement);

  await provider.generateAudio("after");
  const secondLease = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  const secondPath = JSON.parse(String(calls[1].init.body)).voice_ref as string;
  expect(secondLease).not.toBe(firstLease);
  expect(secondPath).not.toBe(firstPath);
  expect(await firstLease.isCurrent()).toBe(false);
  expect(readFileSync(secondPath)).toEqual(replacement);
  await provider.stop();
});

test("same-size lease tampering with a restored mtime invalidates the held lease", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const expected = readFileSync(reference);
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("initial");
  const initial = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(initial.path, fixedTime, fixedTime);

  // Refresh once so the held fingerprint captures the fixed mtime. Rewriting
  // the same number of bytes and restoring that mtime must still be visible
  // through ctime/inode metadata rather than accepted as the prior lease.
  await provider.generateAudio("capture fixed metadata");
  const held = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  const tampered = Buffer.from(readFileSync(held.path));
  tampered[44] = (tampered[44] ?? 0) ^ 0xff;
  await Bun.sleep(5);
  writeFileSync(held.path, tampered);
  utimesSync(held.path, fixedTime, fixedTime);

  expect(await held.isCurrent()).toBe(false);
  await provider.generateAudio("repair");
  const repairedPath = JSON.parse(String(calls.at(-1)!.init.body)).voice_ref as string;
  expect(readFileSync(repairedPath)).toEqual(expected);
  await provider.stop();
});

test("a failed held-lease refresh is evicted and can be repaired in place", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const original = readFileSync(reference);
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };

  await provider.generateAudio("before removal");
  const stale = provider.heldReferences.values().next().value as AudioCppReferenceLease;
  rmSync(reference);
  await expect(provider.generateAudio("while missing")).rejects.toThrow(/not locally readable/);
  expect(provider.heldReferences.size).toBe(0);
  expect(await stale.isCurrent()).toBe(false);

  writeFileSync(reference, original);
  await provider.generateAudio("after repair");
  expect(provider.heldReferences.size).toBe(1);
  expect(calls).toHaveLength(2);
  await provider.stop();
});

test("provider-held reference leases use an exact bounded LRU", async () => {
  captureFetch(new Uint8Array([0]));
  const template = referenceWav();
  const voiceRoot = dirname(template);
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    voiceLibraryRoot: voiceRoot,
    referenceCacheRoot: referenceCacheRoot(template),
  }) as AudioCppProvider & { heldReferences: Map<string, AudioCppReferenceLease> };
  let firstLease: AudioCppReferenceLease | undefined;

  for (let index = 0; index < 17; index++) {
    const name = `voice-${index}`;
    const voiceDir = join(voiceRoot, name);
    mkdirSync(voiceDir);
    const reference = join(voiceDir, "reference.wav");
    writeFileSync(reference, readFileSync(template));
    writeFileSync(join(voiceDir, "voice.yaml"), JSON.stringify({
      name,
      provider: "audiocpp",
      source_clip: reference,
      trimmed_clip: reference,
      created_at: "2026-07-11T00:00:00.000Z",
    }));
    await provider.generateAudio(name, name);
    firstLease ??= provider.heldReferences.values().next().value as AudioCppReferenceLease;
  }

  expect(provider.heldReferences.size).toBe(16);
  expect(await firstLease!.isCurrent()).toBe(false);
  for (const lease of provider.heldReferences.values()) {
    expect(await lease.isCurrent()).toBe(true);
  }
  await provider.stop();
});

test("uses a packaged voice id when only voice is configured", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new AudioCppProvider({ backend: "audiocpp", voice: "alba" });
  await p.generateAudio("hi");
  expect(JSON.parse(String(calls[0].init.body)).voice).toBe("alba");
});

test("targets a remote host and custom model when configured", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const p = new AudioCppProvider({ backend: "audiocpp", host: "192.168.1.50", port: 9000, model: "qwen3-tts" });
  await p.generateAudio("hi");
  expect(calls[0].url).toBe("http://192.168.1.50:9000/v1/audio/speech");
  expect(JSON.parse(String(calls[0].init.body)).model).toBe("qwen3-tts");
});

test("throws with the status + body on a non-OK response", async () => {
  captureFetch("model not loaded", 503, "application/json");
  const p = new AudioCppProvider({ backend: "audiocpp" });
  await expect(p.generateAudio("hi")).rejects.toThrow(/503/);
});

test("health is true when /v1/models responds ok, false when unreachable", async () => {
  const calls = captureFetch(JSON.stringify({ object: "list", data: [{ id: "pocket-tts" }] }), 200, "application/json");
  const p = new AudioCppProvider({ backend: "audiocpp" });
  expect(await p.health()).toBe(true);
  expect(calls[0].url).toBe("http://localhost:8092/v1/models");

  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  expect(await p.health()).toBe(false);
});

test("warmup performs one throwaway generation", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const p = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  });
  await p.warmup();
  expect(calls.length).toBe(1);
  expect(JSON.parse(String(calls[0].init.body)).input).toBe("Ready.");
});

test("an active legacy library voice prefers its canonical provisioned derivative", async () => {
  try {
    const calls = captureFetch(new Uint8Array([0]));
    const long = writeWavFixture(20);
    const short = writeWavFixture(17.5);
    fixtureDirs.push(long.dir, short.dir);
    const voiceDir = join(long.dir, "active");
    mkdirSync(voiceDir);
    const legacyReference = join(voiceDir, "trimmed-mono.wav");
    const canonicalReference = join(voiceDir, "trimmed-18s.wav");
    writeFileSync(legacyReference, readFileSync(long.path));
    writeFileSync(canonicalReference, readFileSync(short.path));
    writeFileSync(join(voiceDir, "voice.yaml"), JSON.stringify({
      name: "active",
      provider: "audiocpp",
      source_clip: legacyReference,
      trimmed_clip: legacyReference,
      created_at: "2026-07-11T00:00:00.000Z",
    }));
    const provider = new AudioCppProvider({
      backend: "audiocpp",
      voice: "active",
      refAudio: legacyReference,
      voiceLibraryRoot: long.dir,
      referenceCacheRoot: join(long.dir, ".audiocpp-cache"),
    });

    await provider.generateAudio("legacy clone");

    const owned = JSON.parse(String(calls[0].init.body)).voice_ref;
    expect(owned).not.toBe(canonicalReference);
    expect(readFileSync(owned)).toEqual(readFileSync(canonicalReference));
  } catch (error: unknown) {
    throw error instanceof Error ? error : new Error(String(error));
  }
});

test("a newly provisioned canonical derivative replaces a held legacy fallback", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const legacy = writeWavFixture(2);
  const canonical = writeWavFixture(3);
  fixtureDirs.push(legacy.dir, canonical.dir);
  const voiceDir = join(legacy.dir, "appearing-derivative");
  mkdirSync(voiceDir);
  const legacyReference = join(voiceDir, "trimmed-mono.wav");
  const canonicalReference = join(voiceDir, "trimmed-18s.wav");
  writeFileSync(legacyReference, readFileSync(legacy.path));
  writeFileSync(join(voiceDir, "voice.yaml"), JSON.stringify({
    name: "appearing-derivative",
    provider: "audiocpp",
    source_clip: legacyReference,
    trimmed_clip: legacyReference,
    created_at: "2026-07-11T00:00:00.000Z",
  }));
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    voice: "appearing-derivative",
    refAudio: legacyReference,
    voiceLibraryRoot: legacy.dir,
    referenceCacheRoot: join(legacy.dir, ".audiocpp-cache"),
  });

  await provider.generateAudio("before provisioning");
  const fallbackPath = JSON.parse(String(calls[0]!.init.body)).voice_ref as string;
  expect(readFileSync(fallbackPath)).toEqual(readFileSync(legacyReference));

  writeFileSync(canonicalReference, readFileSync(canonical.path));
  await provider.generateAudio("after provisioning");
  const canonicalPath = JSON.parse(String(calls[1]!.init.body)).voice_ref as string;
  expect(canonicalPath).not.toBe(fallbackPath);
  expect(readFileSync(canonicalPath)).toEqual(readFileSync(canonicalReference));
  await provider.stop();
});

test("revalidates a configured reference after an initial failure", async () => {
  const calls = captureFetch(new Uint8Array([0]));
  const reference = referenceWav();
  const wav = readFileSync(reference);
  rmSync(reference);
  const p = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  });

  await expect(p.generateAudio("first")).rejects.toThrow(/not locally readable/);
  writeFileSync(reference, wav);
  await p.generateAudio("second");

  expect(calls).toHaveLength(1);
  const owned = JSON.parse(String(calls[0].init.body)).voice_ref;
  expect(owned).not.toBe(reference);
  expect(readFileSync(owned)).toEqual(wav);
});

test.skipIf(Bun.which("ffmpeg") === null)("a safe source replaced at request time cannot change audio.cpp's owned bytes", async () => {
  const reference = referenceWav();
  const original = readFileSync(reference);
  const long = writeWavFixture(20);
  fixtureDirs.push(long.dir);
  const requestReferences: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    const payload = JSON.parse(String((init as RequestInit).body)) as { voice_ref: string };
    if (requestReferences.length === 0) {
      // Deterministically replace the caller pathname after reference
      // resolution but at the exact boundary where audio.cpp would open it.
      writeFileSync(reference, readFileSync(long.path));
    }
    requestReferences.push(payload.voice_ref);
    return new Response(new Uint8Array([0]));
  }) as unknown as typeof fetch;
  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: referenceCacheRoot(reference),
  });

  await provider.generateAudio("first");
  expect(requestReferences[0]).not.toBe(reference);
  expect(readFileSync(requestReferences[0]!)).toEqual(original);
  expect((await inspectWav(requestReferences[0]!)).duration_s).toBe(2);

  await provider.generateAudio("second");
  expect(requestReferences[1]).not.toBe(requestReferences[0]);
  expect((await inspectWav(requestReferences[1]!)).duration_s).toBeLessThanOrEqual(18);
});

test("keeps the exact voice_ref leased until audio.cpp finishes the request", async () => {
  const reference = referenceWav();
  const original = readFileSync(reference);
  const root = referenceCacheRoot(reference);
  let requestStarted!: (init: RequestInit) => void;
  const started = new Promise<RequestInit>((resolve) => { requestStarted = resolve; });
  let finishRequest!: () => void;
  const requestPending = new Promise<void>((resolve) => { finishRequest = resolve; });
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    requestStarted(init as RequestInit);
    await requestPending;
    return new Response(new Uint8Array([0]));
  }) as unknown as typeof fetch;

  const provider = new AudioCppProvider({
    backend: "audiocpp",
    refAudio: reference,
    referenceCacheRoot: root,
  });
  const generation = provider.generateAudio("hold the reference");

  try {
    const init = await started;
    const owned = (JSON.parse(String(init.body)) as { voice_ref: string }).voice_ref;

    // Apply enough unrelated cache pressure to evict an ordinary oldest lease.
    // The path already handed to audio.cpp must remain present and immutable.
    for (let index = 0; index < 65; index++) {
      const bytes = Buffer.from(original);
      bytes.writeInt16LE(index + 1, 44);
      const source = join(dirname(reference), `pressure-${index}.wav`);
      writeFileSync(source, bytes);
      await ensureAudioCppSafeReference(source, { cacheRoot: root });
    }

    expect(readFileSync(owned)).toEqual(original);
  } finally {
    finishRequest();
  }
  await generation;
});
