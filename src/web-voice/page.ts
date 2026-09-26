import { FalseInterruption } from "./false-interruption";
/**
 * The browser audio client page (Phase 3): hands-free, full-duplex voice over WebSocket.
 *
 * - Push-to-talk by default: hold SPACE or press-and-hold the orb to capture, release
 *   to send (the Mac hotkey equivalent). A hands-free energy-VAD mode (adaptive noise
 *   floor + pre-roll + silence hangover) is available via the toggle for those who want it.
 * - Sends each finished utterance (16 kHz mono WAV, encoded in-browser) over /ws.
 * - Plays the reply as it streams back, sentence-by-sentence (low latency).
 * - Full-duplex barge-in: the VAD keeps watching while Cicero speaks; talking over it
 *   (a stricter, longer onset to dodge residual echo) stops playback, sends {type:abort},
 *   and captures the interruption as the next turn. The browser's own echo cancellation
 *   keeps Cicero's TTS out of the mic so this works without host-side AEC.
 *
 * - The orb is a canvas-drawn reactor (rotating arcs, tick ring, glowing core) that
 *   moves with the audio: mic level while capturing, the reply WAV's precomputed
 *   loudness envelope while speaking. Envelopes are decoded from the PCM directly so
 *   playback stays on the standard <audio> path (WebAudio rerouting can hide playback
 *   from the browser AEC, which would break barge-in).
 *
 * No inner template literals so the outer string stays clean. The #debug line shows
 * live VAD numbers (rms/floor/threshold/state) so thresholds can be tuned by eye.
 */
