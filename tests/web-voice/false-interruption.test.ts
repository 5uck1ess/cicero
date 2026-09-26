import { test, expect } from 'bun:test';
import { FalseInterruption } from '../../src/web-voice/false-interruption';

function setup() {
  let timer: (() => void) | undefined;
  const events: string[] = [];
  const gate = new FalseInterruption(1500, {
    setTimer: (fn: () => void) => { timer = fn; return 1; },
    clearTimer: () => { timer = undefined; },
  });
  return { gate, events, expire: () => { const fn = timer; timer = undefined; fn?.(); }, start: () => gate.start(() => events.push('resume')) };
}
test('noise resumes once at the injected deadline', () => {
  const s = setup(); s.start(); s.expire(); s.expire();
  expect(s.events).toEqual(['resume']);
});
test('speech discards before deadline and after resume', () => {
  const s = setup(); const first = s.start();
  expect(s.gate.finish(first)).toBe(true); s.expire();
  expect(s.events).toEqual([]);
  const second = s.start(); s.expire();
  expect(s.gate.finish(second)).toBe(true);
});
test('supersession cancels timer and rejects stale speech', () => {
  const s = setup(); const first = s.start(); const second = s.start();
  expect(s.gate.finish(first)).toBe(false);
  s.gate.cancel(); s.expire();
  expect(s.gate.finish(second)).toBe(false);
  expect(s.events).toEqual([]);
});

import { PAGE } from '../../src/web-voice/page';

function browser() {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)![1]!;
  const messages = script.slice(script.indexOf('function onWsMessage(e)'), script.indexOf('// Auto-reconnect'));
  const disconnect = script.slice(script.indexOf('  ws.onclose = () => {') + '  ws.onclose = () => {'.length, script.indexOf('\n  };\n}', script.indexOf('  ws.onclose = () => {')));
  const pause = script.slice(script.indexOf('const FalseInterruption ='), script.indexOf('function triggerBargeIn()'));
  const stop = script.slice(script.indexOf('function stopPlayback()'), script.indexOf('// --- proactive notifications'));
  let timer: (() => void) | undefined;
  const clock = {
    setTimer: (fn: () => void) => { timer = fn; return 1; },
    clearTimer: () => { timer = undefined; },
  };
  const page = new Function('clock', `
    let captureTurnId = 'capture', activeTurnId = 'reply', wsSessionId = 'session';
    const sent = []; const ws = { readyState: 1, send: m => sent.push(JSON.parse(m)) };
    const sock = ws; let streamOn = true, convOn = true;
    function setDot() {} function clearConfirmations() {} function scheduleReconnect() {}
    let streamCaptureEnabled = true, currentAudioSource = null, currentGainNode = null;
    let currentAudioItem = {}, currentEnv = null, playing = true, turnDone = false;
    let audioQueue = [{}], queuedAudioMs = 20, state = 'speaking';
    const audio = { currentTime: 1.25, plays: 0, paused: false, src: 'blob:test',
      pause() { this.paused = true; }, play() { this.paused = false; this.plays++; return Promise.resolve(); } };
    let currentAudio = audio;
    function setState(s) { state = s; } function setStatus() {}
    function clientMetric() {} function playNext() {} function sendAudioAck() {} function abortActiveTurn() {}
    function resumeListening() { state = 'listening'; captureTurnId = null; }
    ${pause}
    ${stop}
    ${messages}
    falseInterruption = new FalseInterruption(1500, clock);
    return { audio, sent, pause: pauseForBarge, finish: finishBarge, stop: stopPlayback,
      recording() { state = "speech"; },
      disconnect() { ${disconnect} },
      originalError() { onWsMessage({ data: JSON.stringify({ type: "error", turnId: "reply", sessionId: "session", message: "provider failed" }) }); },
      originalDoneDuringCapture() { playing = false; currentAudio = null; state = 'speech'; onWsMessage({ data: JSON.stringify({ type: 'done', turnId: 'reply', sessionId: 'session' }) }); },
      rejectPlaybackLater() { let reject; audio.play = () => new Promise((_resolve, no) => { reject = no; }); return () => reject(new Error('old media stopped')); },
      submitted() { captureTurnId = null; },
      snapshot() { return { activeTurnId, paused: playbackPaused, queued: audioQueue.length, state }; } };
  `)(clock) as {
    audio: { currentTime: number; paused: boolean; plays: number };
    recording(): void; disconnect(): void; originalError(): void; originalDoneDuringCapture(): void; rejectPlaybackLater(): () => void;
    sent: unknown[]; pause(): boolean; submitted(): void; finish(msg: unknown): void; stop(): void;
    snapshot(): { activeTurnId: string | null; paused: boolean; queued: number; state: string };
  };
  return Object.assign(page, { expire: () => { const fn = timer; timer = undefined; fn?.(); } });
}

