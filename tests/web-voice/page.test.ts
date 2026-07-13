import { expect, test } from "bun:test";
import { PAGE } from "../../src/web-voice/page";

test("web-voice page script parses and opts into the identity-safe protocol", () => {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Function(script!)).not.toThrow();
  expect(script).toContain("protocol=2");
  expect(script).toContain("sessionId: wsSessionId");
  expect(script).toContain("frame.turnId === activeTurnId");
  expect(script).toContain('clean.searchParams.delete("token")');
  expect(script).toContain('history.replaceState(null, ""');
});

test("orb scales with the viewport instead of a fixed pixel size", () => {
  expect(PAGE).toContain("#orb { width:clamp(230px, 80vmin, calc(100dvh - 260px)); aspect-ratio:1/1;");
  expect(PAGE).not.toContain("width:230px; height:230px");
});

test("page loads dormant and lights up on the first interaction", () => {
  expect(PAGE).toContain('<body class="pre">');
  expect(PAGE).toContain("body.pre #orb { opacity:0.05; }");
  expect(PAGE).toContain("body.pre #orbLabel { opacity:0; }");
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  // ignition fires on the first real speech (setState is the choke point every
  // capture path goes through) and on a manual Start click — but NOT inside
  // startConversation, so an auto-started page stays dormant until spoken to.
  expect(script).toContain('function setState(s) { if (s === "speech") ignite();');
  expect(script).toContain("else { ignite(); void startConversation()");
  const startConv = script.slice(script.indexOf("async function startConversation"), script.indexOf("function stopConversation"));
  expect(startConv).not.toContain("ignite");
});

test("auto-start is opt-in, remembered, and respects an available mic permission query", () => {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  expect(PAGE).toContain('<button id="autoStart">');
  expect(script).toContain('localStorage.getItem("ciceroAuto")');
  expect(script).toContain('if (navigator.permissions && navigator.permissions.query)');
  expect(script).not.toContain('if (!navigator.permissions || !navigator.permissions.query)');
  expect(script).toContain('navigator.permissions.query({ name: "microphone" })');
  expect(script).toContain('if (permission.state !== "granted")');
  // suspended-AudioContext fallback: never leave a half-started conversation
  expect(script).toContain('if (audioCtx && audioCtx.state === "suspended")');
  expect(script).toContain("stopConversation();");
});

test("every auto-start failure reveals the manual controls", () => {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  expect(script).toContain('function revealAutoStartFallback(status)');
  expect(script).toContain('document.body.classList.remove("cinema")');
  expect(script).toContain('if (!window.isSecureContext) {');
  expect(script).toContain('revealAutoStartFallback(); // preserve the secure-context status');
  expect(script).toContain('revealAutoStartFallback("tap start to enable the mic")');
  expect(script).toContain('if (!convOn) {');
  expect(script).toContain('revealAutoStartFallback(); // preserve ensureAudio');
  expect(script).toContain('revealAutoStartFallback("autoplay blocked — tap start to talk")');
  expect(script).toContain('revealAutoStartFallback("auto-start failed — tap start to talk")');
});

test("cinema shroud blacks out the chrome only when auto-start is on", () => {
  expect(PAGE).toContain('<div id="shroud"></div>');
  // shroud only covers the chrome while dormant AND in cinema mode — a dormant
  // page without auto-start must keep its Start button visible
  expect(PAGE).toContain("body.pre.cinema #shroud { opacity:1; }");
  expect(PAGE).toContain("pointer-events:none");
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  // Token-gated: a device that opted in but lost its token must still see the
  // "authorization required" status instead of a silent blackout.
  expect(script).toContain('document.body.classList.toggle("cinema", autoStart && !!TOKEN)');
});

test("speech gate confirms speech behind the energy gate and degrades honestly", () => {
  const script = PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  // assets load same-origin, never from a CDN
  expect(script).toContain('el.src = "/vad/ort.wasm.min.js"');
  expect(script).toContain('ort.env.wasm.wasmPaths = "/vad/"');
  expect(script).toContain('InferenceSession.create("/vad/silero_vad_v5.onnx"');
  // both consumers sit behind the confirmation
  expect(script).toContain("speechConfirmed(VAD_POS)");
  expect(script).toContain("rms > bargeThr && speechConfirmed(VAD_BARGE)");
  // load or run failure → energy-only, never a broken gate
  expect(script).toContain("return !vadSession || vadProb >= thr");
  // PTT capture stays ungated (a held key is deliberate)
  expect(script).toContain('if (!ptt && (state === "listening" || state === "speech" || state === "speaking")) speechGateFeed(buf);');
});