import { MAX_QUEUED_AUDIO_MS, canQueueAudio } from "./playback-policy";
import { speechEndOrigin } from "./speech-end";

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cicero — Voice</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='27' fill='none' stroke='%2322d3ee' stroke-width='3' opacity='0.7'/%3E%3Ccircle cx='32' cy='32' r='17' fill='none' stroke='%237dd3fc' stroke-width='2' stroke-dasharray='18 9'/%3E%3Ccircle cx='32' cy='32' r='9' fill='%237dd3fc'/%3E%3C/svg%3E" />
<meta name="theme-color" content="#090d12" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, system-ui, sans-serif; background:radial-gradient(circle at 50% 32%, #0d1b26 0%, #090d12 62%, #06090d 100%); color:#c9d1d9; margin:0; height:100vh; height:100dvh; overflow:hidden; box-sizing:border-box; padding:3vh 0 10px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; }
  header { position:fixed; top:calc(env(safe-area-inset-top, 0px) + 12px); left:50%; transform:translateX(-50%); z-index:1; display:flex; align-items:center; gap:10px; }
  header svg { filter:drop-shadow(0 0 6px #22d3ee66); }
  h1 { font-weight:600; font-size:16px; color:#7dd3fc; margin:0; letter-spacing:5px; text-shadow:0 0 14px #22d3ee44; }
  h1 small { display:block; font-size:9px; font-weight:500; letter-spacing:2px; color:#4b5f70; text-shadow:none; margin-top:2px; }
  #orb { width:clamp(230px, 80vmin, calc(100dvh - 260px)); aspect-ratio:1/1; position:relative; z-index:3; transition:opacity 1.2s ease; cursor:pointer; user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent; touch-action:none; }
  #orb canvas { position:absolute; inset:0; width:100%; height:100%; }
  #orbLabel { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:clamp(10px, 1.5vmin, 20px); font-weight:600; letter-spacing:0.32em; transition:opacity 1.2s ease; text-transform:uppercase; color:#7dd3fc; pointer-events:none; }
  .controls { display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-content:center; }
  .controls button { display:inline-flex; align-items:center; gap:8px; font-family:inherit; }
  .controls svg { flex:none; }
  #toggle { padding:10px 20px; border-radius:10px; border:1px solid #2ea043; background:#161b22; color:#c9d1d9; font-size:15px; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s; }
  #toggle:hover { background:#1c2430; }
  #toggle.on { background:#13351c; border-color:#3fb950; }
  .modes { display:flex; border:1px solid #30363d; border-radius:10px; overflow:hidden; }
  .modes button { background:#0d1117; color:#8b949e; border:0; padding:9px 14px; font-size:13px; font-weight:600; cursor:pointer; transition:background .15s,color .15s; }
  .modes button + button { border-left:1px solid #30363d; }
  .modes button:hover { color:#c9d1d9; }
  .modes button.sel { background:#0e2a33; color:#7dd3fc; }
  #status { font-size:14px; color:#8b949e; min-height:18px; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:#f85149; flex:none; transition:background .2s; }
  .dot.on { background:#3fb950; box-shadow:0 0 8px #3fb95099; }
  #debug { font-family:ui-monospace,monospace; font-size:11px; color:#6e7681; min-height:14px; }
  @media (max-height:700px) { #orb { width:170px; } }
  .hint { font-size:12px; color:#6e7681; max-width:92vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  body.pre #orb { opacity:0.05; }
  body.pre #orbLabel { opacity:0; }
  #shroud { position:fixed; inset:0; background:#05070a; opacity:0; pointer-events:none; transition:opacity 1.2s ease; z-index:2; }
  body.pre.cinema #shroud { opacity:1; }
  #notice { --notice-max-height:40dvh; display:none; position:fixed; top:calc(env(safe-area-inset-top, 0px) + 60px); left:50%; transform:translateX(-50%); z-index:4; width:min(92vw,640px); box-sizing:border-box; max-height:var(--notice-max-height); align-items:flex-start; gap:10px; background:#0e2230; border:1px solid #1f4a5e; border-radius:10px; padding:10px 12px; font-size:13px; color:#a5c8dc; line-height:1.45; }
  #notice.show { display:flex; }
  #noticeText { min-width:0; max-height:calc(var(--notice-max-height) - 22px); overflow-y:auto; overflow-wrap:anywhere; white-space:pre-wrap; }
  #notice a { color:#7dd3fc; font-weight:600; word-break:break-all; }
  #notice button { flex:none; background:none; border:0; color:#4b5f70; font-size:16px; cursor:pointer; padding:0 2px; line-height:1; }
  #confirmations { display:flex; flex-direction:column; gap:8px; width:min(86vw,560px); max-height:30dvh; min-height:0; flex-shrink:1; overflow:auto; }
  body:has(#confirmations:not(:empty)) #orb { width:clamp(170px, 45vmin, calc(70dvh - 260px)); }
  body:has(#confirmations:not(:empty)) #notice { --notice-max-height:25dvh; }
  .confirm-card { display:flex; flex-direction:column; gap:10px; background:#0e2230; border:1px solid #1f4a5e; border-radius:10px; padding:12px; font-size:13px; color:#a5c8dc; line-height:1.45; }
  .confirm-summary { white-space:pre-wrap; overflow-wrap:anywhere; }
  .confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
  .confirm-actions button { border-radius:8px; padding:7px 12px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  .confirm-actions button:disabled { cursor:default; opacity:.5; }
  .confirm-deny { border:1px solid #6e3030; background:#2b1518; color:#ffb4ae; }
  .confirm-approve { border:1px solid #2ea043; background:#13351c; color:#a7e3b1; }
</style>
</head>
<body class="pre">
  <div id="shroud"></div>
  <header>
    <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="none" stroke="#22d3ee" stroke-width="3" opacity="0.7"/>
      <circle cx="32" cy="32" r="17" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-dasharray="18 9"/>
      <circle cx="32" cy="32" r="9" fill="#7dd3fc"/>
    </svg>
    <h1>CICERO<small>LOCAL VOICE AGENT</small></h1>
  </header>
  <div id="orb"><canvas id="orbCanvas"></canvas><span id="orbLabel">idle</span></div>
  <div class="controls">
    <button id="toggle">
      <svg id="toggleIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>
      </svg>
      <span id="toggleLabel">Start conversation</span>
    </button>
    <div class="modes" role="group" aria-label="mic mode">
      <button id="modePtt" class="sel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
        </svg>
        Push-to-talk
      </button>
      <button id="modeVad">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="4" y1="9" x2="4" y2="15"/><line x1="8" y1="6" x2="8" y2="18"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="16" y1="6" x2="16" y2="18"/><line x1="20" y1="9" x2="20" y2="15"/>
        </svg>
        Hands-free
      </button>
    </div>
    <div class="modes"><button id="autoStart">Auto-start off</button></div>
  </div>
  <div id="status"><span class="dot" id="dot"></span><span id="statusText">tap start to enable the mic…</span></div>
  <div id="debug"></div>
  <div class="hint" id="hint">Push-to-talk: hold <b>SPACE</b> (or press &amp; hold the orb) to talk — release to send.</div>
  <div id="confirmations" aria-live="polite"></div>
  <div id="notice"><span id="noticeText"></span><button id="noticeClose" aria-label="dismiss">&times;</button></div>
<script>
// Token: the URL param wins and is remembered, so an installed PWA (whose
// start_url carries no query) can reconnect from localStorage after the first
// tokened visit.
let TOKEN = new URLSearchParams(location.search).get("token") || "";
try {
  if (TOKEN) localStorage.setItem("ciceroToken", TOKEN);
  else TOKEN = localStorage.getItem("ciceroToken") || "";
} catch (e) { /* storage disabled */ }
if (new URLSearchParams(location.search).has("token")) {
  const clean = new URL(location.href);
  clean.searchParams.delete("token");
  history.replaceState(null, "", clean.pathname + clean.search + clean.hash);
}
const orb = document.getElementById("orb");
const orbCanvas = document.getElementById("orbCanvas");
const orbLabel = document.getElementById("orbLabel");
const toggle = document.getElementById("toggle");
const toggleLabel = document.getElementById("toggleLabel");
const statusEl = document.getElementById("statusText");
const dotEl = document.getElementById("dot");
const debugEl = document.getElementById("debug");


// --- VAD tuning (RMS is 0..1; ~0.01 = 1% of full scale) ---
const OPEN_FACTOR = 3.0, CLOSE_FACTOR = 1.6;
const ABS_OPEN = 0.012, ABS_CLOSE = 0.008;
const MIN_ONSET_MS = 150, HANGOVER_MS = 700, PREROLL_MS = 300;
const MIN_UTTER_MS = 250, MAX_UTTER_MS = 15000;
// Semantic turn probes (only when the server says probe_on): at PROBE_MS of
// pause the audio tail goes to the end-of-turn model — "complete" ends the turn
// ~450ms sooner than the hangover; "incomplete" stretches this pause's hangover
// to HANGOVER_EXT_MS so a mid-thought breath doesn't cut the utterance.
const PROBE_MS = 250, HANGOVER_EXT_MS = 1800, PROBE_TAIL_S = 8;
// Barge-in (full-duplex): while Cicero is speaking, require a higher, longer onset to
// trigger — the browser's echo cancellation removes most of Cicero's own voice, but a
// stricter gate avoids self-interruption on residual echo.
const BARGE_GAIN = 1.5, BARGE_MIN_ONSET_MS = 250;

// --- Speech gate (Silero VAD v5 on onnxruntime-web wasm, served same-origin
// from /vad/). Sits BEHIND the energy gate: energy opens cheap, the model
// must agree the sound is human speech before a hands-free utterance opens
// or a barge-in fires — keyboard clacks and thuds carry energy but no speech
// probability. Assets missing, load failure, or PTT capture (a held key is
// deliberate) → energy-only, exactly the old behavior.
const VAD_POS = 0.5, VAD_BARGE = 0.6, VAD_CHUNK = 512, VAD_RATE = 16000;
const VAD_MAX_LAG_CHUNKS = 8; // drop backlog rather than let stale audio decide
let vadSession = null, vadState = null, vadPend = new Float32Array(0);
let vadProb = 0, vadBusy = false, vadStatus = "loading";
(function loadSpeechGate() {
  const el = document.createElement("script");
  el.src = "/vad/ort.wasm.min.js";
  el.onload = () => { void initSpeechGate(); };
  el.onerror = () => { vadStatus = "off"; };
  document.head.appendChild(el);
})();
async function initSpeechGate() {
  try {
    ort.env.wasm.numThreads = 1; // tiny model; skips the COOP/COEP requirement
    ort.env.wasm.wasmPaths = "/vad/";
    vadSession = await ort.InferenceSession.create("/vad/silero_vad_v5.onnx", { executionProviders: ["wasm"] });
    vadState = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    vadStatus = "on";
  } catch (e) { vadSession = null; vadStatus = "off"; }
  updateDebug();
}
function speechGateFeed(buf) {
  if (!vadSession) return;
  const ds = downsample(buf, audioCtx.sampleRate, VAD_RATE);
  if (vadPend.length > VAD_CHUNK * VAD_MAX_LAG_CHUNKS) vadPend = new Float32Array(0);
  const merged = new Float32Array(vadPend.length + ds.length);
  merged.set(vadPend); merged.set(ds, vadPend.length);
  vadPend = merged;
  if (!vadBusy) void speechGateRun();
}
async function speechGateRun() {
  vadBusy = true;
  try {
    while (vadSession && vadPend.length >= VAD_CHUNK) {
      const chunk = vadPend.slice(0, VAD_CHUNK);
      vadPend = vadPend.slice(VAD_CHUNK);
      const out = await vadSession.run({
        input: new ort.Tensor("float32", chunk, [1, VAD_CHUNK]),
        state: vadState,
        sr: new ort.Tensor("int64", new BigInt64Array([16000n]), [1]),
      });
      vadState = out.stateN;
      vadProb = out.output.data[0];
    }
  } catch (e) {
    // one bad run poisons nothing: fall back to energy-only for the session
    vadSession = null; vadStatus = "off"; vadProb = 0;
  }
  vadBusy = false;
}
function speechConfirmed(thr) { return !vadSession || vadProb >= thr; }

let ws = null, wsSessionId = "", activeTurnId = null, captureTurnId = null;
let streamOn = false, streamSeq = 0, streamCaptureFailed = false, streamCaptureCommitted = false;
let streamCaptureEnabled = false;
let pendingBargeAbort = false;
let streamInputCount = 0, streamOutputCount = 0, streamSum = 0, streamCount = 0;
let micStream = null, audioCtx = null, source = null, node = null;
let convOn = false, ready = false;
let ptt = true, holding = false; // push-to-talk mode (default) + whether the key/orb is held
// Remember the mic mode across visits — a phone user who picked hands-free
// shouldn't have to re-tap it every time the installed app opens.
try { if (localStorage.getItem("ciceroMode") === "vad") ptt = false; } catch (e) { /* storage disabled */ }
let pttBargeTimer = null;        // pending hold-to-interrupt (armed while pressing during a reply)
let state = "idle"; // idle | listening | speech | thinking | held | speaking
let noiseFloor = 0.005, rms = 0;
let preRoll = [], speechFrames = [], onsetFrames = 0, silenceFrames = 0, speechLen = 0, bargeOnset = 0;
let lastVoicedAt = null;
const speechEndOrigin = ${speechEndOrigin.toString()};
let probeOn = false, probeSent = false, hangMs = HANGOVER_MS; // semantic turn probe state (per-pause)
let frameMs = 21; // recomputed once we know the sample rate
let audioQueue = [], playing = false, turnDone = false, currentAudio = null, currentEnv = null;
let queuedAudioMs = 0, currentAudioItem = null, capturePath = "pending";
const speechEndAt = new Map(), playedMetrics = new Set();
function clientMetric(turnId, event, at, sequence) {
  if (!turnId || !wsSessionId || !ws || ws.readyState !== 1) return;
  const origin = speechEndAt.get(turnId);
  if (event === "audio_started" && origin === undefined) return;
  const sinceSpeechEndMs = event === "speech_end" || origin === undefined ? 0 : Math.max(0, Math.min(300000, Math.round((at || performance.now()) - origin)));
  try { ws.send(JSON.stringify({ type: "client_metric", sessionId: wsSessionId, turnId: turnId, event: event, sinceSpeechEndMs: sinceSpeechEndMs,
    ...(event === "audio_started" ? { sequence: sequence } : {}) })); } catch (e) { /* closed */ }
}
const MAX_QUEUED_AUDIO_MS = ${MAX_QUEUED_AUDIO_MS};
const canQueueAudio = ${canQueueAudio.toString()};
let voiceGain = 1.0, currentAudioSource = null, currentGainNode = null;
let micLevel = 0; // smoothed-ish 0..1 for the orb (raw per-frame; the draw loop lerps)

function setStatus(s) { statusEl.textContent = s; }
function setDot(on) { dotEl.className = on ? "dot on" : "dot"; }
let ignited = false;
function ignite() { if (ignited) return; ignited = true; document.body.classList.remove("pre"); }
function setState(s) { if (s === "speech") ignite(); state = s; orb.className = (s === "idle" ? "" : s); orbLabel.textContent = s; updateDebug(); }
function updateDebug() {
  const thr = Math.max(ABS_OPEN, noiseFloor * OPEN_FACTOR);
  debugEl.textContent = "state:" + state + " rms:" + rms.toFixed(4) + " floor:" + noiseFloor.toFixed(4) +
    " open@:" + thr.toFixed(4) + " q:" + audioQueue.length + " capture:" + capturePath + " vad:" + (vadStatus === "on" ? vadProb.toFixed(2) : vadStatus) + " secure:" + window.isSecureContext;
}
function frameCount(ms) { return Math.max(1, Math.round(ms / frameMs)); }
function rmsOf(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); }

// Protocol v2 binds every binary and JSON turn message to the WebSocket
// session + turn that produced it. That lets the client reject a late reply
// after barge-in instead of playing it as part of the replacement turn.
function newTurnId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "turn-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function beginCaptureIdentity() { captureTurnId = newTurnId(); lastVoicedAt = null; streamSeq = 0; streamCaptureFailed = false; streamCaptureCommitted = false; pendingBargeAbort = false; streamCaptureEnabled = streamOn;
  streamInputCount = 0; streamOutputCount = 0; streamSum = 0; streamCount = 0; }
function abortLiveCapture() {
  if (!streamCaptureEnabled || !streamSeq || !captureTurnId || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: "capture_abort", sessionId: wsSessionId, turnId: captureTurnId })); } catch (e) { /* closed */ }
}
function applyStreamCapability(available) {
  if (!available) {
    abortLiveCapture();
    streamOn = false; streamCaptureEnabled = false; streamCaptureFailed = true;
  } else streamOn = true;
}
function sendLiveFrame(samples) {
  if (!streamCaptureEnabled || streamCaptureFailed || !captureTurnId || !wsSessionId || !ws || ws.readyState !== 1) return;
  if (ws.bufferedAmount > 512 * 1024 || samples.length > 32768 || streamSeq >= 0xffffffff) {
    streamCaptureFailed = true; abortLiveCapture(); return;
  }
  const rate = audioCtx.sampleRate, outputRate = Math.min(rate, 16000);
  const reduced = [];
  for (let i = 0; i < samples.length; i++) {
    streamSum += samples[i]; streamCount++; streamInputCount++;
    if (streamInputCount >= Math.floor((streamOutputCount + 1) * rate / outputRate)) {
      reduced.push(streamSum / streamCount); streamSum = 0; streamCount = 0; streamOutputCount++;
    }
  }
  if (!reduced.length) return;
  const pcm = new Uint8Array(12 + reduced.length * 2), view = new DataView(pcm.buffer);
  pcm.set([0x43, 0x56, 0x53, 0x32]); // CVS2 inside the CVP2 turn envelope
  view.setUint32(4, ++streamSeq, true); view.setUint32(8, outputRate, true);
  for (let i = 0; i < reduced.length; i++) {
    const s = Math.max(-1, Math.min(1, reduced[i]));
    view.setInt16(12 + 2 * i, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  try { ws.send(encodeTurnFrame(pcm, captureTurnId)); } catch (e) { streamCaptureFailed = true; abortLiveCapture(); }
}
function commitLiveCapture() {
  if (!audioCtx || (speechLen / audioCtx.sampleRate) * 1000 < MIN_UTTER_MS ||
      (ptt && state !== "speech")) return;
  if (pendingBargeAbort) {
    pendingBargeAbort = false;
    const turnId = activeTurnId || currentAudioItem?.turnId;
    if (turnId) clientMetric(turnId, "barge_in");
    abortActiveTurn(); stopPlayback();
  }
  if (!streamCaptureEnabled || streamCaptureCommitted) return;
  streamCaptureCommitted = true;
  for (const frame of speechFrames) sendLiveFrame(frame);
}
function encodeTurnFrame(payload, turnId) {
  const enc = new TextEncoder(), session = enc.encode(wsSessionId), turn = enc.encode(turnId);
  const src = payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : new Uint8Array(payload.buffer, payload.byteOffset || 0, payload.byteLength);
  const out = new Uint8Array(8 + session.length + turn.length + src.length);
  out[0] = 0x43; out[1] = 0x56; out[2] = 0x50; out[3] = 0x32; // "CVP2"
  const view = new DataView(out.buffer);
  view.setUint16(4, session.length, true); view.setUint16(6, turn.length, true);
  out.set(session, 8); out.set(turn, 8 + session.length); out.set(src, 8 + session.length + turn.length);
  return out.buffer;
}
function decodeTurnFrame(payload) {
  try {
    const u8 = new Uint8Array(payload);
    if (u8.length < 8 || u8[0] !== 0x43 || u8[1] !== 0x56 || u8[2] !== 0x50 || u8[3] !== 0x32) return null;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sl = view.getUint16(4, true), tl = view.getUint16(6, true), off = 8 + sl + tl;
    if (!sl || !tl || sl > 128 || tl > 128 || off > u8.length) return null;
    const dec = new TextDecoder("utf-8", { fatal: true });
    const sessionId = dec.decode(u8.subarray(8, 8 + sl));
    const turnId = dec.decode(u8.subarray(8 + sl, off));
    return { sessionId: sessionId, turnId: turnId, payload: u8.slice(off).buffer };
  } catch (e) { return null; }
}
function decodeReplyFrame(payload) {
  const u8 = new Uint8Array(payload);
  if (u8.length < 12 || u8[0] !== 0x43 || u8[1] !== 0x56 || u8[2] !== 0x41 || u8[3] !== 0x32) return null;
  const sequence = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
  if (!sequence) return null;
  const old = new Uint8Array(u8.length - 4);
  old.set([0x43, 0x56, 0x50, 0x32]); old.set(u8.subarray(4, 8), 4); old.set(u8.subarray(12), 8);
  const frame = decodeTurnFrame(old.buffer);
  return frame ? { ...frame, sequence: sequence } : null;
}
function abortActiveTurn() {
  const turnId = activeTurnId;
  activeTurnId = null;
  if (!turnId || !wsSessionId || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: "abort", sessionId: wsSessionId, turnId: turnId })); } catch (e) { /* closed */ }
}

function onFrame(buf) {
  rms = rmsOf(buf);
  if (!ptt && (state === "listening" || state === "held" || state === "speech" || state === "speaking")) speechGateFeed(buf);
  micLevel = Math.min(1, Math.pow(rms * 16, 0.8)); // perceptual-ish map: quiet speech still visibly moves the orb
  if (ptt) {                                   // push-to-talk: capture only while held, no VAD
    // Record whenever held — including the pre-barge window where the reply is
    // still playing (state "speaking"), so an interrupt doesn't clip its start.
    if (holding) {
      speechFrames.push(buf); speechLen += buf.length;
      if (streamCaptureCommitted) sendLiveFrame(buf);
      else commitLiveCapture();
      const durMs = (speechLen / audioCtx.sampleRate) * 1000;
      if (durMs >= MAX_UTTER_MS) endPtt();      // safety cap on a very long hold
    }
    updateDebug();
    return;
  }
  if (state === "speaking") { watchBargeIn(buf); updateDebug(); return; }
  if (state !== "listening" && state !== "held" && state !== "speech") { updateDebug(); return; }

  if (state === "listening" || state === "held") {
    preRoll.push(buf);
    while (preRoll.length > frameCount(PREROLL_MS)) preRoll.shift();
    const openThr = Math.max(ABS_OPEN, noiseFloor * OPEN_FACTOR);
    if (rms > openThr) {
      if (!speechConfirmed(VAD_POS)) { onsetFrames = 0; updateDebug(); return; } // loud but not speech
      onsetFrames++;
      if (onsetFrames >= frameCount(MIN_ONSET_MS)) {
        if (state === "held") abortActiveTurn();
        beginCaptureIdentity();
        lastVoicedAt = performance.now();
        speechFrames = preRoll.slice();           // include pre-roll so we don't clip the start
        speechLen = speechFrames.reduce(function (n, f) { return n + f.length; }, 0);
        silenceFrames = 0;
        setState("speech");
        commitLiveCapture();
      }
    } else {
      onsetFrames = 0;
      noiseFloor = noiseFloor * 0.95 + rms * 0.05; // adapt to ambient only while quiet
    }
  } else { // speech
    speechFrames.push(buf); speechLen += buf.length;
    if (streamCaptureCommitted) sendLiveFrame(buf);
    else commitLiveCapture();
    const closeThr = Math.max(ABS_CLOSE, noiseFloor * CLOSE_FACTOR);
    if (rms < closeThr) { silenceFrames++; } else { silenceFrames = 0; probeSent = false; hangMs = HANGOVER_MS; if (speechConfirmed(VAD_POS)) lastVoicedAt = performance.now(); }
    const durMs = (speechLen / audioCtx.sampleRate) * 1000;
    if (probeOn && !probeSent && durMs >= MIN_UTTER_MS && silenceFrames >= frameCount(PROBE_MS)) {
      probeSent = true; sendProbe();
    }
    if ((silenceFrames >= frameCount(hangMs) && durMs >= MIN_UTTER_MS) || durMs >= MAX_UTTER_MS) {
      finalizeUtterance();
    }
  }
  updateDebug();
}

function finalizeUtterance() {
  commitLiveCapture();
  const endedAt = performance.now();
  const speechEndedAt = speechEndOrigin(lastVoicedAt, endedAt, ptt);
  const total = speechLen;
  const merged = new Float32Array(total);
  let o = 0; for (const f of speechFrames) { merged.set(f, o); o += f.length; }
  preRoll = []; speechFrames = []; onsetFrames = 0; silenceFrames = 0; speechLen = 0;
  probeSent = false; hangMs = HANGOVER_MS;
  const pcm16k = downsample(merged, audioCtx.sampleRate, 16000);
  const wav = encodeWav(pcm16k, 16000);
  const turnId = captureTurnId || newTurnId();
  captureTurnId = null;
  if (!tentativeBarge || tentativeBarge.id !== turnId) activeTurnId = turnId;
  speechEndAt.set(turnId, speechEndedAt);
  while (speechEndAt.size > 4) speechEndAt.delete(speechEndAt.keys().next().value);
  setState("thinking"); setStatus("thinking…");
  if (ws && ws.readyState === 1 && wsSessionId) {
    try { ws.send(encodeTurnFrame(wav, turnId)); clientMetric(turnId, "speech_end", endedAt); return; } catch (e) { /* reconnect below */ }
  }
  activeTurnId = null; setStatus("disconnected — restarting…"); resumeListening();
}

// Ask the end-of-turn model whether the pause we're in is the end of the turn.
// Sends only the utterance TAIL (the model's window) as a compact int16 frame,
// plus the utterance's total duration so far — the server uses it to decide
// whether the tail covers the whole utterance (the speculative-turn gate).
// See probe.ts ("PRB2") for the wire format. Fire-and-forget: no verdict, no change.
function sendProbe() {
  if (tentativeBarge || !ws || ws.readyState !== 1 || !wsSessionId || !captureTurnId) return;
  const sr = audioCtx.sampleRate;
  const utterMs = Math.round((speechLen / sr) * 1000);
  let need = Math.min(speechLen, Math.round(sr * PROBE_TAIL_S));
  const tail = new Float32Array(need);
  let o = need;
  for (let i = speechFrames.length - 1; i >= 0 && o > 0; i--) {
    const f = speechFrames[i];
    const take = Math.min(f.length, o);
    tail.set(take === f.length ? f : f.subarray(f.length - take), o - take);
    o -= take;
  }
  const pcm16k = downsample(tail, sr, 16000);
  const frame = new ArrayBuffer(12 + pcm16k.length * 2);
  const view = new DataView(frame);
  view.setUint8(0, 0x50); view.setUint8(1, 0x52); view.setUint8(2, 0x42); view.setUint8(3, 0x32); // "PRB2"
  view.setUint32(4, 16000, true);
  view.setUint32(8, utterMs, true);
  for (let i = 0; i < pcm16k.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm16k[i]));
    view.setInt16(12 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  try { ws.send(encodeTurnFrame(frame, captureTurnId)); } catch (e) { /* socket closed — hangover governs */ }
}

// A verdict only matters if we're still in the same pause it was asked about:
// still in speech, probe outstanding, and no new speech since (silenceFrames
// resets on voice, which also clears probeSent).
function onVerdict(msg) {
  if (msg.sessionId !== wsSessionId || msg.turnId !== captureTurnId) return;
  if (state !== "speech" || !probeSent || silenceFrames === 0) return;
  if (msg.complete) { finalizeUtterance(); return; }
  // Model says mid-thought — patience scales with how sure it is. A confident
  // "incomplete" (probability near 0) earns the full stretch; a coin-flip only
  // a modest one, so an actually-finished sentence isn't held hostage for 1.8s.
  const p = typeof msg.probability === "number" ? Math.max(0, Math.min(1, msg.probability)) : 0;
  hangMs = Math.round(900 + (1 - p) * (HANGOVER_EXT_MS - 900));
}

// While Cicero is speaking, watch for the user talking over it. Stricter than the
// normal onset (BARGE_GAIN louder, BARGE_MIN_ONSET_MS longer) so residual echo of our
// own TTS — what the browser's AEC didn't catch — doesn't self-interrupt. We don't
// adapt the noise floor here (it would learn the echo).
function watchBargeIn(buf) {
  preRoll.push(buf);
  while (preRoll.length > frameCount(PREROLL_MS)) preRoll.shift();
  const bargeThr = Math.max(ABS_OPEN, noiseFloor * OPEN_FACTOR) * BARGE_GAIN;
  if (rms > bargeThr && speechConfirmed(VAD_BARGE)) {
    bargeOnset++;
    if (bargeOnset >= frameCount(BARGE_MIN_ONSET_MS)) triggerBargeIn();
  } else {
    bargeOnset = 0;
  }
}

const FalseInterruption = ${FalseInterruption.toString()};
let falseInterruption = null, tentativeBarge = null, playbackPaused = false, playbackGeneration = 0;
function pauseForBarge() {
  if (!falseInterruption || !activeTurnId || !ws || ws.readyState !== 1) return false;
  falseInterruption.cancel();
  playbackPaused = true;
  if (currentAudio) currentAudio.pause();
  const pending = { id: captureTurnId, turnId: activeTurnId, token: 0, generation: ++playbackGeneration };
  tentativeBarge = pending;
  pending.token = falseInterruption.start(() => resumeBarge(pending));
  // This capture is transcribed before it can acquire a replacement turn.
  streamCaptureEnabled = false;
  ws.send(JSON.stringify({ type: "barge_in", sessionId: wsSessionId, captureId: pending.id }));
  return true;
}
function resumeBarge(pending) {
  if (tentativeBarge !== pending || activeTurnId !== pending.turnId) return;
  playbackPaused = false;
  if (!captureTurnId) { setState("speaking"); setStatus("speaking…"); }
  if (currentAudio) {
    const audio = currentAudio;
    audio.play().catch(() => {
      if (playbackGeneration !== pending.generation || currentAudio !== audio || activeTurnId !== pending.turnId) return;
      abortActiveTurn(); stopPlayback(); resumeListening();
    });
  }
  else playNext();
}
function finishBarge(msg) {
  const pending = tentativeBarge;
  if (!pending || pending.id !== msg.captureId || !falseInterruption.finish(pending.token)) return;
  if (msg.discarded) { stopPlayback(); resumeListening(); return; }
  if (msg.accepted) {
    clientMetric(pending.turnId, "barge_in");
    stopPlayback();
    activeTurnId = msg.turnId;
    setState("thinking"); setStatus("thinking…");
  } else {
    resumeBarge(pending);
    tentativeBarge = null;
    if (!currentAudio && audioQueue.length === 0 && turnDone) { activeTurnId = null; resumeListening(); }
  }
}

function triggerBargeIn() {
  beginCaptureIdentity();
  lastVoicedAt = performance.now();
  speechFrames = preRoll.slice();                              // keep the pre-roll so we don't clip the interruption
  speechLen = speechFrames.reduce(function (n, f) { return n + f.length; }, 0);
  if (pauseForBarge()) { /* retained until transcript or timeout */ }
  else if (streamCaptureEnabled) pendingBargeAbort = true;
  else {
    const turnId = activeTurnId || currentAudioItem?.turnId;
    if (turnId) clientMetric(turnId, "barge_in");
    abortActiveTurn(); stopPlayback();
  }
  onsetFrames = 0; silenceFrames = 0; bargeOnset = 0;
  setState("speech"); setStatus("listening (you interrupted)…");
  commitLiveCapture();
}

function downsample(input, inRate, outRate) {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio);
    let sum = 0, n = 0;
    for (let j = start; j < end && j < input.length; j++) { sum += input[j]; n++; }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); wr(8, "WAVE");
  wr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, "data"); v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

// --- Push-to-talk: hold SPACE or press-and-hold the orb. The mic opens on press and
// the held audio is sent on release — bypasses the energy VAD entirely so speech is
// never clipped by a mis-tuned threshold (the Mac push-to-talk hotkey equivalent).
function beginPtt() {
  if (!ptt || !convOn || !ready || holding) return;
  holding = true;
  beginCaptureIdentity();
  speechFrames = []; speechLen = 0; silenceFrames = 0; onsetFrames = 0;
  if (state === "speaking" || state === "thinking" || state === "held") {
    // Holding during a reply = barge-in; during "thinking" = cancel the in-flight
    // turn (a brain stuck in a tool loop would otherwise lock the mic for minutes).
    // Either way it only triggers once the hold lasts long enough to be a real
    // utterance — a stray tap must not kill the turn. Recording starts now (see
    // onFrame) so the interruption isn't clipped.
    setStatus(state === "thinking" ? "keep holding to cancel & talk…" : "keep holding to interrupt…");
    pttBargeTimer = setTimeout(() => {
      pttBargeTimer = null;
      if (!holding) return;
      if (streamCaptureEnabled) pendingBargeAbort = true;
      else {
        const turnId = activeTurnId || currentAudioItem?.turnId;
        if (turnId) clientMetric(turnId, "barge_in");
        abortActiveTurn(); stopPlayback();
      }
      setState("speech"); orbLabel.textContent = "recording"; setStatus("recording… release to send");
      commitLiveCapture();
    }, MIN_UTTER_MS);
    return;                                     // keep the current state until the barge fires
  }
  setState("speech"); orbLabel.textContent = "recording"; setStatus("recording… release to send");
}
function endPtt() {
  if (!holding) return;
  holding = false;
  if (pttBargeTimer) {                          // released before the barge fired:
    clearTimeout(pttBargeTimer); pttBargeTimer = null;
    abortLiveCapture();
    speechFrames = []; speechLen = 0;           // stray tap — the in-flight turn is untouched
    captureTurnId = null;
    setStatus(state === "held" ? "listening… finish your thought" : state === "thinking" ? "thinking…" : "speaking…");
    return;
  }
  const durMs = (speechLen / (audioCtx ? audioCtx.sampleRate : 16000)) * 1000;
  if (durMs < MIN_UTTER_MS) { abortLiveCapture(); setStatus("too short — hold longer"); resumeListening(); return; }
  finalizeUtterance();                          // downsample + encode + send (shared with VAD path)
}

function resumeListening() {
  if (notifyQueue.length) {   // parked notifications speak before the mic reopens
    const q = notifyQueue; notifyQueue = [];
    turnDone = true;
    for (const b of q) enqueueAudio(b);
    return;
  }
  if (!convOn) { setState("idle"); return; }
  if (ptt && holding) {
    // The reply finished while the user was already holding to talk — promote the
    // in-progress hold to a live recording instead of resetting it.
    if (pttBargeTimer) { clearTimeout(pttBargeTimer); pttBargeTimer = null; }
    setState("speech"); orbLabel.textContent = "recording"; setStatus("recording… release to send");
    return;
  }
  captureTurnId = null;
  preRoll = []; speechFrames = []; onsetFrames = 0; silenceFrames = 0; speechLen = 0; holding = false;
  if (ptt) { setState("listening"); orbLabel.textContent = "hold to talk"; setStatus("hold SPACE (or the orb) to talk"); }
  else { setState("listening"); setStatus("listening… just talk"); }
}

// --- reply playback queue ---
// Each queued item carries a precomputed loudness envelope of its WAV so the orb can
// move with Cicero's actual voice during playback. Decoding the PCM ourselves (instead
// of routing <audio> through WebAudio + an analyser) keeps playback on the standard
// path, where the browser's echo cancellation reliably sees it — barge-in depends on that.
function wavEnvelope(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 44 || v.getUint32(0, true) !== 0x46464952 || v.getUint32(8, true) !== 0x45564157) return null;
    let off = 12, dataOff = -1, dataLen = 0, fmtOff = -1;
    while (off + 8 <= v.byteLength) {           // walk RIFF chunks to find "data"
      const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
      const len = v.getUint32(off + 4, true);
      if (len > v.byteLength - (off + 8)) return null;
      if (id === "fmt " && len >= 16) fmtOff = off + 8;
      if (id === "data") { dataOff = off + 8; dataLen = len; }
      off += 8 + len + (len & 1);
    }
    if (fmtOff < 0 || dataOff < 0) return null;
    const format = v.getUint16(fmtOff, true), channels = v.getUint16(fmtOff + 2, true);
    const sr = v.getUint32(fmtOff + 4, true), align = v.getUint16(fmtOff + 12, true);
    const bits = v.getUint16(fmtOff + 14, true), bytes = bits / 8;
    if (!sr || !channels || channels > 2 || !align || align !== channels * bytes ||
        !((format === 3 && bits === 32) || (format === 1 && [8, 16, 24, 32].includes(bits)))) return null;
    const n = Math.floor(Math.min(dataLen, v.byteLength - dataOff) / align);
    const win = Math.max(1, Math.round(sr * 0.05)); // 50ms RMS windows
    const env = []; let peak = 1e-6;
    for (let i = 0; i < n; i += win) {
      let s = 0; const m = Math.min(n, i + win);
      for (let j = i; j < m; j++) {
        let x = 0;
        for (let c = 0; c < channels; c++) {
          const p = dataOff + j * align + c * bytes;
          if (format === 3) x += v.getFloat32(p, true);
          else if (bits === 8) x += (v.getUint8(p) - 128) / 128;
          else if (bits === 16) x += v.getInt16(p, true) / 32768;
          else if (bits === 24) x += ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16)) << 8 >> 8) / 8388608;
          else x += v.getInt32(p, true) / 2147483648;
        }
        x /= channels; s += x * x;
      }
      const r = Math.sqrt(s / (m - i));
      env.push(r); if (r > peak) peak = r;
    }
    for (let i = 0; i < env.length; i++) env[i] = Math.min(1, env[i] / peak); // normalize per clip
    return { env: env, rate: sr / win, durationMs: n / sr * 1000 }; // rate = windows per second
  } catch (e) { return null; }
}

function sendAudioAck(item, status, atMs) {
  if (!item || !item.sequence || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: "audio_ack", sessionId: item.sessionId, turnId: item.turnId,
    sequence: item.sequence, status: status, ...(status === "interrupted" ? { atMs: Math.max(0, Math.min(120000, atMs || 0)) } : {}) })); } catch (e) { /* closed */ }
}
function enqueueAudio(buf, frame) {
  const env = wavEnvelope(buf);
  const ms = env && env.durationMs;
  if (!canQueueAudio(queuedAudioMs, ms)) {
    abortActiveTurn(); stopPlayback(); setStatus("audio backlog exceeded; turn interrupted"); return;
  }
  audioQueue.push({ buf: buf, env: env, durationMs: ms, sequence: frame && frame.sequence,
    sessionId: frame && frame.sessionId, turnId: frame && frame.turnId });
  queuedAudioMs += ms;
  if (!playing) playNext();
}
function playNext() {
  if (playbackPaused) return;
  if (audioQueue.length === 0) {
    playing = false; currentAudio = null; currentEnv = null;
    if (turnDone && !captureTurnId) { activeTurnId = null; if (!tentativeBarge) resumeListening(); }
    return;
  }
  playing = true; if (!captureTurnId) { setState("speaking"); setStatus("speaking…"); }
  const item = audioQueue.shift();
  queuedAudioMs -= item.durationMs;
  currentAudioItem = item;
  currentEnv = item.env;
  const a = new Audio(URL.createObjectURL(new Blob([item.buf], { type: "audio/wav" })));
  if (audioCtx) {
    try {
      currentAudioSource = audioCtx.createMediaElementSource(a);
      currentGainNode = audioCtx.createGain();
      currentGainNode.gain.value = voiceGain;
      currentAudioSource.connect(currentGainNode);
      currentGainNode.connect(audioCtx.destination);
    } catch (e) {
      currentAudioSource = null; currentGainNode = null;
      a.volume = Math.max(0.1, Math.min(1.0, voiceGain));
    }
  } else {
    a.volume = Math.max(0.1, Math.min(1.0, voiceGain));
  }
  currentAudio = a;
  const cleanup = () => {
    try { if (currentAudioSource) currentAudioSource.disconnect(); } catch (e) { /* ignore */ }
    try { if (currentGainNode) currentGainNode.disconnect(); } catch (e) { /* ignore */ }
    currentAudioSource = null; currentGainNode = null;
  };
  const finishClip = (status) => {
    if (currentAudio !== a) return;
    sendAudioAck(item, status, a.currentTime * 1000);
    cleanup(); URL.revokeObjectURL(a.src);
    currentAudio = null; currentAudioItem = null;
    playNext();
  };
  a.onended = () => finishClip("played");
  a.onplaying = () => {
    if (!item.turnId || !item.sequence) return;
    const key = item.turnId + ":" + item.sequence;
    if (!playedMetrics.has(key)) { playedMetrics.add(key); while (playedMetrics.size > 64) playedMetrics.delete(playedMetrics.values().next().value); clientMetric(item.turnId, "audio_started", performance.now(), item.sequence); }
  };
  a.onerror = () => finishClip("interrupted");
  const generation = playbackGeneration;
  a.play().catch(() => {
    // A tentative pause can reject the initial play promise. The pause/resume
    // owner now holds this clip; an old promise must not revoke its audio URL.
    if (playbackGeneration !== generation) return;
    finishClip("interrupted");
  });
}

// Stop the reply mid-stream (barge-in or conversation stop): kill the playing clip,
// drop anything queued, and forget the in-flight turn so a stale {done} can't resume us.
function stopPlayback() {
  playbackGeneration++;
  falseInterruption?.cancel(); tentativeBarge = null; playbackPaused = false;
  for (const item of audioQueue) sendAudioAck(item, "interrupted", 0);
  audioQueue = [];
  queuedAudioMs = 0;
  if (currentAudio) {
    sendAudioAck(currentAudioItem, "interrupted", currentAudio.currentTime * 1000);
    try { currentAudio.pause(); } catch (e) { /* ignore */ }
    try { URL.revokeObjectURL(currentAudio.src); } catch (e) { /* ignore */ }
    currentAudio = null;
  }
  currentAudioItem = null;
  try { if (currentAudioSource) currentAudioSource.disconnect(); } catch (e) { /* ignore */ }
  try { if (currentGainNode) currentGainNode.disconnect(); } catch (e) { /* ignore */ }
  currentAudioSource = null; currentGainNode = null;
  currentEnv = null;
  playing = false; turnDone = false; activeTurnId = null;
}

// --- proactive notifications (server-pushed voice-back) ---
// Cicero speaking up unprompted: "PR one-forty-two is up." Played immediately
// when idle/listening; queued during a turn so it never talks over the
// conversation, and drained at the natural resume.
let notifyQueue = [];
function notifyBuf(msg) {
  if (!msg.audioBase64) return null;
  try {
    const bin = atob(msg.audioBase64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  } catch (e) { return null; }
}
// Replay persisted turns into the log on first connect only — a mid-session
// reconnect would otherwise duplicate bubbles that are already on screen.
function handleNotify(msg) {
  hintEl.textContent = "\uD83D\uDD14 " + msg.text.slice(0, 80) + (msg.text.length > 80 ? "…" : "");
  showNotice(msg.text);
  const buf = notifyBuf(msg);
  if (!buf) return;
  const busy = state === "thinking" || state === "held" || state === "speaking" || state === "speech" || holding || playing;
  if (busy) { notifyQueue.push(buf); return; }
  turnDone = true;            // so playback completion resumes listening
  enqueueAudio(buf);
}

const confirmationEl = document.getElementById("confirmations");
const confirmationCards = new Map();
function removeConfirmation(nonce) {
  const card = confirmationCards.get(nonce);
  if (!card) return;
  card.remove();
  confirmationCards.delete(nonce);
}
function clearConfirmations() {
  confirmationCards.forEach((card) => card.remove());
  confirmationCards.clear();
}
function showConfirmation(msg) {
  if (typeof msg.nonce !== "string" || typeof msg.summary !== "string") return;
  removeConfirmation(msg.nonce);
  const card = document.createElement("div");
  card.className = "confirm-card";
  card.dataset.nonce = msg.nonce;
  const summary = document.createElement("div");
  summary.className = "confirm-summary";
  summary.textContent = msg.summary;
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  function decisionButton(label, approved, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.onclick = function () {
      Array.from(actions.querySelectorAll("button")).forEach((item) => { item.disabled = true; });
      try {
        ws.send(JSON.stringify({ type: "confirm", sessionId: wsSessionId, nonce: msg.nonce, approved: approved }));
      } catch (e) { removeConfirmation(msg.nonce); }
    };
    return button;
  }
  actions.appendChild(decisionButton("Deny", false, "confirm-deny"));
  actions.appendChild(decisionButton("Approve", true, "confirm-approve"));
  card.appendChild(summary);
  card.appendChild(actions);
  confirmationCards.set(msg.nonce, card);
  confirmationEl.appendChild(card);
}

function handleVolumeControl(msg) {
  if (typeof msg.volume === "number") voiceGain = Math.max(0.2, Math.min(2.0, msg.volume));
  else voiceGain = Math.max(0.2, Math.min(2.0, voiceGain + (Number(msg.delta) || 0)));
  if (currentGainNode) currentGainNode.gain.value = voiceGain;
  if (currentAudio) currentAudio.volume = Math.max(0.1, Math.min(1.0, voiceGain));
  hintEl.textContent = "voice volume " + Math.round(voiceGain * 100) + "%";
}

function onWsMessage(e) {
  if (typeof e.data !== "string") {
    const frame = decodeReplyFrame(e.data);
    const live = state === "thinking" || state === "held" || state === "speaking" || !!tentativeBarge;
    if (frame && live && frame.sessionId === wsSessionId && frame.turnId === activeTurnId) enqueueAudio(frame.payload, frame);
    return;
  }
  let msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
  if (msg.type === "hello" && msg.protocol === 2 && typeof msg.sessionId === "string") {
    wsSessionId = msg.sessionId;
    streamOn = false;
    reconnectAttempt = 0;
    setDot(true); setStatus("connected — listening… just talk");
    resumeListening();
    return;
  }
  if (!wsSessionId || msg.sessionId !== wsSessionId) return;
  if (msg.type === "barge_on") { falseInterruption = new FalseInterruption(Math.max(250, Math.min(10000, Number(msg.timeoutMs) || 1500))); return; }
  if (msg.type === "barge_result") { finishBarge(msg); return; }
  if (msg.type === "confirm_request") { showConfirmation(msg); return; }
  if (msg.type === "confirm_result" || msg.type === "confirm_resolved") { removeConfirmation(msg.nonce); return; }
  if (msg.type === "notify") { handleNotify(msg); return; } // arrives any time, not just mid-turn
  if (msg.type === "history") { return; } // server replay ignored: each page load starts a fresh chat
  if (msg.type === "probe_on") { probeOn = true; return; } // server has an end-of-turn model
  if (msg.type === "stream_on") { applyStreamCapability(true); return; }
  if (msg.type === "stream_off") { applyStreamCapability(false); return; }
  if (msg.type === "partial_transcript" && typeof msg.text === "string" && msg.text.length <= 16384 &&
      ((msg.turnId === captureTurnId && state === "speech") || (msg.turnId === activeTurnId && state === "thinking"))) {
    hintEl.textContent = 'hearing: "' + msg.text + '"'; return;
  }
  if (msg.type === "verdict") { onVerdict(msg); return; }  // arrives mid-speech, before "thinking"
  if (msg.type === "error" && msg.turnId === null) {
    setStatus("connection error: " + (msg.message || "protocol error"));
    return;
  }
  // All remaining messages belong to exactly the submitted live turn. A late
  // frame from an aborted turn is ignored even if the UI is already thinking
  // about its replacement.
  if (!activeTurnId || msg.turnId !== activeTurnId) return;
  const live = state === "thinking" || state === "held" || state === "speaking" || !!tentativeBarge;
  if (!live) return;
  if (msg.type === "hold") {
    preRoll = []; onsetFrames = 0;
    setState("held"); orbLabel.textContent = "listening";
    setStatus("listening… finish your thought");
    return;
  }
  if (state === "held") { setState("thinking"); setStatus("thinking…"); }
  if (msg.type === "volume") { handleVolumeControl(msg); return; } // apply before the ack audio arrives
  if (msg.type === "rate") { hintEl.textContent = "voice speed " + Math.round((Number(msg.rate) || 1) * 100) + "%"; return; }
  // No chat panel — the hint line flashes what STT heard, so a mishear is
  // tellable from a misroute at a glance. Telegram is the text surface.
  if (msg.type === "transcript") { if (msg.text) hintEl.textContent = 'heard: "' + msg.text + '"'; else setStatus("didn't catch that"); }
  else if (msg.type === "sentence") { /* spoken, not displayed */ }
  else if (msg.type === "error") {
    // The server sends {type:"error", message} and no "done" after it — treat it
    // as terminal so the mic isn't locked in "thinking" forever.
    setStatus("error: " + (msg.message || msg.text || "unknown"));
    turnDone = true;
    if (!playing && !playbackPaused && !captureTurnId) { activeTurnId = null; resumeListening(); }
  }
  else if (msg.type === "done") { turnDone = true; if (!playing && !playbackPaused && !captureTurnId) { activeTurnId = null; resumeListening(); } }
  if (msg.type === "transcript" || msg.type === "sentence") turnDone = false;
}

// Auto-reconnect while the conversation is on: driving on tethered LTE (or any
// flaky network) drops the socket routinely, and a hands-free user can't tap
// "Start" again. Backoff 1s → 2s → 5s, retrying forever until the user stops
// the conversation; an in-flight turn's reply is lost (just ask again).
let reconnectTimer = null, reconnectAttempt = 0;
function scheduleReconnect() {
  if (!convOn || reconnectTimer) return;
  const delay = [1000, 2000, 5000][Math.min(reconnectAttempt, 2)];
  reconnectAttempt++;
  setStatus("reconnecting… (attempt " + reconnectAttempt + ")");
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (convOn) connectWs(true); }, delay);
}
// Coming back online / to the foreground: retry immediately, not on the timer.
function retryNow() {
  if (!convOn || (ws && ws.readyState <= 1)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectWs(true);
}
window.addEventListener("online", retryNow);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { retryNow(); requestWakeLock(); } });

// The resume flag separates an automatic reconnect from the operator pressing Start.
// The server cannot tell them apart from the socket alone, and Stop pressed
// during the backoff has no open socket to send its goodbye on — so a restart
// would otherwise inherit the stopped conversation's deferred work.
function connectWs(resume = false) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  wsSessionId = "";
  const sock = new WebSocket(scheme + "//" + location.host + "/ws?protocol=2&token=" + encodeURIComponent(TOKEN) + (resume ? "&resume=1" : ""));
  ws = sock;
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { setDot(true); setStatus("connected — securing session…"); };
  ws.onmessage = onWsMessage;
  ws.onerror = () => { setDot(false); };
  ws.onclose = () => {
    setDot(false);
    if (ws !== sock) return;          // superseded by a newer socket — not ours to handle
    wsSessionId = ""; activeTurnId = null; captureTurnId = null; streamOn = false;
    clearConfirmations();
    stopPlayback(); falseInterruption = null;
    if (convOn) setState("listening");
    if (convOn) scheduleReconnect(); else setStatus("disconnected");
  };
}

