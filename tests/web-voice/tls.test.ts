import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertWebTlsPolicy, ensureTls, isLoopbackWebHost } from "../../src/web-voice/tls";

const CERT_BYTES = "operator-owned certificate fixture\n";
const KEY_BYTES = "operator-owned key fixture\n";
const FAKE_OPENSSL = join(import.meta.dir, "fixtures", "fake-openssl.ts");

function fakeGenerator(
  mode: "valid" | "hang-flood",
  markerPath = "",
  delayMs = 0,
): (keyPath: string, certPath: string) => string[] {
  return (keyPath, certPath) => [
    process.execPath,
    FAKE_OPENSSL,
    mode,
    keyPath,
    certPath,
    markerPath,
    String(delayMs),
  ];
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for fixture marker ${path}`);
}

async function tempDir(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), "cicero-tls-test-"));
  } catch (err) {
    throw new Error(`could not create TLS test directory: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

test("explicit TLS paths are read-only inputs and require a complete pair", async () => {
  const dir = await tempDir();
  try {
    const certPath = join(dir, "operator-cert.pem");
    const keyPath = join(dir, "operator-key.pem");
    await writeFile(certPath, CERT_BYTES);
    await expect(ensureTls({ dir, certFile: certPath })).rejects.toThrow(/configured together/);
    await expect(ensureTls({ dir, certFile: certPath, keyFile: keyPath })).rejects.toThrow(/incomplete/);
    expect(await readFile(certPath, "utf8")).toBe(CERT_BYTES);
    await writeFile(keyPath, KEY_BYTES);
    await expect(ensureTls({ dir, certFile: certPath, keyFile: keyPath })).rejects.toThrow(/not PEM/);
    expect(await readFile(certPath, "utf8")).toBe(CERT_BYTES);
    expect(await readFile(keyPath, "utf8")).toBe(KEY_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("a partial Cicero-owned pair is preserved and never overwritten", async () => {
  const dir = await tempDir();
  try {
    const certPath = join(dir, "cert.pem");
    await writeFile(certPath, CERT_BYTES);
    await expect(ensureTls({ dir })).rejects.toThrow(/incomplete/);
    expect(await readFile(certPath, "utf8")).toBe(CERT_BYTES);
    expect(await readdir(dir)).toEqual(["cert.pem"]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("automatic generation publishes a private complete pair without temp debris", async () => {
  const dir = await tempDir();
  try {
    const material = await ensureTls({ dir });
    expect(material?.cert).toContain("BEGIN CERTIFICATE");
    expect(material?.key).toMatch(/BEGIN (?:[A-Z]+ )?PRIVATE KEY/);
    const entries = (await readdir(dir)).sort();
    expect(entries).toHaveLength(3);
    expect(entries).toContain(".tls-pair.json");
    const certName = entries.find((name) => /^\.tls-cert-.*\.pem$/.test(name));
    const keyName = entries.find((name) => /^\.tls-key-.*\.pem$/.test(name));
    expect(certName).toBeDefined();
    expect(keyName).toBeDefined();
    const manifest = JSON.parse(await readFile(join(dir, ".tls-pair.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual({ version: 1, certFile: certName, keyFile: keyName });
    if (process.platform !== "win32") {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, keyName!))).mode & 0o777).toBe(0o600);
    }
    expect(await ensureTls({ dir })).toEqual(material);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("failed automatic generation leaves no certificate or temporary files", async () => {
  const dir = await tempDir();
  try {
    expect(await ensureTls({ dir, opensslBinary: join(dir, "missing-openssl") })).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("hung and stderr-flooding openssl is killed at an absolute deadline", async () => {
  const dir = await tempDir();
  try {
    const started = performance.now();
    expect(await ensureTls({
      dir,
      generatorCommand: fakeGenerator("hang-flood"),
      generationTimeoutMs: 120,
    })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("generation cancellation kills openssl promptly and cleans private artifacts", async () => {
  const dir = await tempDir();
  const marker = join(dir, "generator-started");
  const controller = new AbortController();
  try {
    const outcome = ensureTls({
      dir,
      signal: controller.signal,
      generatorCommand: fakeGenerator("hang-flood", marker),
      generationTimeoutMs: 10_000,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForFile(marker);
    const abortedAt = performance.now();
    controller.abort("test shutdown");
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/generation aborted/);
    expect(performance.now() - abortedAt).toBeLessThan(1_000);
    await unlink(marker);
    expect(await readdir(dir)).toEqual([]);
  } finally {
    controller.abort("test cleanup");
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("concurrent generators converge on one complete winner and clean loser files", async () => {
  const dir = await tempDir();
  let generatorCalls = 0;
  const command = fakeGenerator("valid", "", 100);
  const generatorCommand = (keyPath: string, certPath: string): string[] => {
    generatorCalls += 1;
    return command(keyPath, certPath);
  };
  try {
    const [first, second] = await Promise.all([
      ensureTls({ dir, generatorCommand }),
      ensureTls({ dir, generatorCommand }),
    ]);
    expect(generatorCalls).toBe(2);
    expect(first).toEqual(second);
    expect(first?.cert).toContain("BEGIN CERTIFICATE");
    const entries = (await readdir(dir)).sort();
    expect(entries).toHaveLength(3);
    expect(entries.filter((name) => name.startsWith(".tls-cert-"))).toHaveLength(1);
    expect(entries.filter((name) => name.startsWith(".tls-key-"))).toHaveLength(1);
    expect(entries.filter((name) => name === ".tls-pair.json")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("stale lock and crash artifacts cannot block recovery", async () => {
  const dir = await tempDir();
  const staleNonce = "00000000-0000-4000-8000-000000000001";
  const staleNames = [
    ".tls-generation.lock",
    ".cert-deadbeef.tmp",
    ".key-deadbeef.tmp",
    `.tls-cert-${staleNonce}.pem`,
    `.tls-key-${staleNonce}.pem`,
    `.tls-manifest-${staleNonce}.tmp`,
  ];
  try {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of staleNames) {
      const path = join(dir, name);
      await writeFile(path, "crashed generation artifact\n");
      await utimes(path, old, old);
    }

    const material = await ensureTls({ dir, generatorCommand: fakeGenerator("valid") });
    expect(material?.cert).toContain("BEGIN CERTIFICATE");
    const entries = await readdir(dir);
    for (const stale of staleNames) expect(entries).not.toContain(stale);
    expect(entries).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* cleanup */ });
  }
});

test("TLS downgrade policy distinguishes loopback from exposed listeners", () => {
  for (const host of ["localhost", "127.0.0.1", "127.42.1.9", "::1", "[::1]"]) {
    expect(isLoopbackWebHost(host)).toBe(true);
    expect(() => assertWebTlsPolicy(host, null, false)).not.toThrow();
  }
  for (const host of ["0.0.0.0", "192.168.1.10", "10.attacker.example", "::", "cicero.local"]) {
    expect(isLoopbackWebHost(host)).toBe(false);
    expect(() => assertWebTlsPolicy(host, null, false)).toThrow(/refusing.*HTTP/);
    expect(() => assertWebTlsPolicy(host, null, true)).not.toThrow();
  }
});
