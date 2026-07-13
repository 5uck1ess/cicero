import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WyomingSTTProvider } from "../src/backends/stt/wyoming";
import type { WyomingTransport } from "../src/backends/wyoming/client";
import type { WyomingEvent } from "../src/backends/wyoming/types";

/** Records sent events and replays a scripted sequence of received events. */
function mockTransport(replies: WyomingEvent[]): WyomingTransport & { sent: WyomingEvent[] } {
  const sent: WyomingEvent[] = [];
  const queue = [...replies];
  return {
    sent,
    async send(event) {
      sent.push(event);
    },
    async receive() {
      return queue.shift() ?? { type: "error", data: {} };
    },
    async receiveOfType(type) {
      let e: WyomingEvent | undefined;
      while ((e = queue.shift())) if (e.type === type) return e;
      throw new Error(`no ${type} in script`);
    },
    async describe() {
      return { type: "info", data: {} };
    },
    close() {},
  };
}

function writeWav(path: string, pcmBytes: number): void {
  const buf = Buffer.alloc(44 + pcmBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(pcmBytes + 36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcmBytes, 40);
  writeFileSync(path, buf);
}

describe("WyomingSTTProvider", () => {
  test("name is 'wyoming'", () => {
    const p = new WyomingSTTProvider({ host: "127.0.0.1", port: 10300 });
    expect(p.name).toBe("wyoming");
  });

  test("transcribe streams audio and returns the transcript text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wyoming-stt-"));
    const wav = join(dir, "a.wav");
    writeWav(wav, 40000); // ~1.25s of PCM → multiple chunks
    try {
      const transport = mockTransport([{ type: "transcript", data: { text: "  hello world  " } }]);
      const p = new WyomingSTTProvider({ host: "127.0.0.1", port: 10300 }, () => transport);
      const text = await p.transcribe(wav);
      expect(text).toBe("hello world");
      // audio-start, N×audio-chunk, audio-stop
      expect(transport.sent[0]!.type).toBe("audio-start");
      expect(transport.sent.at(-1)!.type).toBe("audio-stop");
      expect(transport.sent.some((e) => e.type === "audio-chunk")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transcribe returns null on empty transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wyoming-stt-"));
    const wav = join(dir, "a.wav");
    writeWav(wav, 8000);
    try {
      const transport = mockTransport([{ type: "transcript", data: { text: "   " } }]);
      const p = new WyomingSTTProvider({ host: "127.0.0.1", port: 10300 }, () => transport);
      expect(await p.transcribe(wav)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transcribe returns null when the transport throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wyoming-stt-"));
    const wav = join(dir, "a.wav");
    writeWav(wav, 8000);
    try {
      const transport: WyomingTransport = {
        async send() {},
        async receive() {
          throw new Error("connection refused");
        },
        async receiveOfType() {
          throw new Error("connection refused");
        },
        async describe() {
          return { type: "info", data: {} };
        },
        close() {},
      };
      const p = new WyomingSTTProvider({ host: "127.0.0.1", port: 10300 }, () => transport);
      expect(await p.transcribe(wav)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