// Screen wake lock: dictating while driving means nobody touches the laptop for
// long stretches — without this the screen sleeps and the tab (and mic) can be
// throttled or suspended. Best-effort; re-acquired on tab visibility (the OS
// releases wake locks whenever the tab is hidden).
let wakeLock = null;
async function requestWakeLock() {
  if (!convOn || !navigator.wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* unsupported or denied — conversation still works */ }
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
}

async function ensureAudio() {
  if (ready) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("no mic access (needs HTTPS or localhost)"); return false;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(micStream);
    if (audioCtx.audioWorklet && window.AudioWorkletNode) {
      await audioCtx.audioWorklet.addModule("/capture-worklet-v1.js");
      node = new AudioWorkletNode(audioCtx, "cicero-capture-v1");
      frameMs = (2048 / audioCtx.sampleRate) * 1000;
      node.port.onmessage = (e) => { if (e.data instanceof Float32Array && e.data.length === 2048) onFrame(e.data); };
      capturePath = "worklet";
    } else {
      node = audioCtx.createScriptProcessor(4096, 1, 1);
      frameMs = (4096 / audioCtx.sampleRate) * 1000;
      // Copy the browser-owned buffer before pre-roll or speech storage.
      node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      capturePath = "script-processor";
    }
    source.connect(node);
    node.connect(audioCtx.destination); // ScriptProcessor only runs while connected; we write no output (silent)
    ready = true;
    return true;
  } catch (err) {
    try { if (node) node.disconnect(); } catch (e) { /* ignore */ }
    try { if (source) source.disconnect(); } catch (e) { /* ignore */ }
    if (micStream) micStream.getTracks().forEach((track) => track.stop());
    if (audioCtx) try { await audioCtx.close(); } catch (e) { /* ignore */ }
    node = null; source = null; micStream = null; audioCtx = null;
    setStatus("mic error: " + (err && err.message ? err.message : err));
    return false;
  }
}