test('browser pauses existing media and preserves its buffered clips on noise', () => {
  const page = browser();
  expect(page.pause()).toBe(true);
  expect(page.audio.paused).toBe(true);
  expect(page.snapshot().queued).toBe(1);
  page.submitted(); page.finish({ captureId: 'capture', accepted: false });
  expect(page.audio.currentTime).toBe(1.25);
  expect(page.audio.plays).toBe(1);
  expect(page.snapshot()).toMatchObject({ activeTurnId: 'reply', queued: 1, paused: false });
});
test('browser real speech discards audio; stop rejects a stale result', () => {
  const page = browser(); page.pause(); page.submitted();
  page.finish({ captureId: 'capture', accepted: true, turnId: 'new' });
  expect(page.snapshot()).toMatchObject({ activeTurnId: 'new', queued: 0, state: 'thinking' });
  page.finish({ captureId: 'capture', accepted: false });
  expect(page.audio.plays).toBe(0);
  const stopped = browser(); stopped.pause(); stopped.stop();
  stopped.finish({ captureId: 'capture', accepted: true, turnId: 'stale' });
  expect(stopped.snapshot().activeTurnId).toBeNull();
});


test('browser late speech after timeout replaces the resumed reply', () => {
  const page = browser(); page.pause(); page.submitted(); page.expire();
  expect(page.audio.plays).toBe(1);
  expect(page.audio.currentTime).toBe(1.25);
  page.finish({ captureId: 'capture', accepted: true, turnId: 'late' });
  expect(page.snapshot()).toMatchObject({ activeTurnId: 'late', queued: 0, state: 'thinking' });
  page.expire();
  expect(page.audio.plays).toBe(1);
});


test('disconnect while recording a paused barge releases playback and its timer', () => {
  const page = browser(); page.pause(); page.recording(); page.disconnect(); page.expire();
  expect(page.snapshot()).toMatchObject({ paused: false, queued: 0, activeTurnId: null });
});
test('original done cannot clear an interruption still being captured', () => {
  const page = browser(); page.pause(); page.expire(); page.originalDoneDuringCapture();
  expect(page.snapshot().state).toBe('speech');
});
test('old resumed play rejection cannot abort an accepted replacement', async () => {
  const page = browser(); const reject = page.rejectPlaybackLater();
  page.pause(); page.submitted(); page.expire();
  page.finish({ captureId: 'capture', accepted: true, turnId: 'replacement' });
  reject(); await Promise.resolve();
  expect(page.snapshot()).toMatchObject({ activeTurnId: 'replacement', state: 'thinking' });
});


test('an original reply error preserves paused audio for noise recovery', () => {
  const page = browser(); page.pause(); page.originalError(); page.submitted();
  page.finish({ captureId: 'capture', accepted: false });
  expect(page.snapshot()).toMatchObject({ activeTurnId: 'reply', paused: false, queued: 1 });
  expect(page.audio.plays).toBe(1);
});
