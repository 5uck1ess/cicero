import { existsSync, rmSync } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { inspectWav } from "./audio-utils";
import {
  AUDIOCPP_MAX_REFERENCE_SECONDS,
  AUDIOCPP_REFERENCE_TRIM_SECONDS,
  voiceProviderContract,
} from "./provider-contract";
import { MAX_DECODED_WAV_BYTES } from "../platform/wav";
import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../platform/secure-storage";
import { ciceroPath } from "../platform/paths";
import { runBoundedCommand } from "../process/bounded-command";

const MAX_AUDIOCPP_REFERENCE_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_REFERENCE_OBJECTS = 128;
const MAX_REFERENCE_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_PROCESS_LEASES = 64;
const MAX_PROCESS_LEASE_BYTES = 256 * 1024 * 1024;
const FINGERPRINT_CHUNK_BYTES = 64 * 1024;
const CONVERSION_TIMEOUT_MS = 60_000;
const CONVERSION_DIAGNOSTIC_BYTES = 64 * 1024;
const PROCESS_INSTANCE = `${process.pid}-${randomUUID()}`;
const AUDIOCPP_DERIVATIVE_FILE = voiceProviderContract("audiocpp").derivativeFile;

interface FingerprintStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
}

interface StableFile {
  path: string;
  sha256: string;
  size: number;
}

interface StableSource extends StableFile {
  sourcePath: string;
  sourceFingerprint: string;
}

interface LeaseEntry {
  path: string;
  size: number;
  pins: number;
}

interface ResolvedReference {
  path: string;
  hash: string;
  cache: ReferenceCache;
  sourcePath: string;
  sourceFingerprint: string;
  preferencePath: string | null;
  preferenceFingerprint: string | null;
}

interface ReferenceCache {
  root: string;
  objects: string;
  staging: string;
  leases: string;
  leaseDirectory: string;
  entries: Map<string, LeaseEntry>;
  entryBytes: number;
  leaseQueue: Promise<void>;
}

const caches = new Map<string, ReferenceCache>();
const inFlightReferences = new Map<string, Promise<ResolvedReference>>();
const derivedObjects = new Map<string, string>();
let exitCleanupInstalled = false;

function statFingerprint(info: FingerprintStat): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function contentStatFingerprint(info: FingerprintStat): string {
  // Publishing/removing a hard-link lease legitimately changes ctime while
  // the inode's bytes remain immutable. Size+mtime on the same inode still
  // detects ordinary content writes around the descriptor-backed SHA scan.
  return [info.dev, info.ino, info.size, info.mtimeNs].join(":");
}

function observedPathFingerprint(info: FingerprintStat): string {
  return `${info.isFile() ? "file" : "non-file"}:${statFingerprint(info)}`;
}

async function currentObservedPathFingerprint(path: string): Promise<string> {
  try {
    return observedPathFingerprint(await stat(path, { bigint: true }));
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "EPERM";
  }
}

function cacheFor(rootOverride?: string): ReferenceCache {
  const root = resolve(rootOverride ?? ciceroPath("cache", "audiocpp-references"));
  const existing = caches.get(root);
  if (existing) return existing;

  const objects = join(root, "objects");
  const staging = join(root, "staging");
  const leases = join(root, "leases");
  const leaseDirectory = join(leases, PROCESS_INSTANCE);
  for (const path of [root, objects, staging, leases, leaseDirectory]) {
    ensurePrivateDirectorySync(path);
  }
  const cache: ReferenceCache = {
    root,
    objects,
    staging,
    leases,
    leaseDirectory,
    entries: new Map(),
    entryBytes: 0,
    leaseQueue: Promise.resolve(),
  };
  caches.set(root, cache);

  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.once("exit", () => {
      for (const state of caches.values()) {
        rmSync(state.leaseDirectory, { recursive: true, force: true });
      }
    });
  }
  return cache;
}

