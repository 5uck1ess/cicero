/**
 * Cicero STT bench — compare transcription backends on real clips.
 *
 * Mirrors how Pocket-TTS was picked via tts-bench: measure empirically, don't
 * guess. For each candidate × clip it records accuracy (WER vs the reference
 * transcript), latency (wall-clock to transcribe), and real-time factor
 * (process-time / audio-duration), then prints a ranked table and writes a
 * markdown report.
 *
 * SCOPE / HONEST LIMITATION: this is a *batch* bench — it transcribes whole
 * clips. That's the right axis for accuracy (WER) and throughput (RTF), and it
 * surfaces cold-vs-warm load cost. It does NOT measure true *streaming*
 * time-to-first-partial / time-to-final, which is what a live loop actually feels
 * (see realtime-stt-selection-jun2026.md: STT streams while the user talks, so
 * its marginal latency is small and the LLM TTFT dominates). Use this to compare
 * accuracy + footprint + batch speed; confirm streaming feel with a live mic test
 * on the model you shortlist.
 *
 * Run:  bun run bench:stt
 *       bun run bench/stt-bench.ts --clips bench/stt/clips --candidates bench/stt/candidates.json --runs 3
 */
import { readdirSync, existsSync } from "fs";
import { join, basename, resolve } from "path";
import { decodeWav } from "../src/platform/wav";
import { MlxWhisperProvider } from "../src/backends/stt/mlx-whisper";
import { FasterWhisperProvider } from "../src/backends/stt/faster-whisper";
import type { STTProvider } from "../src/backends/stt/provider";
import { wordErrorRate } from "./stt/wer";
import type { Candidate, Clip, ProviderCandidate } from "./stt/types";

interface Args { clipsDir: string; candidatesFile: string; runs: number }

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    clipsDir: resolve(get("--clips") ?? "bench/stt/clips"),
    candidatesFile: resolve(get("--candidates") ?? "bench/stt/candidates.json"),
    runs: Math.max(1, Number(get("--runs") ?? process.env.BENCH_RUNS ?? 3)),
  };
}

/** Find every `X.wav` with a sibling `X.txt` ground-truth transcript. */
function findClipPaths(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".wav")) continue;
    const path = join(dir, file);
    if (!existsSync(path.replace(/\.wav$/i, ".txt"))) {
      console.warn(`  ⚠️  ${file} has no sibling .txt reference — skipping`);
      continue;
    }
    paths.push(path);
  }
  return paths;
}

/** Read each clip's reference transcript and decode its duration. */
async function loadClips(dir: string): Promise<Clip[]> {
  const out: Clip[] = [];
  for (const path of findClipPaths(dir)) {
    const reference = (await Bun.file(path.replace(/\.wav$/i, ".txt")).text()).trim();
    let durationSec = 0;
    try {
      const { samples, sampleRate } = decodeWav(await Bun.file(path).arrayBuffer());
      durationSec = samples.length / sampleRate;
    } catch { /* leave 0 → RTF shown as n/a */ }
    out.push({ name: basename(path, ".wav"), path, reference, durationSec });
  }
  return out;
}

async function loadCandidates(file: string): Promise<Candidate[]> {
  if (existsSync(file)) {
    const parsed = JSON.parse(await Bun.file(file).text()) as { candidates?: Candidate[] };
    if (parsed.candidates?.length) return parsed.candidates;
  }
  // Default: just the current deployed baseline.
  console.warn(`  ℹ️  no candidates file at ${file} — defaulting to the current mlx-whisper baseline`);
  return [{ name: "mlx-whisper (current)", kind: "provider", backend: "mlx-whisper", port: 8083 }];
}

function makeProvider(c: ProviderCandidate): STTProvider {
  const cfg = { host: c.host, port: c.port, model: c.model };
  return c.backend === "faster-whisper" ? new FasterWhisperProvider(cfg) : new MlxWhisperProvider(cfg);
}

