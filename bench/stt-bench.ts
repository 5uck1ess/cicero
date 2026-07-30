/**
 * Cicero STT bench — compare transcription backends on real clips.
 *
 * Mirrors how Pocket-TTS was picked via tts-bench: measure empirically, don't
 * guess. For each candidate × clip it records accuracy (WER vs the reference
 * transcript), latency (wall-clock to transcribe), and real-time factor
 * (process-time / audio-duration), then prints a ranked table and writes a
 * markdown report.
 *
 * Two measurement modes, reported in separate tables because their latencies are
 * not comparable:
 *
 *  - `provider` / `command` candidates are **batch**: transcribe a whole clip,
 *    time it end to end. Right axis for accuracy (WER) and throughput (RTF), and
 *    it surfaces cold-vs-warm load cost.
 *  - `stream` candidates drive audio.cpp's `POST /v1/audio/transcriptions/live`,
 *    feeding PCM at real-time pace and timing the SSE deltas: first partial,
 *    partials arriving *during* capture, and time-to-final measured from the end
 *    of the audio. This is what a live loop actually feels.
 *
 * Streaming still doesn't tell you how a model handles your room and your mic —
 * every clip here is a recording. Confirm the shortlist with a live mic test.
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
import { transcribeLive, type LiveStreamConnect } from "./stt/live-stream";
import type { Candidate, Clip, ProviderCandidate, StreamCandidate } from "./stt/types";

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

/** Build a transcribe(path)→text fn for a batch candidate, or null if it's unavailable. */
async function makeRunner(
  c: Exclude<Candidate, StreamCandidate>,
): Promise<((audioPath: string) => Promise<string>) | null> {
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

export const median = (xs: number[]): number => {
  // NaN, not 0, for no samples. Every consumer of this is a latency or accuracy
  // column, where 0 reads as "instant" or "perfect" — the opposite of "we never
  // got a measurement". `fmt` renders non-finite as "n/a".
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Streaming-only metrics; absent on batch rows, which have no meaningful value for them. */
interface StreamStats {
  firstDeltaMs: number;      // median across clips, from the first PCM byte
  finalAfterAudioMs: number; // median; negative = transcript done before the audio ended
  deltasDuringAudio: number; // summed over clips (first run)
  deltas: number;            // summed over clips (first run)
  /**
   * The audio was fed at real time. When it was not (`pace: "fast"`), every
   * latency here is measured against a clock the model never had to keep, so
   * they are withheld rather than printed — a fast probe answers "does it
   * respond at all", not "how quickly does it answer a speaker".
   */
  paced: boolean;
}

interface Row {
  name: string;
  /**
   * Which table this row belongs in. Explicit rather than inferred from the
   * presence of `streaming`, because a candidate that never started has no
   * metrics to infer from — an unreachable streaming server was being listed
   * as skipped under the batch heading.
   */
  kind: "batch" | "stream";
  available: boolean;
  meanWerPct: number;
  warmMs: number;       // median warm transcribe time
  coldMs: number;       // first (cold) transcribe time
  rtf: number;          // warmMs / audioDuration; <1 = faster than realtime
  errors: number;       // clips that failed/empty
  clips: number;
  streaming?: StreamStats;
}

const emptyRow = (name: string, available: boolean, kind: Row["kind"]): Row =>
  ({ name, kind, available, meanWerPct: NaN, warmMs: NaN, coldMs: NaN, rtf: NaN, errors: 0, clips: 0 });

/*
 * A candidate host that silently drops SYNs would otherwise hold this probe for
 * the OS TCP timeout — minutes, before the bench has measured anything. Five
 * seconds is generous for a reachable host on a LAN or over a VPN, and a host
 * slower than that is not one these timings would mean anything against.
 */
const PORT_PROBE_TIMEOUT_MS = 5_000;

/** Cheap liveness probe — a stream candidate has no provider `health()` to ask. */
export async function portOpen(
  host: string,
  port: number,
  options: { timeoutMs?: number; connect?: LiveStreamConnect } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? PORT_PROBE_TIMEOUT_MS;
  const connect = options.connect ?? ((connectOptions) => Bun.connect(connectOptions));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const connecting = connect({ hostname: host, port, socket: { data: () => {} } });
  // A socket that arrives after the probe gave up still has to be released, or
  // the bench leaks one per unreachable candidate.
  void connecting.then((sock) => { if (expired) sock.terminate(); }, () => {});
  try {
    const sock = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error(`no connection to ${host}:${port} within ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
    sock.end();
    return true;
  } catch { return false; } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Feed each clip at real-time pace and time the deltas. Note the wall-clock cost:
 * a real-time feed spends at least the clip's duration per run, so a 75s clip set
 * at 3 runs is ~4 minutes per candidate before the model does any work.
 */
export async function benchStreamCandidate(c: StreamCandidate, clips: Clip[], runs: number): Promise<Row> {
  const host = c.host ?? "127.0.0.1";
  if (!(await portOpen(host, c.port))) {
    console.warn(`  ⚠️  ${c.name}: nothing listening on ${host}:${c.port} — skipping`);
    return emptyRow(c.name, false, "stream");
  }

  const wers: number[] = [];
  const firstDeltas: number[] = [];
  const finals: number[] = [];
  const totals: number[] = [];
  let deltasDuringAudio = 0;
  let deltas = 0;
  let errors = 0;

  for (const clip of clips) {
    const clipFirst: number[] = [];
    const clipFinal: number[] = [];
    const clipTotal: number[] = [];
    let transcript = "";
    // Staged, not accumulated: run 0's counts belong to a clip that has not
    // finished its repetitions yet, and folding them in here left the deltas of
    // a clip rejected by a later failed run standing in the candidate's totals —
    // a table reading "10 / 11" for a candidate that scored no clips at all.
    let clipDeltasDuringAudio = 0;
    let clipDeltas = 0;
    let failed = false;
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      try {
        const res = await transcribeLive(clip.path, c);
        clipTotal.push(performance.now() - t0);
        clipFinal.push(res.finalAfterAudioMs);
        if (res.firstDeltaMs !== null) clipFirst.push(res.firstDeltaMs);
        if (r === 0) {
          transcript = res.text;
          clipDeltas = res.deltas;
          clipDeltasDuringAudio = res.deltasDuringAudio;
        }
      } catch (err: unknown) {
        failed = true;
        console.warn(`  ⚠️  ${c.name} / ${clip.name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
    // A clip counts only when every repetition finished. Scoring one that
    // failed run 2 of 3 mixes a median over one sample into a column read as a
    // median over three, and reports errors=0 for a clip that errored.
    if (failed || !transcript) { errors++; continue; }

    // Committed at the same point as the WER and latency medians below: past
    // the rejection, where the clip is known to have completed every run.
    deltas += clipDeltas;
    deltasDuringAudio += clipDeltasDuringAudio;
    const { wer } = wordErrorRate(clip.reference, transcript);
    wers.push(wer * 100);
    if (clipFirst.length) firstDeltas.push(median(clipFirst));
    if (clipFinal.length) finals.push(median(clipFinal));
    if (clipTotal.length) totals.push(median(clipTotal));
  }

  // A fast upload finishes long before the clip would have been spoken, so
  // "before the audio ended" is measured against an instant that never
  // happened: a 10s clip answered at 100ms records -9,900ms time-to-final and
  // counts every delta as arriving "during" audio. Those are not latencies.
  const paced = c.pace !== "fast";
  return {
    ...emptyRow(c.name, true, "stream"),
    meanWerPct: wers.length ? wers.reduce((a, b) => a + b, 0) / wers.length : NaN,
    warmMs: median(totals),
    errors,
    clips: wers.length,
    streaming: {
      // NaN, not 0, when a model emitted no partial at all — 0 would read as
      // "instant" in a latency column, which is the opposite of what happened.
      firstDeltaMs: paced && firstDeltas.length ? median(firstDeltas) : NaN,
      finalAfterAudioMs: paced ? median(finals) : NaN,
      deltasDuringAudio: paced ? deltasDuringAudio : NaN,
      paced,
      deltas,
    },
  };
}

async function benchCandidate(c: Candidate, clips: Clip[], runs: number): Promise<Row> {
  if (c.kind === "stream") return benchStreamCandidate(c, clips, runs);

  const runner = await makeRunner(c);
  if (!runner) return emptyRow(c.name, false, "batch");

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
    if (failed || !transcript) { errors++; continue; }

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
    kind: "batch",
    available: true,
    meanWerPct: wers.length ? wers.reduce((a, b) => a + b, 0) / wers.length : NaN,
    warmMs: median(warmTimes),
    coldMs: median(coldTimes),
    rtf: median(rtfs),
    errors,
    clips: wers.length,
  };
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

/**
 * Rows that scored at least one clip, best WER first. A candidate whose every
 * run failed is deliberately NOT here: it has no WER to rank by, and leaving it
 * in put it at the top of a table sorted ascending — a candidate that produced
 * nothing rendered as the most accurate one.
 */
const ranked = (rows: Row[], kind: Row["kind"]): Row[] =>
  rows.filter((r) => r.kind === kind && r.available && r.clips > 0)
    .sort((a, b) => a.meanWerPct - b.meanWerPct);

/** Reachable, but every run failed — reported, never ranked. */
const allFailed = (rows: Row[], kind: Row["kind"]): Row[] =>
  rows.filter((r) => r.kind === kind && r.available && r.clips === 0);

/** Never started at all — listed under its own kind's table, not somebody else's. */
const skipped = (rows: Row[], kind: Row["kind"]): Row[] =>
  rows.filter((r) => r.kind === kind && !r.available);

const skippedLine = (r: Row): string =>
  `- ${r.name} (unavailable — server down or command missing)`;

const failedLine = (r: Row): string =>
  `- ${r.name} (reachable, but every clip failed — ${r.errors} ${r.errors === 1 ? "error" : "errors"}; no metrics)`;

export function renderTable(rows: Row[]): string {
  const avail = ranked(rows, "batch");
  const header = "| Candidate | WER % | warm ms | cold ms | RTF | errors | clips |";
  const sep = "|---|---:|---:|---:|---:|---:|---:|";
  const lines = avail.map((r) =>
    `| ${r.name} | ${fmt(r.meanWerPct)} | ${fmt(r.warmMs, 0)} | ${fmt(r.coldMs, 0)} | ${r.rtf ? fmt(r.rtf, 3) : "n/a"} | ${r.errors} | ${r.clips} |`,
  );
  const failed = allFailed(rows, "batch").map(failedLine);
  const notStarted = skipped(rows, "batch").map(skippedLine);
  return [
    header, sep, ...lines,
    ...(failed.length ? ["", "**Failed:**", ...failed] : []),
    ...(notStarted.length ? ["", "**Skipped:**", ...notStarted] : []),
  ].join("\n");
}

/**
 * Streaming rows get their own table: "warm ms" for a real-time feed is dominated
 * by the clip's own duration, so putting it beside a batch latency would invite a
 * comparison that means nothing. Time-to-final is measured from the end of the
 * audio, which is the number a live loop actually waits out.
 */
export function renderStreamingTable(rows: Row[]): string {
  const avail = ranked(rows, "stream");
  const failed = allFailed(rows, "stream");
  const notStarted = skipped(rows, "stream");
  if (!avail.length && !failed.length && !notStarted.length) return "";
  const header = "| Candidate | WER % | first delta ms | deltas during audio | final after audio ms | errors | clips |";
  const sep = "|---|---:|---:|---:|---:|---:|---:|";
  const lines = avail.map((r) => {
    const s = r.streaming!;
    const during = !s.paced ? "n/a"
      : s.deltas ? `${s.deltasDuringAudio} / ${s.deltas}` : "0";
    // A fast probe is still a real accuracy measurement, so it is ranked — but
    // it is named as what it is, because every latency on its row is withheld.
    const name = s.paced ? r.name : `${r.name} (fast probe)`;
    return `| ${name} | ${fmt(r.meanWerPct)} | ${fmt(s.firstDeltaMs, 0)} | ${during} | ${fmt(s.finalAfterAudioMs, 0)} | ${r.errors} | ${r.clips} |`;
  });
  return [
    "### Streaming (real-time feed, `/v1/audio/transcriptions/live`)",
    "",
    header, sep, ...lines,
    ...(failed.length ? ["", "**Failed:**", ...failed.map(failedLine)] : []),
    ...(notStarted.length ? ["", "**Skipped:**", ...notStarted.map(skippedLine)] : []),
    "",
    "_`first delta` is from the first PCM byte; `final after audio` is `transcript.text.done`"
    + " relative to the last sample (negative = done before the audio ended). `n/a` first delta"
    + " means the model emitted no partial at all — it buffers internally and behaves like a"
    + " batch model over this endpoint._",
    "",
    "_A `(fast probe)` row was fed as quickly as the socket accepted it rather than at real"
    + " time, so its latency columns are withheld: they would be measured against a clock the"
    + " model never had to keep. Its WER is a real measurement. Re-run it without"
    + " `\"pace\": \"fast\"` to get latencies._",
  ].join("\n");
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
  const streamTable = renderStreamingTable(rows);
  console.log(`\n${table}\n`);
  if (streamTable) console.log(`${streamTable}\n`);
  console.log("RTF < 1 = faster than real-time. WER lower = better. Recorded clips only — confirm the shortlist with a live mic test.");

  const stamp = new Date().toISOString();
  const report = [
    `# STT bench — ${stamp}`,
    "",
    `Clips: ${clips.length} (${totalAudio.toFixed(1)}s), runs/clip: ${args.runs}`,
    "",
    "### Batch (whole-clip transcribe)",
    "",
    table,
    ...(streamTable ? ["", streamTable] : []),
    "",
    "_Every clip here is a recording: this measures accuracy, batch latency and streaming"
    + " time-to-final, not how a model copes with your room and mic._",
    "",
  ].join("\n");
  // Archived under a run stamp as well, because last-results.md is overwritten on
  // every run — losing a sweep to a one-candidate re-run is otherwise easy.
  const archivePath = resolve(`bench/stt/results/${stamp.replace(/[:.]/g, "-")}.md`);
  const reportPath = resolve("bench/stt/last-results.md");
  await Bun.write(archivePath, report);
  await Bun.write(reportPath, report);
  console.log(`\nReport written to ${reportPath} (archived: ${archivePath})`);
}

// Only run the sweep when this file IS the entry point. Without the guard,
// importing anything from here — as the liveness-probe regression does — starts
// a whole bench run as a side effect of the import.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`STT bench failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
