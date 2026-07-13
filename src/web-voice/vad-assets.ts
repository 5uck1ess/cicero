/**
 * Speech-gate assets: Silero VAD v5 (MIT) + the onnxruntime-web wasm runtime
 * (MIT), pinned by version, size, and sha256. Downloaded once into
 * ~/.cicero/web-voice/vad/ — the same model-on-first-use pattern as the STT/
 * TTS stacks — and served same-origin from /vad/ so the page never touches a
 * CDN at runtime. Nothing here is committed to the repo.
 */

export interface VadAsset {
  /** File name on disk AND the /vad/<name> route. Exact-match whitelist. */
  name: string;
  url: string;
  sha256: string;
  /** Exact expected size — doubles as the download's hard cap. */
  bytes: number;
  contentType: string;
}

export const VAD_ASSETS: readonly VadAsset[] = [
  {
    name: "ort.wasm.min.js",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js",
    sha256: "65e09376df69107e881b5c34d2d37aed333a366b6d941073ec518168e269b87d",
    bytes: 48327,
    contentType: "text/javascript",
  },
  {
    name: "ort-wasm-simd-threaded.mjs",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs",
    sha256: "30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8",
    bytes: 20856,
    contentType: "text/javascript",
  },
  {
    name: "ort-wasm-simd-threaded.wasm",
    url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm",
    sha256: "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4",
    bytes: 11210254,
    contentType: "application/wasm",
  },
  {
    name: "silero_vad_v5.onnx",
    url: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/silero_vad_v5.onnx",
    sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
    bytes: 2327524,
    contentType: "application/octet-stream",
  },
];

export const VAD_ASSET_BY_NAME: ReadonlyMap<string, VadAsset> = new Map(VAD_ASSETS.map((a) => [a.name, a]));

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

async function isValid(path: string, asset: VadAsset): Promise<boolean> {
  const f = Bun.file(path);
  if (!(await f.exists()) || f.size !== asset.bytes) return false;
  return (await sha256Hex(await f.arrayBuffer())) === asset.sha256;
}

export interface EnsureVadAssetsResult {
  /** Every asset present and hash-verified. */
  ready: boolean;
  fetched: number;
  failures: string[];
}

/**
 * Idempotent: valid files are left alone; anything missing, truncated, or
 * hash-mismatched is (re)fetched with an absolute deadline and the exact
 * expected size as a hard cap, verified, and atomically renamed into place.
 * A failure never leaves a partial file behind under the asset's name.
 */
export async function ensureVadAssets(
  dir: string,
  opts: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMsPerAsset?: number } = {},
): Promise<EnsureVadAssetsResult> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMsPerAsset ?? 120_000;
  const { mkdir, rename, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(dir, { recursive: true });

  let fetched = 0;
  const failures: string[] = [];
  for (const asset of VAD_ASSETS) {
    opts.signal?.throwIfAborted();
    const dest = join(dir, asset.name);
    if (await isValid(dest, asset)) continue;
    const tmp = `${dest}.download`;
    try {
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const res = await fetcher(asset.url, { signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? asset.bytes);
      if (declared > asset.bytes) throw new Error(`declared ${declared} bytes, expected ${asset.bytes}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength !== asset.bytes) throw new Error(`got ${buf.byteLength} bytes, expected ${asset.bytes}`);
      const digest = await sha256Hex(buf);
      if (digest !== asset.sha256) throw new Error(`sha256 mismatch (${digest.slice(0, 12)}…)`);
      await Bun.write(tmp, buf);
      await rename(tmp, dest);
      fetched++;
    } catch (err) {
      await unlink(tmp).catch(() => { /* nothing partial to clean */ });
      if (opts.signal?.aborted) throw err;
      failures.push(`${asset.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let ready = failures.length === 0;
  if (ready) {
    for (const asset of VAD_ASSETS) {
      if (!(await isValid(join(dir, asset.name), asset))) { ready = false; break; }
    }
  }
  return { ready, fetched, failures };
}