async function startConversation(resume = false) {
  if (!TOKEN) {
    setStatus("authorization required — reopen the tokened Cicero URL once");
    return;
  }
  if (!(await ensureAudio())) return;
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch (e) { /* ignore */ } }
  convOn = true; toggleLabel.textContent = "Stop conversation"; toggle.classList.add("on");
  connectWs(resume);
  requestWakeLock();
}

function stopConversation() {
  convOn = false; toggleLabel.textContent = "Start conversation"; toggle.classList.remove("on"); setDot(false);
  holding = false;
  notifyQueue = [];
  clearConfirmations();
  releaseWakeLock();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
  if (pttBargeTimer) { clearTimeout(pttBargeTimer); pttBargeTimer = null; }
  abortActiveTurn();
  // Tell the server this is the operator stopping, not the network dropping:
  // the two are indistinguishable from a closed socket, and only this one means
  // "call off anything you were still working on for me".
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: "bye" })); } catch (e) { /* ignore */ } }
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
  wsSessionId = ""; captureTurnId = null; streamOn = false;
  stopPlayback();
  setState("idle"); setStatus("stopped");
  if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
}

// Buttons blur after click so SPACE goes back to driving push-to-talk (a focused
// button would swallow it as a click — see spaceIsPtt).
toggle.addEventListener("click", () => {
  if (convOn) stopConversation();
  else { ignite(); void startConversation().catch((err) => setStatus("start failed: " + (err && err.message ? err.message : err))); }
  toggle.blur();
});

