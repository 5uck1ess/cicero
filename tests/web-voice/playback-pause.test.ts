import { expect, test } from 'bun:test';
import { PAGE } from '../../src/web-voice/page';

/** Execute the shipped playback functions, including the initial play promise. */
function player() {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const pause = script.slice(script.indexOf('const FalseInterruption ='), script.indexOf('function triggerBargeIn()'));
  const playback = script.slice(script.indexOf('function playNext()'), script.indexOf('// --- proactive notifications'));
  let timer: (() => void) | undefined;
  const clock = {
    setTimer: (fn: () => void) => { timer = fn; return 1; },
    clearTimer: () => { timer = undefined; },
  };
  const instance = new Function('clock', `
    let captureTurnId = 'noise', activeTurnId = 'reply', wsSessionId = 'session';
    const ws = { readyState: 1, send() {} };
    let streamCaptureEnabled = true, currentAudioSource = null, currentGainNode = null;
    let currentAudio = null, currentAudioItem = null, currentEnv = null;
    let playing = false, turnDone = false, queuedAudioMs = 20, state = 'thinking';
    const audioCtx = null, voiceGain = 1, playedMetrics = new Set();
    const acks = [], revoked = [], instances = [];
    const URL = { createObjectURL: () => 'blob:' + instances.length, revokeObjectURL: url => revoked.push(url) };
    class Audio {
      constructor(src) { this.src = src; this.currentTime = 1.25; this.calls = []; instances.push(this); }
      pause() { this.paused = true; }
      play() { this.paused = false; return new Promise((resolve, reject) => this.calls.push({ resolve, reject })); }
    }
    const clip = id => ({ buf: new ArrayBuffer(2), durationMs: 20, env: {}, sequence: id, sessionId: 'session', turnId: activeTurnId });
    let audioQueue = [clip(1)];
    function setState(s) { state = s; } function setStatus() {} function clientMetric() {}
    function sendAudioAck(item, status) { acks.push([item.sequence, status]); }
    function abortActiveTurn() { activeTurnId = null; }
    function resumeListening() { state = 'listening'; captureTurnId = null; }
    ${pause}
    ${playback}
    falseInterruption = new FalseInterruption(1500, clock);
    return {
      start: playNext, pause: pauseForBarge, finish: finishBarge, stop: stopPlayback,
      instances, acks, revoked,
      submitted() { captureTurnId = null; },
      queueNext() { audioQueue.push(clip(2)); queuedAudioMs += 20; },
      snapshot() { return { currentAudio, currentAudioItem, playing, queued: audioQueue.length, state, activeTurnId }; }
    };
  `)(clock) as {
    start(): void; pause(): void; finish(message: unknown): void; stop(): void;
    submitted(): void; queueNext(): void;
    instances: Array<{ src: string; currentTime: number; onended(): void; onerror(): void; calls: Array<{ resolve(): void; reject(error: Error): void }> }>;
    acks: Array<[number, string]>; revoked: string[];
    snapshot(): { currentAudio: unknown; currentAudioItem: unknown; playing: boolean; queued: number; state: string; activeTurnId: string | null };
  };
  return Object.assign(instance, { expire: () => { const fn = timer; timer = undefined; fn?.(); } });
}

for (const resume of ['empty transcript', 'timeout'] as const) {
  test(`initial play rejection from tentative pause retains the clip for ${resume}`, async () => {
    const page = player(); page.start(); page.queueNext();
    const first = page.instances[0]!;
    page.pause(); page.submitted();
    first.calls[0]!.reject(new DOMException('play interrupted by pause', 'AbortError'));
    await Promise.resolve();
    expect(page.snapshot().currentAudio).toBe(first);
    expect(page.snapshot().queued).toBe(1);
    expect(page.acks).toEqual([]);
    expect(page.revoked).toEqual([]);
    if (resume === 'timeout') page.expire();
    else page.finish({ captureId: 'noise', accepted: false });
    expect(page.instances).toHaveLength(1);
    expect(first.calls).toHaveLength(2);
    expect(first.currentTime).toBe(1.25);
    first.calls[1]!.resolve(); await Promise.resolve();
    first.onended();
    expect(page.acks).toEqual([[1, 'played']]);
    expect(page.instances).toHaveLength(2);
    page.stop();
  });
}

test('late initial play rejection cannot discard the already resumed clip', async () => {
  const page = player(); page.start(); const first = page.instances[0]!;
  page.pause(); page.submitted(); page.expire();
  first.calls[0]!.reject(new DOMException('delayed pause rejection', 'AbortError'));
  await Promise.resolve();
  expect(page.snapshot().currentAudio).toBe(first);
  expect(page.acks).toEqual([]);
  expect(page.revoked).toEqual([]);
  page.stop();
});

test('an actual initial playback failure still discards the failed clip', async () => {
  const page = player(); page.start(); page.queueNext(); const first = page.instances[0]!;
  first.calls[0]!.reject(new Error('playback unavailable'));
  await Promise.resolve();
  expect(page.acks).toEqual([[1, 'interrupted']]);
  expect(page.revoked).toEqual([first.src]);
  expect(page.snapshot().currentAudio).toBe(page.instances[1]);
  page.stop();
});

test('callbacks from a discarded clip cannot acknowledge it twice or touch its replacement', async () => {
  const page = player(); page.start(); const first = page.instances[0]!;
  page.pause(); page.submitted();
  page.finish({ captureId: 'noise', accepted: true, turnId: 'replacement' });
  page.queueNext(); page.start(); const replacement = page.instances[1]!;
  const previousAcks = page.acks.slice(), previousRevoked = page.revoked.slice();
  first.calls[0]!.reject(new DOMException('old clip stopped', 'AbortError'));
  first.onended(); first.onerror(); await Promise.resolve();
  expect(page.snapshot().currentAudio).toBe(replacement);
  expect(page.acks).toEqual(previousAcks);
  expect(page.revoked).toEqual(previousRevoked);
  page.stop();
});