function ownerPid(name: string): number | null {
  const match = /^(?:stage-)?(\d+)-/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

async function cleanupAbandonedFiles(cache: ReferenceCache): Promise<void> {
  try {
    for (const entry of await readdir(cache.leases, { withFileTypes: true })) {
      if (entry.name === PROCESS_INSTANCE) continue;
      const pid = ownerPid(entry.name);
      if (pid !== null && !processIsAlive(pid)) {
        await rm(join(cache.leases, entry.name), { recursive: true, force: true });
      }
    }
    for (const entry of await readdir(cache.staging, { withFileTypes: true })) {
      const pid = ownerPid(entry.name);
      if (pid !== null && !processIsAlive(pid)) {
        await rm(join(cache.staging, entry.name), { recursive: true, force: true });
      }
    }
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function uniqueStagePath(cache: ReferenceCache, kind: "source" | "derived"): string {
  return join(
    cache.staging,
    `stage-${process.pid}-${randomUUID()}-${kind}${kind === "derived" ? ".wav" : ""}`,
  );
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  if (handle) await handle.close().catch(() => { /* best-effort descriptor cleanup */ });
}

async function copyStableSource(source: string, cache: ReferenceCache): Promise<StableSource> {
  const stagedPath = uniqueStagePath(cache, "source");
  let sourceHandle: FileHandle | null = null;
  let stagedHandle: FileHandle | null = null;
  let complete = false;
  try {
    sourceHandle = await open(source, "r");
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`audio.cpp reference '${source}' is not a regular file`);
    if (before.size > BigInt(MAX_AUDIOCPP_REFERENCE_SOURCE_BYTES)) {
      throw new Error(
        `audio.cpp reference '${source}' exceeds the ${MAX_AUDIOCPP_REFERENCE_SOURCE_BYTES}-byte source limit`,
      );
    }

    stagedHandle = await open(stagedPath, "wx", 0o600);
    if (process.platform !== "win32") await stagedHandle.chmod(0o600);
    const size = Number(before.size);
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(FINGERPRINT_CHUNK_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const requested = Math.min(chunk.byteLength, size - position);
      const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
      if (bytesRead === 0) throw new Error(`audio.cpp reference '${source}' changed while being copied`);
      hasher.update(chunk.subarray(0, bytesRead));
      let chunkOffset = 0;
      while (chunkOffset < bytesRead) {
        const { bytesWritten } = await stagedHandle.write(
          chunk,
          chunkOffset,
          bytesRead - chunkOffset,
          position + chunkOffset,
        );
        if (bytesWritten === 0) throw new Error(`could not stage audio.cpp reference '${source}'`);
        chunkOffset += bytesWritten;
      }
      position += bytesRead;
    }
    await stagedHandle.sync();

    const after = await sourceHandle.stat({ bigint: true });
    const current = await stat(source, { bigint: true });
    if (statFingerprint(before) !== statFingerprint(after)
      || statFingerprint(after) !== statFingerprint(current)) {
      throw new Error(`audio.cpp reference '${source}' changed while being staged`);
    }
    complete = true;
    return {
      path: stagedPath,
      sha256: hasher.digest("hex"),
      size,
      sourcePath: resolve(source),
      sourceFingerprint: statFingerprint(current),
    };
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`could not stage audio.cpp reference '${source}': ${String(error)}`);
  } finally {
    await closeQuietly(stagedHandle);
    await closeQuietly(sourceHandle);
    if (!complete) await unlink(stagedPath).catch(() => { /* best-effort partial-stage cleanup */ });
  }
}

async function safeWav(path: string): Promise<boolean> {
  try {
    const info = await inspectWav(path);
    // The trim target, not the 18s window itself, is the usability bar:
    // references between the two poison pocket-tts conditioning (see
    // AUDIOCPP_REFERENCE_TRIM_SECONDS). Old cached 18.0s derivatives fail
    // this check and are rebuilt through the normal repair path.
    return info.duration_s <= AUDIOCPP_REFERENCE_TRIM_SECONDS;
  } catch {
    return false;
  }
}

async function assertSafeWav(path: string): Promise<void> {
  if (!await safeWav(path)) {
    throw new Error(`audio.cpp safe-reference conversion produced an invalid or overlong WAV: '${path}'`);
  }
}

async function createPrivateStage(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await closeQuietly(handle);
  }
}

