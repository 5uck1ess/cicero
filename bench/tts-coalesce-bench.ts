/**
 * Cicero TTS coalescing bench — does merging adjacent sentences actually help?
 *
 * Coalescing trades per-call synthesis overhead against Cicero's tuned
 * per-sentence first-audio latency. Which way that trade lands is an empirical
 * question about a specific engine on specific hardware, so this measures it
 * instead of assuming. Same posture as tts-bench and stt-bench: measure, then
 * decide.
 *
 * The two numbers that matter, and they point in opposite directions:
 *
 *   TTFA  time to first audio — how long before the user hears ANYTHING.
 *         This is the headline property of the streaming speaker. Coalescing
 *         must not move it.
 *   TOTAL wall-clock to synthesize the whole reply. This is what coalescing is
 *         supposed to improve, by making fewer, larger calls.
 *
 * A win is: TTFA unchanged (within noise) and TOTAL meaningfully lower. TTFA can
 * only regress at `passthroughFirst: 0`, where sentence one is eligible to be
 * merged; raising it to 1 fixes that. Above 1 it protects later sentences, not
 * first audio, so a TTFA regression at 1 or higher is the engine, not the knob.
 *
 * The third number, and the reason coalescing could be a bad trade even when
 * both of the above look good:
 *
 *   SLACK the smallest gap between when a chunk finished synthesizing and when
 *         playback of everything before it runs out of audio. Coalescing makes
 *         chunk 2 bigger, so it arrives later; if it arrives after sentence 1
 *         has finished playing, the user hears a gap. Positive slack means the
 *         synthesizer stayed ahead of the speaker. Negative means it starved.
 *
 * SLACK is computed from the decoded duration of each returned WAV against the
 * measured arrival times, assuming playback starts the moment the first chunk
 * lands and runs at real time. That models the pipeline, not the sound card:
 * device buffering, resampling, and the player's own scheduling are not in it.
 * So treat a small positive slack as "needs a live listen", not "proven fine".
 *
 * Run:  bun run bench/tts-coalesce-bench.ts --url http://127.0.0.1:8092 --runs 5
 */
import { coalesceSentences } from "../src/speaker/coalesce";
import { segmentSentences } from "../src/speaker/sentence-stream";
import { inspectWavMetadata } from "../src/platform/wav";

interface Args {
  url: string;
  model: string;
  voice: string;
  voiceRef: string;
  runs: number;
  maxChars: number;
  passthroughFirst: number;
  overheadMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  return {
    url: get("--url", "http://127.0.0.1:8092").replace(/\/$/, ""),
    model: get("--model", "pocket-tts"),
    voice: get("--voice", ""),
    voiceRef: get("--voice-ref", ""),
    runs: Number(get("--runs", "5")),
    maxChars: Number(get("--max-chars", "240")),
    passthroughFirst: Number(get("--passthrough-first", "1")),
    overheadMs: Number(get("--overhead-ms", "0")),
  };
}

/** Replies of the shape Cicero actually speaks: a few sentences, varying length. */
const REPLIES: Array<{ name: string; text: string }> = [
  {
    name: "short (2 sentences)",
    text: "The deploy finished. Two tests failed on the staging box.",
  },
  {
    name: "typical (5 sentences)",
    text: "I checked the log. The parser is dropping frames when the queue backs up. "
      + "It looks like the timeout is too aggressive. I raised it to thirty seconds. "
      + "The last three runs were clean.",
  },
  {
    name: "long (10 sentences)",
    text: "Here is what I found. The service was restarting every few minutes. "
      + "The health check was hitting the wrong port. That port was closed by the firewall change last week. "
      + "So the supervisor kept marking it unhealthy. I pointed the check at the right port. "
      + "It has been stable for an hour now. I also added a log line for the next time. "
      + "Nothing else in the config looked wrong. Let me know if you want the firewall change reverted.",
  },
];

async function* tokensOf(text: string): AsyncGenerator<string> {
  // One token per word, as a streaming brain would produce it.
  for (const word of text.split(/(\s+)/)) yield word;
}

interface Timing { ttfaMs: number; totalMs: number; calls: number; slackMs: number }

/**
 * Smallest margin by which synthesis stayed ahead of playback.
 *
 * Playback starts when chunk 0 arrives and then runs continuously, so chunk i
 * is needed at `arrival[0] + sum(duration[0..i-1])`. The margin for that chunk
 * is how long before that instant it actually arrived. The minimum across the
 * reply is the one that decides whether the user hears a gap.
 */
function playbackSlackMs(arrivals: number[], durations: number[]): number {
  let needed = arrivals[0]!;
  let slack = Infinity;
  for (let i = 1; i < arrivals.length; i += 1) {
    needed += durations[i - 1]!;
    slack = Math.min(slack, needed - arrivals[i]!);
  }
  // A single-chunk reply can never starve: there is no follow-on to be late.
  return Number.isFinite(slack) ? slack : Infinity;
}

