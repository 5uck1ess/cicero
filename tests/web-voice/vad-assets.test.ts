import { test, expect } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVadAssets, VAD_ASSETS } from "../../src/web-voice/vad-assets";

function tempDir(): string {
  return join(tmpdir(), `cicero-vad-assets-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
}

async function contentFor(name: string): Promise<Uint8Array> {
  const asset = VAD_ASSETS.find((a) => a.name === name)!;
  // deterministic filler of the exact size — hash won't match the real one
  return new Uint8Array(asset.bytes).fill(65);
}

/** A fetcher that serves exact-size bodies whose hashes we control. */
function fakeFetcher(bodies: Record<string, Uint8Array>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const name = String(url).split("/").pop()!;
    const body = bodies[name];
    if (!body) return new Response("nope", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
  }) as typeof fetch;
}

test("a hash mismatch is rejected and leaves no file behind", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  try {
    const bodies: Record<string, Uint8Array> = {};
    for (const a of VAD_ASSETS) bodies[a.name] = await contentFor(a.name);
    const r = await ensureVadAssets(dir, { fetcher: fakeFetcher(bodies) });
    expect(r.ready).toBe(false);
    expect(r.failures.length).toBe(VAD_ASSETS.length);
    expect(r.failures[0]).toContain("sha256 mismatch");
    for (const a of VAD_ASSETS) {
      expect(await Bun.file(join(dir, a.name)).exists()).toBe(false);
      expect(await Bun.file(join(dir, `${a.name}.download`)).exists()).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("size overruns and undersized bodies are rejected before hashing", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  try {
    const bodies: Record<string, Uint8Array> = {};
    for (const a of VAD_ASSETS) bodies[a.name] = new Uint8Array(16); // wrong size for all
    const r = await ensureVadAssets(dir, { fetcher: fakeFetcher(bodies) });
    expect(r.ready).toBe(false);
    expect(r.failures.every((f) => /bytes, expected/.test(f))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed fetches are reported per-asset with nothing written", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  try {
    const failing = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const first = await ensureVadAssets(dir, { fetcher: failing });
    expect(first.ready).toBe(false);
    expect(first.fetched).toBe(0);
    expect(first.failures.length).toBe(VAD_ASSETS.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("abort propagates instead of being recorded as a per-asset failure", async () => {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  try {
    const ac = new AbortController();
    ac.abort();
    await expect(ensureVadAssets(dir, { signal: ac.signal })).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
