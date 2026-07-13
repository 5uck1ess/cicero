import { test, expect, describe } from "bun:test";
import { WyomingTTSProvider } from "../src/backends/tts/wyoming";
import { pcmFromWav } from "../src/backends/wyoming/audio";
import type { WyomingTransport } from "../src/backends/wyoming/client";
import type { WyomingEvent } from "../src/backends/wyoming/types";

function mockTransport(replies: WyomingEvent[]): WyomingTransport & { sent: WyomingEvent[] } {
  const sent: WyomingEvent[] = [];
  const queue = [...replies];
  return {
    sent,
    async send(event) {
      sent.push(event);
    },
    async receive() {
      const e = queue.shift();
      if (!e) throw new Error("queue empty");
      return e;
    },
    async receiveOfType(type) {
      let e: WyomingEvent | undefined;
      while ((e = queue.shift())) if (e.type === type) return e;
      throw new Error(`no ${type}`);
    },
    async describe() {
      return { type: "info", data: {} };
    },
    close() {},
  };
}

describe("WyomingTTSProvider", () => {
  test("name is 'wyoming'", () => {
    expect(new WyomingTTSProvider({ host: "127.0.0.1", port: 10200 }).name).toBe("wyoming");
  });

  test("synthesize collects audio chunks into a WAV", async () => {
    const c1 = new Uint8Array([10, 20, 30, 40]);
    const c2 = new Uint8Array([50, 60]);
    const transport = mockTransport([
      { type: "audio-start", data: { rate: 22050, width: 2, channels: 1 } },
      { type: "audio-chunk", data: {}, payload: c1 },
      { type: "audio-chunk", data: {}, payload: c2 },
      { type: "audio-stop", data: {} },
    ]);
    const p = new WyomingTTSProvider({ host: "127.0.0.1", port: 10200 }, () => transport);
    const wav = new Uint8Array(await p.generateAudio("hello"));

    // The synthesize request carries the text.
    expect(transport.sent[0]!.type).toBe("synthesize");
    expect(transport.sent[0]!.data?.text).toBe("hello");

    const { pcm, format } = pcmFromWav(wav);
    expect(format.rate).toBe(22050);
    expect(Array.from(pcm)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  test("synthesize tolerates a stream with no chunks", async () => {
    const transport = mockTransport([
      { type: "audio-start", data: { rate: 16000, width: 2, channels: 1 } },
      { type: "audio-stop", data: {} },
    ]);
    const p = new WyomingTTSProvider({ host: "127.0.0.1", port: 10200 }, () => transport);
    const wav = new Uint8Array(await p.generateAudio("hi"));
    const { pcm } = pcmFromWav(wav);
    expect(pcm.byteLength).toBe(0);
  });

  test("rejects audio that exceeds the configured aggregate cap", () => {
    const transport = mockTransport([
      { type: "audio-chunk", data: {}, payload: new Uint8Array([1, 2]) },
      { type: "audio-chunk", data: {}, payload: new Uint8Array([3, 4]) },
      { type: "audio-stop", data: {} },
    ]);
    const provider = new WyomingTTSProvider(
      { host: "127.0.0.1", port: 10200, maxAudioBytes: 3 },
      () => transport,
    );
    return expect(provider.generateAudio("too much")).rejects.toThrow(
      "Wyoming TTS audio exceeds 3 bytes",
    );
  });

  test("uses one absolute deadline while audio chunks keep arriving", async () => {
    let closed = false;
    const transport: WyomingTransport = {
      async send() {},
      async receive() {
        await Bun.sleep(10);
        return { type: "audio-chunk", data: {}, payload: new Uint8Array([1]) };
      },
      async receiveOfType() {
        throw new Error("not used");
      },
      async describe() {
        return { type: "info", data: {} };
      },
      close() {
        closed = true;
      },
    };
    const provider = new WyomingTTSProvider(
      { host: "127.0.0.1", port: 10200, responseTimeoutMs: 25 },
      () => transport,
    );
    try {
      await expect(provider.generateAudio("endless")).rejects.toThrow(
        "Wyoming TTS response timed out after 25ms",
      );
      expect(closed).toBe(true);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  });

  test("validates response limits at construction", () => {
    expect(() => new WyomingTTSProvider({ port: 10200, maxAudioBytes: 0 })).toThrow(
      "maxAudioBytes must be a positive safe integer",
    );
  });

  test("an explicit lane voice overrides the configured Wyoming voice", async () => {
    const transport = mockTransport([
      { type: "audio-start", data: { rate: 16000, width: 2, channels: 1 } },
      { type: "audio-stop", data: {} },
    ]);
    const p = new WyomingTTSProvider(
      { host: "127.0.0.1", port: 10200, voice: "configured" },
      () => transport,
    );
    await p.generateAudio("hello", "lane-voice");
    expect(transport.sent[0]?.data?.voice).toEqual({ name: "lane-voice" });
  });
});