/** Synthesize a reply chunk by chunk, timing first audio and the whole run. */
async function synthesize(
  chunks: AsyncIterable<string>,
  speak: (text: string) => Promise<ArrayBuffer>,
): Promise<Timing> {
  const start = performance.now();
  const arrivals: number[] = [];
  const durations: number[] = [];
  for await (const chunk of chunks) {
    const wav = await speak(chunk);
    arrivals.push(performance.now() - start);
    durations.push(inspectWavMetadata(wav).durationMs);
  }
  return {
    ttfaMs: arrivals[0] ?? 0,
    totalMs: performance.now() - start,
    calls: arrivals.length,
    slackMs: playbackSlackMs(arrivals, durations),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const endpoint = `${args.url}/v1/audio/speech`;

  // Same body shape the audiocpp provider sends: model + input, and at most one
  // of voice_ref / voice. Sending fields the engine doesn't expect is a 500, and
  // sending a voice the engine has to prepare mid-bench times the voice prep,
  // not the synthesis.
  const payload: Record<string, unknown> = { model: args.model };
  if (args.voiceRef) payload.voice_ref = args.voiceRef;
  else if (args.voice) payload.voice = args.voice;

  const speak = async (text: string): Promise<ArrayBuffer> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, input: text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`TTS ${res.status}: ${detail.slice(0, 200)}`);
    }
    const audio = await res.arrayBuffer();
    // Modeled per-call overhead. A local GPU seat has almost none, which is why
    // coalescing barely moves anything against one; a hosted engine pays a TLS
    // round trip and queue wait on EVERY call, and that is the cost coalescing
    // actually removes. Sweeping this answers "how slow does my engine have to
    // be before this matters?" without billing a metered provider to find out.
    // It models latency only, not a real provider's behavior under load.
    if (args.overheadMs > 0) await Bun.sleep(args.overheadMs);
    return audio;
  };

  console.log(`endpoint: ${endpoint}`);
  console.log(
    `runs: ${args.runs}  maxChars: ${args.maxChars}  passthroughFirst: ${args.passthroughFirst}`
    + `  modeled per-call overhead: ${args.overheadMs}ms\n`,
  );

  // One warm-up so model load does not land in run 1.
  try {
    await speak("Warming up.");
  } catch (error: unknown) {
    console.error(`\nCannot reach the TTS endpoint: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Pass --url for your engine. This bench needs a real endpoint; there is nothing to measure without one.");
    process.exit(1);
  }

  const rows: string[] = [];
  for (const reply of REPLIES) {
    const baseline: Timing[] = [];
    const merged: Timing[] = [];
    for (let run = 0; run < args.runs; run += 1) {
      baseline.push(await synthesize(segmentSentences(tokensOf(reply.text)), speak));
      merged.push(await synthesize(
        coalesceSentences(segmentSentences(tokensOf(reply.text)), {
          maxChars: args.maxChars,
          passthroughFirst: args.passthroughFirst,
        }),
        speak,
      ));
    }
    const bTtfa = median(baseline.map((t) => t.ttfaMs));
    const mTtfa = median(merged.map((t) => t.ttfaMs));
    const bTotal = median(baseline.map((t) => t.totalMs));
    const mTotal = median(merged.map((t) => t.totalMs));
    const pct = (before: number, after: number): string => {
      const delta = ((after - before) / before) * 100;
      return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    };
    // Worst case across runs, not the median: one starved chunk is audible, and
    // averaging it against four clean runs hides exactly the failure we're
    // looking for.
    const worstSlack = (timings: Timing[]): number => Math.min(...timings.map((t) => t.slackMs));
    const bSlack = worstSlack(baseline);
    const mSlack = worstSlack(merged);
    const slack = (ms: number): string => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "n/a");
    rows.push(
      `${reply.name.padEnd(22)} `
      + `TTFA ${bTtfa.toFixed(0).padStart(6)}ms → ${mTtfa.toFixed(0).padStart(6)}ms (${pct(bTtfa, mTtfa).padStart(7)})  `
      + `TOTAL ${bTotal.toFixed(0).padStart(6)}ms → ${mTotal.toFixed(0).padStart(6)}ms (${pct(bTotal, mTotal).padStart(7)})  `
      + `calls ${baseline[0]!.calls} → ${merged[0]!.calls}  `
      + `SLACK ${slack(bSlack).padStart(6)} → ${slack(mSlack).padStart(6)}`,
    );
  }

  console.log("reply                  baseline → coalesced");
  console.log("─".repeat(132));
  for (const row of rows) console.log(row);
  console.log(
    "\nAdopt only if TTFA is unchanged within noise AND total drops meaningfully"
    + "\nAND coalesced slack stays comfortably positive."
    + "\nA TTFA regression at --passthrough-first 0 means raise it to 1; at 1 or"
    + "\nhigher the knob no longer touches first audio, so the engine is the cause."
    + "\nIf slack went negative or near zero, lower --max-chars: the chunks got"
    + "\nbigger than the audio ahead of them.",
  );
}

await main();