// Push-to-talk controls: SPACE (keyboard) + press-and-hold the orb (mouse/touch).
// Mode is a segmented control: Push-to-talk | Hands-free.
const modePtt = document.getElementById("modePtt");
const modeVad = document.getElementById("modeVad");
const hintEl = document.getElementById("hint");
// Notices: a notify that carries a URL stays on screen as a tappable card —
// the hint line is transient and the next status flash would eat the link.
const noticeEl = document.getElementById("notice");
const noticeTextEl = document.getElementById("noticeText");
document.getElementById("noticeClose").onclick = function () { noticeEl.classList.remove("show"); };
const NOTICE_URL_RE = /https?:\\/\\/[^\\s<>"')\\]]+/g;
function showNotice(text) {
  NOTICE_URL_RE.lastIndex = 0;
  noticeTextEl.textContent = "";
  let last = 0, m;
  while ((m = NOTICE_URL_RE.exec(text))) {
    if (m.index > last) noticeTextEl.appendChild(document.createTextNode(text.slice(last, m.index)));
    // Sentence punctuation glued to the URL stays text, not part of the link.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = url.replace(/^https?:\\/\\/(www\\.)?/, "");
    noticeTextEl.appendChild(a);
    last = m.index + url.length;
  }
  if (last < text.length) noticeTextEl.appendChild(document.createTextNode(text.slice(last)));
  noticeEl.classList.add("show");
}
function applyMode() {
  holding = false;
  modePtt.className = ptt ? "sel" : "";
  modeVad.className = ptt ? "" : "sel";
  hintEl.innerHTML = ptt
    ? "Push-to-talk: hold <b>SPACE</b> (or press &amp; hold the orb) to talk — release to send."
    : "Hands-free: just talk — it detects when you start and stop. Talk over Cicero any time to interrupt.";
  // Don't yank the state while a turn is in flight — the reply's remaining frames
  // would be dropped. The mode change applies at the natural resume (resumeListening
  // reads ptt fresh when the turn ends).
  if (convOn && state !== "thinking" && state !== "held" && state !== "speaking") resumeListening();
}
modePtt.addEventListener("click", () => { ptt = true; applyMode(); modePtt.blur(); try { localStorage.setItem("ciceroMode", "ptt"); } catch (e) { /* ignore */ } });
modeVad.addEventListener("click", () => { ptt = false; applyMode(); modeVad.blur(); try { localStorage.setItem("ciceroMode", "vad"); } catch (e) { /* ignore */ } });
applyMode(); // reflect the restored mode in the UI (the HTML pre-selects PTT)
// Space drives PTT only when no form control is focused — otherwise it must keep
// activating the focused checkbox/button (keyboard users need to toggle modes).
function spaceIsPtt(e) {
  const t = e.target;
  return !(t && (t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable));
}
document.addEventListener("keydown", (e) => { if (e.code === "Space" && spaceIsPtt(e) && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); beginPtt(); } });
document.addEventListener("keyup", (e) => { if (e.code === "Space" && (holding || spaceIsPtt(e))) { e.preventDefault(); endPtt(); } });
orb.addEventListener("pointerdown", (e) => { e.preventDefault(); beginPtt(); });
orb.addEventListener("pointerup", (e) => { e.preventDefault(); endPtt(); });
orb.addEventListener("pointerleave", () => { if (holding) endPtt(); });
window.addEventListener("blur", () => { if (holding) endPtt(); }); // releasing focus = release the key

