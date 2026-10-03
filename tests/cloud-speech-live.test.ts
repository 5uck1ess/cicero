import { expect, test } from "bun:test";
import { join } from "node:path";
import { SonioxSTTProvider } from "../src/backends/stt/soniox";
import { SonioxTTSProvider } from "../src/backends/tts/soniox";

// Live smoke test against the real Soniox API. Spends a few cents of credit and
// needs network access, so it never runs in CI:
//   CICERO_LIVE_TESTS=1 SONIOX_API_KEY=… bun test tests/cloud-speech-live.test.ts
const live = process.env.CICERO_LIVE_TESTS === "1" && Boolean(process.env.SONIOX_API_KEY);
const clip = join(import.meta.dir, "..", "assets", "setup", "hear-test.wav");
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

test.skipIf(!live)("live: Soniox speaks a sentence and recognizes it back, batch and streamed", async () => {
  const tts = new SonioxTTSProvider({ backend: "soniox" });
  expect(await tts.health()).toBe(true);
  const sentence = "The quick brown fox jumps over the lazy dog.";
  const ttsStart = performance.now();
  const wav = new Uint8Array(await tts.generateAudio(sentence));
  console.log(`soniox tts: ${Math.round(performance.now() - ttsStart)} ms for ${wav.byteLength} bytes`);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");

  const stt = new SonioxSTTProvider({ backend: "soniox", language: "en" });
  const path = join(process.env.TMPDIR ?? "/tmp", `cicero-soniox-live-${process.pid}.wav`);
  await Bun.write(path, wav);
  const batch = await stt.transcribeResult(path);
  expect(batch.kind).toBe("transcript");
  const heard = batch.kind === "transcript" ? words(batch.text) : [];
  expect(words(sentence).filter((w) => heard.includes(w)).length).toBeGreaterThanOrEqual(7);

  // Stream the same audio at real time, as the browser does, then finalize.
  const session = stt.openStream!({ sampleRate: 24_000 });
  const pcm = wav.subarray(44);
  const step = 4_800; // 100 ms at 24 kHz s16
  for (let offset = 0; offset < pcm.length; offset += step) {
    session.push(pcm.subarray(offset, Math.min(offset + step, pcm.length)));
    await Bun.sleep(100);
  }
  const ended = performance.now();
  const streamed = await session.end();
  console.log(`soniox live final: ${Math.round(performance.now() - ended)} ms after the last audio`);
  expect(words(sentence).filter((w) => words(streamed).includes(w)).length).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < 50 && !session.released; i++) await Bun.sleep(50);
  expect(session.released).toBe(true);
}, 60_000);

test.skipIf(!live)("live: the setup hear clip transcribes through Soniox", async () => {
  const result = await new SonioxSTTProvider({ backend: "soniox" }).transcribeResult(clip);
  expect(result.kind).toBe("transcript");
}, 30_000);
