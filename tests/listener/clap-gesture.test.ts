import { test, expect } from "bun:test";
import { ConversationalListener } from "../../src/listener/conversational";

// A double-clap means different things depending on what Cicero is doing, because
// it's the one signal that cuts through Cicero's own playback (peak-based, not
// energy-relative — unlike voice barge-in, which AEC-less can't hear over the
// speakers). While Cicero SPEAKS → interrupt. While idle-LISTENING → deactivate
// (only if clap.deactivate is on). These are mutually exclusive states.

type Stub = ConversationalListener & {
  active: boolean;
  detectingBargeIn: boolean;
  onClapGesture: () => void;
};

function makeListener(opts: { fullDuplex: boolean; clapDeactivate: boolean }) {
  const stt = { transcribe: async () => "" } as never;
  const recorder = {} as never;
  const player = { play: async () => {} } as never;
  // ctor: (stt, recorder, player, bargeIn, silDur, silThr, turn, vad, earcons, fullDuplex, clap)
  const clap = { threshold: 0.5, minGapMs: 80, maxGapMs: 600, deactivate: opts.clapDeactivate };
  const l = new ConversationalListener(
    stt, recorder, player, false, "1.0", "3%", undefined, { hangoverMs: 500 }, false, opts.fullDuplex, clap,
  ) as Stub;
  l.active = true;
  return l;
}

test("clap while Cicero is speaking → interrupt, not deactivate", () => {
  const l = makeListener({ fullDuplex: true, clapDeactivate: false });
  let interrupted = false;
  let deactivated = false;
  l.onBargeIn(() => { interrupted = true; });
  l.onDeactivate(() => { deactivated = true; });

  l.detectingBargeIn = true; // mid-reply
  l.onClapGesture();

  expect(interrupted).toBe(true);
  expect(deactivated).toBe(false);
  expect(l.isActive()).toBe(true); // still in voice mode, just listening now
});

test("clap while idle-listening → deactivate when clap.deactivate is on", () => {
  const l = makeListener({ fullDuplex: true, clapDeactivate: true });
  let interrupted = false;
  let deactivated = false;
  l.onBargeIn(() => { interrupted = true; });
  l.onDeactivate(() => { deactivated = true; });

  l.detectingBargeIn = false; // between turns
  l.onClapGesture();

  expect(interrupted).toBe(false);
  expect(deactivated).toBe(true);
  expect(l.isActive()).toBe(false);
});

test("clap while idle-listening does nothing when clap.deactivate is off", () => {
  const l = makeListener({ fullDuplex: true, clapDeactivate: false });
  let interrupted = false;
  let deactivated = false;
  l.onBargeIn(() => { interrupted = true; });
  l.onDeactivate(() => { deactivated = true; });

  l.detectingBargeIn = false;
  l.onClapGesture();

  expect(interrupted).toBe(false);
  expect(deactivated).toBe(false);
  expect(l.isActive()).toBe(true);
});