// --- The orb: a canvas-drawn reactor that moves with the audio. Level source depends
// on state — the live mic (push-to-talk hold / VAD speech) or the playing reply's
// precomputed WAV envelope. Everything else (arcs, ticks, core breathing) is time-based
// so the orb is always alive, and per-state hue + spin speed replace the old CSS classes.
const octx = orbCanvas.getContext("2d");
const ORB_STYLE = {
  idle:      { hue: 200, glow: 0.35, spin: 0.25 },
  listening: { hue: 187, glow: 0.55, spin: 0.5 },
  speech:    { hue: 145, glow: 0.9,  spin: 0.9 },
  held:      { hue: 185, glow: 0.35, spin: 0.4 },
  thinking:  { hue: 42,  glow: 0.7,  spin: 3.0 },
  speaking:  { hue: 210, glow: 0.85, spin: 1.1 },
};
let orbLevel = 0, orbSpin = 0, orbPrevT = 0;
function sizeOrb() {
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, orb.clientWidth);
  orbCanvas.width = Math.round(px * dpr); orbCanvas.height = Math.round(px * dpr);
}
window.addEventListener("resize", sizeOrb);
sizeOrb();
function orbHsla(h, s, l, a) { return "hsla(" + h + "," + s + "%," + l + "%," + a + ")"; }
function orbTargetLevel(t) {
  if (state === "speech") return micLevel;
  if (state === "listening" && !ptt && convOn) return micLevel * 0.7;
  if (state === "speaking" && currentAudio && currentEnv && currentEnv.env.length) {
    const idx = Math.floor(currentAudio.currentTime * currentEnv.rate);
    return currentEnv.env[Math.min(idx, currentEnv.env.length - 1)] || 0;
  }
  if (state === "thinking") return 0.22 + 0.14 * Math.sin(t * 4); // synthetic pulse — nothing audible to track
  return 0;
}
function drawOrb(tms) {
  requestAnimationFrame(drawOrb);
  const t = tms / 1000;
  const dt = Math.min(0.1, orbPrevT ? t - orbPrevT : 0.016);
  orbPrevT = t;
  const st = ORB_STYLE[state] || ORB_STYLE.idle;
  orbSpin += st.spin * dt;
  orbLevel += (orbTargetLevel(t) - orbLevel) * Math.min(1, dt * 12);
  const lvl = Math.max(0, Math.min(1, orbLevel));
  const W = orbCanvas.width, c = W / 2, R = W / 2, hue = st.hue;
  octx.clearRect(0, 0, W, W);
  octx.lineCap = "round";

  // outer ring + tick marks (slow drift)
  octx.lineWidth = Math.max(1, W * 0.004);
  octx.strokeStyle = orbHsla(hue, 80, 60, 0.35);
  octx.beginPath(); octx.arc(c, c, R * 0.96, 0, Math.PI * 2); octx.stroke();
  octx.strokeStyle = orbHsla(hue, 70, 65, 0.28);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 + orbSpin * 0.15;
    const r1 = R * (i % 5 === 0 ? 0.895 : 0.92), r2 = R * 0.95;
    octx.beginPath();
    octx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    octx.lineTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
    octx.stroke();
  }

  // two counter-rotating HUD arc sets
  octx.lineWidth = W * 0.008;
  octx.strokeStyle = orbHsla(hue, 90, 62, 0.85);
  for (let i = 0; i < 3; i++) {
    const a0 = orbSpin + i * (Math.PI * 2 / 3);
    octx.beginPath(); octx.arc(c, c, R * 0.84, a0, a0 + 0.9); octx.stroke();
  }
  octx.lineWidth = W * 0.013;
  octx.strokeStyle = orbHsla(hue, 90, 70, 0.45);
  for (let i = 0; i < 2; i++) {
    const a0 = -orbSpin * 0.6 + i * Math.PI;
    octx.beginPath(); octx.arc(c, c, R * 0.73, a0, a0 + 1.5); octx.stroke();
  }

  // radial equalizer spikes — height rides the audio level, per-bar shimmer via sin hash
  const bars = 56, r0 = R * 0.46;
  octx.lineWidth = Math.max(1, W * 0.006);
  octx.strokeStyle = orbHsla(hue, 95, 65, 0.12 + 0.55 * lvl);
  for (let i = 0; i < bars; i++) {
    const a = (i / bars) * Math.PI * 2;
    const n = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 12.9898 + t * (3 + (i % 7))));
    const len = R * (0.015 + 0.2 * lvl * n);
    octx.beginPath();
    octx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    octx.lineTo(c + Math.cos(a) * (r0 + len), c + Math.sin(a) * (r0 + len));
    octx.stroke();
  }

  // core glow (breathes when idle, swells with the voice) + hot center
  const coreR = R * (0.3 + 0.02 * Math.sin(t * 1.4) + 0.12 * lvl);
  let g = octx.createRadialGradient(c, c, 0, c, c, coreR * 1.6);
  g.addColorStop(0, orbHsla(hue, 100, 85, st.glow));
  g.addColorStop(0.35, orbHsla(hue, 95, 60, st.glow * 0.55));
  g.addColorStop(1, orbHsla(hue, 95, 55, 0));
  octx.fillStyle = g;
  octx.beginPath(); octx.arc(c, c, coreR * 1.6, 0, Math.PI * 2); octx.fill();
  g = octx.createRadialGradient(c, c, 0, c, c, coreR * 0.5);
  g.addColorStop(0, "rgba(255,255,255," + (0.45 + 0.4 * lvl).toFixed(3) + ")");
  g.addColorStop(1, orbHsla(hue, 100, 75, 0));
  octx.fillStyle = g;
  octx.beginPath(); octx.arc(c, c, coreR * 0.5, 0, Math.PI * 2); octx.fill();

  orbLabel.style.color = orbHsla(hue, 90, 80, 0.95);
  orbLabel.style.textShadow = "0 0 10px " + orbHsla(hue, 95, 60, 0.7);
}
requestAnimationFrame(drawOrb);

