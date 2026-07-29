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
  recordUntilSilence: (grace?: number) => Promise<{ status: "ok"; path: string }>;
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
