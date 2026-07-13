/**
 * Cicero Apple-Silicon speed bench — STT + TTS on the real production providers.
 *
 * Drives the SAME MlxWhisperProvider / PocketTtsProvider the daemon uses (they
 * self-start the managed Python servers), so these are production-path numbers,
 * not a mock. STT is measured on real prior utterances from ~/.cicero/tmp; TTS is
 * measured by synthesizing representative sentences with the configured voice.
 *
 * Run:  bun run bench/mac-bench.ts
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MlxWhisperProvider } from "../src/backends/stt/mlx-whisper";
import { PocketTtsProvider } from "../src/backends/tts/pocket";
import { decodeWav } from "../src/platform/wav";

const RUNS = 5;
const MIN_CLIP_SEC = 3;
const TTS_VOICE = "michael";

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");

async function wavDurationSec(buf: ArrayBuffer): Promise<number> {
  const { samples, sampleRate } = decodeWav(buf);
  return samples.length / sampleRate;
}

async function pickClips(): Promise<{ path: string; dur: number }[]> {
  const dir = join(homedir(), ".cicero", "tmp");
  const out: { path: string; dur: number }[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^utterance-.*\.wav$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const { samples, sampleRate } = decodeWav(await Bun.file(path).arrayBuffer());
      const dur = samples.length / sampleRate;
      if (dur >= MIN_CLIP_SEC) out.push({ path, dur });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => a.dur - b.dur);
}

async function benchStt() {
  console.log("\n═══ STT — mlx-whisper (whisper-large-v3-turbo) ═══\n");
  const clips = await pickClips();
  if (!clips.length) { console.log("no usable clips in ~/.cicero/tmp"); return; }
  console.log(`clips: ${clips.length} (${f(clips.reduce((s, c) => s + c.dur, 0))}s audio), runs/clip: ${RUNS}\n`);

  const provider = new MlxWhisperProvider({});
  const warmMs: number[] = [], coldMs: number[] = [], rtfs: number[] = [];
  try {
    process.stdout.write("starting mlx-whisper server … ");
    const t0 = performance.now();
    await provider.start();
    console.log(`up in ${f((performance.now() - t0) / 1000)}s`);

    for (const { path, dur } of clips) {
      const times: number[] = [];
      let transcript = "";
      for (let r = 0; r < RUNS; r++) {
        const t = performance.now();
        const text = await provider.transcribe(path);
        times.push(performance.now() - t);
        if (r === 0) transcript = text ?? "";
      }
      const cold = times[0]!, warm = median(times.slice(1));
      coldMs.push(cold); warmMs.push(warm); rtfs.push(warm / 1000 / dur);
      console.log(`  ${f(dur)}s clip → warm ${f(warm, 0)}ms  cold ${f(cold, 0)}ms  RTF ${f(warm / 1000 / dur, 3)}`);
      console.log(`      “${transcript.slice(0, 90)}${transcript.length > 90 ? "…" : ""}”`);
    }
  } finally {
    await provider.stop().catch(() => {});
  }
  console.log(`\n  MEDIAN → warm ${f(median(warmMs), 0)}ms/clip · cold ${f(median(coldMs), 0)}ms · RTF ${f(median(rtfs), 3)} (${f(1 / median(rtfs), 1)}× realtime)`);
}

async function benchTts() {
  console.log("\n═══ TTS — pocket-tts (voice: " + TTS_VOICE + ") ═══\n");
  const sentences = [
    "Let me check the test results for you.",
    "I've opened a pull request with the fix on a new branch.",
    "That function returns a promise, so you'll need to await it.",
    "The build passed, but two of the integration tests are still failing.",
  ];
  const provider = new PocketTtsProvider({ voice: TTS_VOICE });
  const msPer: number[] = [], xrt: number[] = [];
  try {
    process.stdout.write("starting pocket-tts server … ");
    const t0 = performance.now();
    await provider.start();
    console.log(`up in ${f((performance.now() - t0) / 1000)}s`);
    await provider.warmup();

    for (const s of sentences) {
      const times: number[] = [];
      let audioSec = 0;
      for (let r = 0; r < RUNS; r++) {
        const t = performance.now();
        const buf = await provider.generateAudio(s);
        times.push(performance.now() - t);
        if (r === 0) audioSec = await wavDurationSec(buf);
      }
      const warm = median(times.slice(1));
      msPer.push(warm); xrt.push(audioSec / (warm / 1000));
      console.log(`  ${s.length}ch → ${f(audioSec)}s audio · synth warm ${f(warm, 0)}ms · ${f(audioSec / (warm / 1000), 1)}× realtime`);
    }
  } finally {
    await provider.stop().catch(() => {});
  }
  console.log(`\n  MEDIAN → ${f(median(msPer), 0)}ms/sentence · ${f(median(xrt), 1)}× realtime`);
}

async function main() {
  console.log("🎙️  Cicero Apple-Silicon speed bench");
  await benchStt();
  await benchTts();
  console.log("\ndone.\n");
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