if (!TOKEN) setStatus("authorization required — reopen the tokened Cicero URL once");
else setStatus(window.isSecureContext ? "tap start to talk" : "NOT a secure context — mic blocked (use https:// or localhost)");
updateDebug();

// Auto-start (opt-in, remembered per browser like the mic mode): reloads open
// the mic with no click. Gated on the permission ALREADY being granted — the
// page never prompts without a user gesture; browsers allow the AudioContext
// to run gesture-free once an active capture stream exists, and if this one
// stays suspended anyway we fall back to the Start button. The orb stays
// dormant either way until the first real utterance (ignite via setState).
const autoBtn = document.getElementById("autoStart");
let autoStart = false;
try { autoStart = localStorage.getItem("ciceroAuto") === "1"; } catch (e) { /* storage disabled */ }
function renderAuto() {
  autoBtn.className = autoStart ? "sel" : "";
  autoBtn.textContent = autoStart ? "Auto-start on" : "Auto-start off";
  // cinema: with auto-start on, the dormant page hides ALL chrome behind a
  // near-black shroud (no button is needed); ignition fades it out with the orb.
  // Never without a token: the "authorization required" status must stay
  // visible, not fail silently behind the blackout.
  document.body.classList.toggle("cinema", autoStart && !!TOKEN);
}
function revealAutoStartFallback(status) {
  // Auto-start is optional. A failed attempt must reveal the manual controls
  // instead of leaving a persisted cinema shroud over the Start button.
  document.body.classList.remove("cinema");
  if (status) setStatus(status);
}
autoBtn.addEventListener("click", () => {
  autoStart = !autoStart;
  try { localStorage.setItem("ciceroAuto", autoStart ? "1" : "0"); } catch (e) { /* storage disabled */ }
  renderAuto(); autoBtn.blur();
});
renderAuto();
(async function autoStartOnLoad() {
  if (!autoStart || !TOKEN || convOn) return;
  if (!window.isSecureContext) {
    revealAutoStartFallback(); // preserve the secure-context status above
    return;
  }
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const permission = await navigator.permissions.query({ name: "microphone" });
      if (permission.state !== "granted") {
        revealAutoStartFallback("tap start to enable the mic");
        return;
      }
    }
    await startConversation(true);
    if (!convOn) {
      revealAutoStartFallback(); // preserve ensureAudio's useful mic error
      return;
    }
    if (audioCtx && audioCtx.state === "suspended") {
      stopConversation();
      revealAutoStartFallback("autoplay blocked — tap start to talk");
    }
  } catch (e) {
    revealAutoStartFallback("auto-start failed — tap start to talk");
  }
})();
</script>
</body>
</html>`;