async function convertReference(input: string, output: string): Promise<void> {
  await createPrivateStage(output);
  const command = [
    "ffmpeg",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-t",
    String(AUDIOCPP_REFERENCE_TRIM_SECONDS),
    "-ac",
    "1",
    "-fs",
    String(MAX_DECODED_WAV_BYTES),
    output,
  ];
  try {
    const result = await runBoundedCommand(command, {
      timeoutMs: CONVERSION_TIMEOUT_MS,
      stdoutLimitBytes: 1,
      stderrLimitBytes: CONVERSION_DIAGNOSTIC_BYTES,
      totalLimitBytes: CONVERSION_DIAGNOSTIC_BYTES,
      stdoutCapture: "head",
      stderrCapture: "tail",
      outputLimitBehavior: "truncate",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `ffmpeg trim failed (exit ${result.exitCode}): ${result.stderr.text.slice(-500)}`,
      );
    }
    ensurePrivateFileSync(output);
    await assertSafeWav(output);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `audio.cpp reference conversion failed within its ${CONVERSION_TIMEOUT_MS}ms/${MAX_DECODED_WAV_BYTES}-byte bounds: ${detail}`,
      { cause: error },
    );
  }
}

async function hashStableFile(path: string, maxBytes: number): Promise<StableFile> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`reference cache path '${path}' is not a regular file`);
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`reference cache path '${path}' exceeds the ${maxBytes}-byte limit`);
    }
    const size = Number(before.size);
    const hasher = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(FINGERPRINT_CHUNK_BYTES, Math.max(1, size)));
    let position = 0;
    while (position < size) {
      const length = Math.min(chunk.byteLength, size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw new Error(`reference cache path '${path}' changed while being read`);
      hasher.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (contentStatFingerprint(before) !== contentStatFingerprint(after)
      || contentStatFingerprint(after) !== contentStatFingerprint(current)) {
      throw new Error(`reference cache path '${path}' changed while being fingerprinted`);
    }
    return { path, sha256: hasher.digest("hex"), size };
  } finally {
    await closeQuietly(handle);
  }
}

async function validateContentObject(path: string, expectedHash: string): Promise<StableFile> {
  ensurePrivateFileSync(path);
  const object = await hashStableFile(path, MAX_DECODED_WAV_BYTES);
  if (object.sha256 !== expectedHash) {
    throw new Error(`audio.cpp reference cache object '${path}' does not match its content address`);
  }
  await assertSafeWav(path);
  return object;
}