/** Build a transcribe(path)→text fn for a candidate, or null if it's unavailable. */
async function makeRunner(c: Candidate): Promise<((audioPath: string) => Promise<string>) | null> {
  if (c.kind === "provider") {
    const provider = makeProvider(c);
    if (!(await provider.health())) {
      console.warn(`  ⚠️  ${c.name}: server not healthy (start it first) — skipping`);
      return null;
    }
    return async (audioPath) => (await provider.transcribe(audioPath)) ?? "";
  }
  // command candidate
  return async (audioPath) => {
    const cmd = c.command.replaceAll("{audio}", audioPath);
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const [out, , exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) throw new Error(`command exited ${exit}`);
    return out.trim();
  };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

interface Row {
  name: string;
  available: boolean;
  meanWerPct: number;
  warmMs: number;       // median warm transcribe time
  coldMs: number;       // first (cold) transcribe time
  rtf: number;          // warmMs / audioDuration; <1 = faster than realtime
  errors: number;       // clips that failed/empty
  clips: number;
}

async function benchCandidate(c: Candidate, clips: Clip[], runs: number): Promise<Row> {
  const runner = await makeRunner(c);
  if (!runner) return { name: c.name, available: false, meanWerPct: 0, warmMs: 0, coldMs: 0, rtf: 0, errors: 0, clips: 0 };

  const wers: number[] = [];
  const warmTimes: number[] = [];
  const coldTimes: number[] = [];
  const rtfs: number[] = [];
  let errors = 0;

  for (const clip of clips) {
    const times: number[] = [];
    let transcript = "";
    let failed = false;
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      try {
        const text = await runner(clip.path);
        const dt = performance.now() - t0;
        times.push(dt);
        if (r === 0) transcript = text; // score the first run's output
        if (!text) failed = true;
      } catch (err: unknown) {
        failed = true;
        console.warn(`  ⚠️  ${c.name} / ${clip.name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    if (failed && !transcript) { errors++; continue; }

    const { wer } = wordErrorRate(clip.reference, transcript);
    wers.push(wer * 100);
    if (times.length) {
      coldTimes.push(times[0]!);
      const warm = times.length > 1 ? median(times.slice(1)) : times[0]!;
      warmTimes.push(warm);
      if (clip.durationSec > 0) rtfs.push(warm / 1000 / clip.durationSec);
    }
  }

  return {
    name: c.name,
    available: true,
    meanWerPct: wers.length ? wers.reduce((a, b) => a + b, 0) / wers.length : 0,
    warmMs: median(warmTimes),
    coldMs: median(coldTimes),
    rtf: median(rtfs),
    errors,
    clips: wers.length,
  };
}

function renderTable(rows: Row[]): string {
  const avail = rows.filter((r) => r.available).sort((a, b) => a.meanWerPct - b.meanWerPct);
  const header = "| Candidate | WER % | warm ms | cold ms | RTF | errors | clips |";
  const sep = "|---|---:|---:|---:|---:|---:|---:|";
  const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
  const lines = avail.map((r) =>
    `| ${r.name} | ${fmt(r.meanWerPct)} | ${fmt(r.warmMs, 0)} | ${fmt(r.coldMs, 0)} | ${r.rtf ? fmt(r.rtf, 3) : "n/a"} | ${r.errors} | ${r.clips} |`,
  );
  const skipped = rows.filter((r) => !r.available).map((r) => `- ${r.name} (unavailable — server down or command missing)`);
  return [header, sep, ...lines, ...(skipped.length ? ["", "**Skipped:**", ...skipped] : [])].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  console.log("🎙️  Cicero STT bench\n");

  const clips = await loadClips(args.clipsDir);
  if (!clips.length) {
    console.error(`No clips found in ${args.clipsDir}.`);
    console.error("Add WAV files with a sibling .txt reference (clip1.wav + clip1.txt). See bench/stt/README.md.");
    process.exit(1);
  }
  const totalAudio = clips.reduce((s, c) => s + c.durationSec, 0);
  console.log(`Clips: ${clips.length} (${totalAudio.toFixed(1)}s audio), runs/clip: ${args.runs}\n`);

  const candidates = await loadCandidates(args.candidatesFile);
  const rows: Row[] = [];
  for (const c of candidates) {
    console.log(`▶ ${c.name} …`);
    rows.push(await benchCandidate(c, clips, args.runs));
  }

  const table = renderTable(rows);
  console.log(`\n${table}\n`);
  console.log("RTF < 1 = faster than real-time. WER lower = better. Batch latency only — confirm streaming feel live.");

  const report = [
    `# STT bench — ${new Date().toISOString()}`,
    "",
    `Clips: ${clips.length} (${totalAudio.toFixed(1)}s), runs/clip: ${args.runs}`,
    "",
    table,
    "",
    "_Batch transcribe latency + accuracy. Does NOT measure streaming time-to-final — confirm that with a live mic test._",
    "",
  ].join("\n");
  const reportPath = resolve("bench/stt/last-results.md");
  await Bun.write(reportPath, report);
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((err: unknown) => {
  console.error(`STT bench failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
