import { expect, test } from "bun:test";
import { ConversationalListener } from "../../src/listener/conversational";
import { ProviderSlot, SwappableSTTProvider } from "../../src/backends/hot-swap";
import type { STTProvider } from "../../src/backends/stt/provider";

// Round 6 (Codex): a Smart-Turn turn is transcribed segment by segment, with the
// mic reopening for a grace window in between. Every unpinned facade call takes
// whatever generation is current at that instant, so a swap landing mid-turn
// joined the OLD provider's words to the NEW provider's inside one utterance.
// The web path pins for exactly this reason; the local loop did not.

function provider(name: string): STTProvider {
  return {
    name,
    transcribe: async (file: string) => `${name}:${file.replace(/^.*segment/, "segment")}`,
    health: async () => true,
  };
}

type Stub = ConversationalListener & {
  active: boolean;
  activationEpoch: number;
  turnActive: boolean;
  captureTurn: (epoch?: number) => Promise<string | null>;
  recordUntilSilence: (grace?: number) => Promise<{ status: "ok"; path: string } | { status: "silent" }>;
  predictTurn: (wav: string, epoch: number) => Promise<{ complete: boolean; probability: number }>;
};

test("a swap between segments cannot mix two providers into one turn", async () => {
  const old = provider("old");
  const next = provider("next");
  const slot = new ProviderSlot<STTProvider>(old);
  const facade = new SwappableSTTProvider(slot);

  const listener = new ConversationalListener(
    facade as never, {} as never, { play: async () => {} } as never,
    false, "1.0", "3%", undefined, undefined, false, false,
  ) as Stub;
  listener.active = true;
  listener.turnActive = true; // a Smart-Turn detector is live

  let segment = 0;
  let swapped: Promise<void> | undefined;
  listener.recordUntilSilence = async () => {
    segment += 1;
    // The swap lands while the mic is reopened for the grace window — between
    // the first segment's transcription and the second's.
    if (segment === 2) {
      swapped = slot.swap(next, () => {});
      // Wait for the CUTOVER, not for swap() to resolve: the pin this turn holds
      // is precisely what keeps the retired generation draining until the turn
      // ends, so awaiting the whole swap here would deadlock on ourselves.
      while (slot.providerName !== "next") await Bun.sleep(1);
    }
    return { status: "ok", path: `/tmp/cicero-test-segment-${segment}.wav` };
  };
  // First segment reads as unfinished, so the turn continues; the second ends it.
  listener.predictTurn = async () => segment === 1
    ? { complete: false, probability: 0.1 }
    : { complete: true, probability: 0.99 };

  const transcript = await listener.captureTurn();
  await swapped;

  expect(segment).toBe(2);
  // Both halves come from the generation the turn STARTED on. Without the pin
  // this was "old:segment-1.wav next:segment-2.wav".
  expect(transcript).toBe("old:segment-1.wav old:segment-2.wav");

  // And the pin is released with the turn, so the retired generation drains.
  expect(slot.providerName).toBe("next");
  await slot.stop();
});

// Round 7 (Codex): VAD is on by default and reports `silent` after 30s without
// speech, and the capture loop `continue`s on that — so an ARMED BUT IDLE
// listener sits inside captureTurnSegments for as long as nobody talks. Pinning
// before the first recording therefore held the retired generation for that
// whole time: the swap's cutover committed, its post-cutover drain timed out,
// and `cicero swap` reported failure for a swap that had in fact taken effect.
// Every later swap then timed out behind the same lease.
test("an idle listener waiting for speech does not pin any generation", async () => {
  const old = provider("old");
  const next = provider("next");
  // A short deadline so the regression fails fast on the drain timeout instead
  // of hanging out the default 15s.
  const slot = new ProviderSlot<STTProvider>(old, { cleanupTimeoutMs: 200 });
  const facade = new SwappableSTTProvider(slot);

  const listener = new ConversationalListener(
    facade as never, {} as never, { play: async () => {} } as never,
    false, "1.0", "3%", undefined, undefined, false, false,
  ) as Stub;
  listener.active = true;
  listener.turnActive = true;

  let idleRounds = 0;
  let speaking = false;
  listener.recordUntilSilence = async () => {
    if (!speaking) {
      idleRounds += 1;
      await Bun.sleep(1); // nobody is talking; the loop stays armed
      return { status: "silent" };
    }
    return { status: "ok", path: "/tmp/cicero-test-segment-after-swap.wav" };
  };
  listener.predictTurn = async () => ({ complete: true, probability: 0.99 });

  const turn = listener.captureTurn();
  while (idleRounds < 2) await Bun.sleep(1); // armed, listening, nothing said

  // Nothing is in flight, so there is no generation to hold: this must settle
  // on its own. Before the fix it rejected on the post-cutover drain deadline.
  await slot.swap(next, () => {});
  expect(slot.providerName).toBe("next");

  // And the speech that finally arrives is transcribed by the replacement.
  speaking = true;
  expect(await turn).toBe("next:segment-after-swap.wav");
  await slot.stop();
});