async function publishObject(
  candidate: string,
  hash: string,
  cache: ReferenceCache,
): Promise<StableFile> {
  const objectPath = join(cache.objects, `${hash}.wav`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await link(candidate, objectPath);
      return await validateContentObject(objectPath, hash);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    try {
      return await validateContentObject(objectPath, hash);
    } catch (error: unknown) {
      // Symlinks/non-files are an unsafe namespace attack, not recoverable
      // cache damage. A regular but corrupted inode can be atomically moved
      // aside; existing hard-link leases keep their old inode until release.
      if (/unsafe private file/.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      const quarantine = uniqueStagePath(cache, "source");
      try {
        await rename(objectPath, quarantine);
      } catch (renameError: unknown) {
        if (errorCode(renameError) !== "ENOENT") throw renameError;
      } finally {
        await unlink(quarantine).catch(() => { /* another repair may have won */ });
      }
    }
  }
  throw new Error(`could not atomically publish audio.cpp reference object '${objectPath}'`);
}

function derivedBindingKey(cache: ReferenceCache, sourceHash: string): string {
  return `${cache.root}\0${sourceHash}`;
}

function touchDerivedBinding(cache: ReferenceCache, sourceHash: string, objectHash: string): void {
  const key = derivedBindingKey(cache, sourceHash);
  derivedObjects.delete(key);
  derivedObjects.set(key, objectHash);
  while (derivedObjects.size > MAX_PROCESS_LEASES) {
    const oldest = derivedObjects.keys().next().value as string | undefined;
    if (!oldest) break;
    derivedObjects.delete(oldest);
  }
}

async function cachedDerivedObject(
  sourceHash: string,
  cache: ReferenceCache,
): Promise<StableFile | null> {
  const key = derivedBindingKey(cache, sourceHash);
  const objectHash = derivedObjects.get(key);
  if (!objectHash) return null;
  const path = join(cache.objects, `${objectHash}.wav`);
  try {
    const object = await validateContentObject(path, objectHash);
    touchDerivedBinding(cache, sourceHash, objectHash);
    return object;
  } catch (error: unknown) {
    // A missing or corrupted regular object invalidates only this derived
    // binding. Reconvert from the stable source snapshot and let atomic
    // publication repair the content-addressed namespace. Symlinks and
    // non-files remain hard failures: never rename or unlink an unsafe entry.
    const detail = error instanceof Error ? error.message : String(error);
    if (/unsafe private file/.test(detail)) {
      throw error;
    }
    derivedObjects.delete(key);
    return null;
  }
}

async function leaseObjectUnlocked(object: StableFile, cache: ReferenceCache): Promise<string> {
  const existing = cache.entries.get(object.sha256);
  if (existing) {
    try {
      await validateContentObject(existing.path, object.sha256);
      cache.entries.delete(object.sha256);
      cache.entries.set(object.sha256, existing);
      return existing.path;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (errorCode(error) !== "ENOENT"
        && (existing.pins > 0 || /unsafe private file/.test(detail))) {
        throw error;
      }
      cache.entries.delete(object.sha256);
      cache.entryBytes -= existing.size;
      await unlink(existing.path).catch((unlinkError: unknown) => {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      });
    }
  }

  const leasePath = join(cache.leaseDirectory, `${object.sha256}.wav`);
  try {
    await link(object.path, leasePath);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await validateContentObject(leasePath, object.sha256);
  // Another same-content source may have completed this lease while link/hash
  // awaited. Recheck before changing the bounded accounting.
  const concurrentlyAdded = cache.entries.get(object.sha256);
  if (concurrentlyAdded) return concurrentlyAdded.path;
  cache.entries.set(object.sha256, { path: leasePath, size: object.size, pins: 0 });
  cache.entryBytes += object.size;

  while (cache.entries.size > MAX_PROCESS_LEASES
    || cache.entryBytes > MAX_PROCESS_LEASE_BYTES) {
    const oldest = [...cache.entries.entries()].find(
      ([hash, entry]) => hash !== object.sha256 && entry.pins === 0,
    );
    if (!oldest) {
      const current = cache.entries.get(object.sha256);
      if (current?.pins === 0) {
        cache.entries.delete(object.sha256);
        cache.entryBytes -= current.size;
        await unlink(current.path).catch(() => { /* best-effort rollback */ });
      }
      throw new Error("audio.cpp process reference lease cache is full with active references");
    }
    const [oldestHash, oldestEntry] = oldest;
    cache.entries.delete(oldestHash);
    cache.entryBytes -= oldestEntry.size;
    await unlink(oldestEntry.path).catch(() => { /* another cleanup may have won */ });
  }
  return leasePath;
}

async function withLeaseQueue<T>(cache: ReferenceCache, operation: () => Promise<T>): Promise<T> {
  const previous = cache.leaseQueue;
  let unlock!: () => void;
  cache.leaseQueue = new Promise<void>((resolveQueue) => { unlock = resolveQueue; });
  await previous;
  try {
    return await operation();
  } finally {
    unlock();
  }
}

function leaseObject(object: StableFile, cache: ReferenceCache): Promise<string> {
  return withLeaseQueue(cache, () => leaseObjectUnlocked(object, cache));
}

async function pinResolvedReference(reference: ResolvedReference): Promise<string> {
  return withLeaseQueue(reference.cache, async () => {
    const existing = reference.cache.entries.get(reference.hash);
    if (existing) {
      await validateContentObject(existing.path, reference.hash);
      existing.pins += 1;
      reference.cache.entries.delete(reference.hash);
      reference.cache.entries.set(reference.hash, existing);
      return existing.path;
    }

    // Unpinned leases may be evicted between resolution and this caller's
    // continuation. Recreate the same process-owned link while holding the
    // lease queue, then pin it before any later eviction can observe it.
    const objectPath = join(reference.cache.objects, `${reference.hash}.wav`);
    const object = await validateContentObject(objectPath, reference.hash);
    const path = await leaseObjectUnlocked(object, reference.cache);
    const added = reference.cache.entries.get(reference.hash);
    if (!added || added.path !== path) {
      throw new Error(`audio.cpp reference lease '${path}' disappeared before acquisition`);
    }
    added.pins += 1;
    return path;
  });
}

async function pruneInactiveObjects(cache: ReferenceCache, currentHash: string): Promise<void> {
  const objects: Array<{ path: string; hash: string; size: number; mtimeMs: number; links: number }> = [];
  for (const entry of await readdir(cache.objects, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.wav$/.test(entry.name)) continue;
    const path = join(cache.objects, entry.name);
    const info = await stat(path);
    objects.push({
      path,
      hash: entry.name.slice(0, 64),
      size: info.size,
      mtimeMs: info.mtimeMs,
      links: info.nlink,
    });
  }
  let totalBytes = objects.reduce((total, object) => total + object.size, 0);
  let totalObjects = objects.length;
  objects.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const object of objects) {
    if (totalObjects <= MAX_REFERENCE_OBJECTS && totalBytes <= MAX_REFERENCE_OBJECT_BYTES) break;
    // A hard-link lease means a live process may be between validation and the
    // external server's open(). Never prune such an inode from under it.
    if (object.hash === currentHash || object.links > 1) continue;
    try {
      await unlink(object.path);
      totalObjects -= 1;
      totalBytes -= object.size;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function stagePreferredReference(
  input: string,
  cache: ReferenceCache,
  preferProvisionedDerivative: boolean,
): Promise<{
  staged: StableSource;
  alreadySafe: boolean;
  preferencePath: string | null;
  preferenceFingerprint: string | null;
}> {
  if (preferProvisionedDerivative) {
    const provisioned = join(dirname(input), AUDIOCPP_DERIVATIVE_FILE);
    if (resolve(provisioned) !== resolve(input) && existsSync(provisioned)) {
      const staged = await copyStableSource(provisioned, cache);
      const preferencePath = resolve(provisioned);
      const preferenceFingerprint = `file:${staged.sourceFingerprint}`;
      if (await safeWav(staged.path)) {
        return {
          staged,
          alreadySafe: true,
          preferencePath,
          preferenceFingerprint,
        };
      }
      await unlink(staged.path).catch(() => { /* rejected preferred snapshot cleanup */ });
      const fallback = await copyStableSource(input, cache);
      return {
        staged: fallback,
        alreadySafe: await safeWav(fallback.path),
        preferencePath,
        preferenceFingerprint,
      };
    }
    if (resolve(provisioned) !== resolve(input)) {
      const staged = await copyStableSource(input, cache);
      return {
        staged,
        alreadySafe: await safeWav(staged.path),
        preferencePath: resolve(provisioned),
        preferenceFingerprint: "missing",
      };
    }
  }
  const staged = await copyStableSource(input, cache);
  return {
    staged,
    alreadySafe: await safeWav(staged.path),
    preferencePath: null,
    preferenceFingerprint: null,
  };
}

async function buildOwnedReference(
  input: string,
  cache: ReferenceCache,
  preferProvisionedDerivative: boolean,
): Promise<ResolvedReference> {
  await cleanupAbandonedFiles(cache);
  const stagedPaths: string[] = [];
  try {
    const {
      staged,
      alreadySafe,
      preferencePath,
      preferenceFingerprint,
    } = await stagePreferredReference(
      input,
      cache,
      preferProvisionedDerivative,
    );
    stagedPaths.push(staged.path);

    let object: StableFile;
    if (alreadySafe) {
      object = await publishObject(staged.path, staged.sha256, cache);
    } else {
      const cached = await cachedDerivedObject(staged.sha256, cache);
      if (cached) {
        object = cached;
      } else {
        const derivedPath = uniqueStagePath(cache, "derived");
        stagedPaths.push(derivedPath);
        await convertReference(staged.path, derivedPath);
        const derived = await hashStableFile(derivedPath, MAX_DECODED_WAV_BYTES);
        object = await publishObject(derivedPath, derived.sha256, cache);
        touchDerivedBinding(cache, staged.sha256, object.sha256);
      }
    }

    const lease = await leaseObject(object, cache);
    await pruneInactiveObjects(cache, object.sha256);
    return {
      path: lease,
      hash: object.sha256,
      cache,
      sourcePath: staged.sourcePath,
      sourceFingerprint: staged.sourceFingerprint,
      preferencePath,
      preferenceFingerprint,
    };
  } finally {
    await Promise.all(stagedPaths.map((path) => unlink(path).catch(() => undefined)));
  }
}

export interface AudioCppReferenceOptions {
  /** Only voice-library manifests may claim the canonical provisioned derivative. */
  preferProvisionedDerivative?: boolean;
  /** Injectable private cache root for embedded runtimes and tests. */
  cacheRoot?: string;
}

export interface AudioCppReferenceLease {
  path: string;
  /** Stable caller-side source selected while the immutable lease was built. */
  sourcePath: string;
  sourceFingerprint: string;
  /** Cheap stat-only validation for provider-held hot-path leases. */
  isCurrent(): Promise<boolean>;
  /** Release after the external audio.cpp request has finished opening/reading the path. */
  release(): void;
}

async function resolveAudioCppReference(
  input: string,
  options: AudioCppReferenceOptions,
): Promise<ResolvedReference> {
  if (!existsSync(input)) {
    throw new Error(
      `audio.cpp reference '${input}' is not locally readable; configure a verified WAV capped at ${AUDIOCPP_MAX_REFERENCE_SECONDS}s`,
    );
  }
  const cache = cacheFor(options.cacheRoot);
  const key = `${cache.root}\0${resolve(input)}\0${options.preferProvisionedDerivative === true}`;
  const existing = inFlightReferences.get(key);
  if (existing) return existing;

  const pending = buildOwnedReference(
    input,
    cache,
    options.preferProvisionedDerivative === true,
  );
  inFlightReferences.set(key, pending);
  try {
    return await pending;
  } finally {
    if (inFlightReferences.get(key) === pending) inFlightReferences.delete(key);
  }
}

/**
 * Resolve any caller-owned reference into an immutable process lease.
 *
 * Source bytes are copied from one stable descriptor into a private bounded
 * staging file. Safe WAVs are published directly; longer/encoded sources are
 * converted under a wall/output bound. Publication uses no-replace hard links
 * into a content-addressed object store, so concurrent daemon/CLI writers can
 * only converge on complete validated bytes. audio.cpp receives a per-process
 * hard-link lease, never the mutable caller pathname or a shared staging path.
 */
export async function ensureAudioCppSafeReference(
  input: string,
  options: AudioCppReferenceOptions = {},
): Promise<string> {
  return (await resolveAudioCppReference(input, options)).path;
}

/** Keep the process-owned path alive across the external server's open/read window. */
export async function acquireAudioCppSafeReference(
  input: string,
  options: AudioCppReferenceOptions = {},
): Promise<AudioCppReferenceLease> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await resolveAudioCppReference(input, options);
    try {
      const path = await pinResolvedReference(resolved);
      let leaseFingerprint: string;
      try {
        const leaseInfo = await lstat(path, { bigint: true });
        if (!leaseInfo.isFile()) {
          throw new Error(`audio.cpp reference lease '${path}' is not a regular file`);
        }
        leaseFingerprint = statFingerprint(leaseInfo);
      } catch (error: unknown) {
        const current = resolved.cache.entries.get(resolved.hash);
        if (current?.path === path) current.pins = Math.max(0, current.pins - 1);
        throw error;
      }
      let released = false;
      return {
        path,
        sourcePath: resolved.sourcePath,
        sourceFingerprint: resolved.sourceFingerprint,
        isCurrent: async () => {
          try {
            if (released) return false;
            const entry = resolved.cache.entries.get(resolved.hash);
            if (!entry || entry.path !== path || entry.pins <= 0) return false;
            const [sourceInfo, currentLeaseInfo, preferenceFingerprint] = await Promise.all([
              stat(resolved.sourcePath, { bigint: true }),
              lstat(path, { bigint: true }),
              resolved.preferencePath
                ? currentObservedPathFingerprint(resolved.preferencePath)
                : Promise.resolve(null),
            ]);
            return sourceInfo.isFile()
              && currentLeaseInfo.isFile()
              && statFingerprint(sourceInfo) === resolved.sourceFingerprint
              && statFingerprint(currentLeaseInfo) === leaseFingerprint
              && preferenceFingerprint === resolved.preferenceFingerprint;
          } catch {
            return false;
          }
        },
        release: () => {
          if (released) return;
          released = true;
          const current = resolved.cache.entries.get(resolved.hash);
          if (current?.path === path) current.pins = Math.max(0, current.pins - 1);
        },
      };
    } catch (error: unknown) {
      // A separate unpinned-cache prune may win the tiny continuation window
      // after resolution. Re-resolve once from the caller's current source;
      // no missing or unvalidated path is ever handed to audio.cpp.
      if (attempt === 0 && errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`could not acquire audio.cpp reference '${input}'`);
}
