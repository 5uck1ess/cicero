/** Opt-in live daemon benchmark. Playback start is simulated at clip receipt. */
import { readFile } from "node:fs/promises";
import { decodeReplyAudioFrame, encodeTurnAudioFrame, inspectTurnAudio } from "../src/web-voice/protocol";
import { percentile } from "../src/latency";

function argument(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
}
const token = argument("--token", process.env.CICERO_WEB_VOICE_TOKEN);
const clip = argument("--wav");
const host = argument("--host", "127.0.0.1")!;
const port = Number(argument("--port", "8090"));
const count = Number(argument("--turns", "10"));
const timeoutMs = Number(argument("--timeout-ms", "60000"));
if (!token || !clip || !/^[A-Za-z0-9.\-:[\]]+$/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535
  || !Number.isSafeInteger(count) || count < 1 || count > 1000
  || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
  console.error("Usage: bun run bench/conversation-bench.ts --wav clip.wav [--host 127.0.0.1] [--port 8090] [--turns 10] [--timeout-ms 60000] [--token TOKEN]; token may come from CICERO_WEB_VOICE_TOKEN");
  process.exit(2);
}
const bytes = await readFile(clip);
if (!inspectTurnAudio(bytes)) throw new Error("--wav must be a bounded PCM WAV utterance");
const wav = new Uint8Array(bytes).buffer;
const url = `ws://${host}:${port}/ws?protocol=2&record=0&token=${encodeURIComponent(token)}`;
const firstClipMs: number[] = [];
const ws = new WebSocket(url);
async function withinDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
ws.binaryType = "arraybuffer";
let sessionId = "", currentTurn = "", resolveTurn: (() => void) | undefined, rejectTurn: ((error: Error) => void) | undefined;
let startAt = 0, firstClip: number | undefined;
const sendMetric = (event: string, sinceSpeechEndMs: number, sequence?: number): void => {
  ws.send(JSON.stringify({ type: "client_metric", sessionId, turnId: currentTurn, event, sinceSpeechEndMs: Math.max(0, Math.min(300000, Math.round(sinceSpeechEndMs))),
    ...(sequence !== undefined ? { sequence } : {}) }));
};
const connected = new Promise<void>((resolve, reject) => {
  ws.onopen = () => {};
  ws.onerror = () => reject(new Error("WebSocket connection failed"));
  ws.onclose = () => rejectTurn?.(new Error("WebSocket closed during turn"));
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const frame = decodeReplyAudioFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame || frame.sessionId !== sessionId || frame.turnId !== currentTurn) return;
      const elapsed = performance.now() - startAt;
      if (firstClip === undefined) firstClip = elapsed;
      sendMetric("audio_started", elapsed, frame.sequence);
      ws.send(JSON.stringify({ type: "audio_ack", sessionId, turnId: currentTurn, sequence: frame.sequence, status: "played" }));
      return;
    }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    if (msg.type === "hello" && msg.protocol === 2 && typeof msg.sessionId === "string") { sessionId = msg.sessionId; resolve(); return; }
    if (msg.sessionId !== sessionId || msg.turnId !== currentTurn) return;
    if (msg.type === "done") resolveTurn?.();
    if (msg.type === "error") rejectTurn?.(new Error("daemon reported a turn error"));
  };
});
try {
  await withinDeadline(connected, "connection");
  for (let i = 0; i < count; i++) {
    currentTurn = crypto.randomUUID(); firstClip = undefined;
    const done = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    startAt = performance.now();
    ws.send(encodeTurnAudioFrame(sessionId, currentTurn, wav));
    sendMetric("speech_end", 0);
    await withinDeadline(done, "turn");
    if (firstClip !== undefined) firstClipMs.push(Math.round(firstClip));
  }
  process.stdout.write("surface  metric  n  p50 ms  p95 ms\n" + (firstClipMs.length
    ? `web_voice  speech_end→first clip receipt  ${firstClipMs.length}  ${percentile(firstClipMs, 0.5)}  ${percentile(firstClipMs, 0.95)}\n` : ""));
} finally { ws.close(); }
