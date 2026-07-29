import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationListener } from "../../src/listener/dictation";
import type { AudioRecorder } from "../../src/platform/audio";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A recorder that writes its file on kill, like a real one flushing on exit. */
function fakeRecorder(): AudioRecorder & { started: string[]; kills: number; killGate?: Promise<void> } {
  const state = {
    started: [] as string[],
    kills: 0,
    killGate: undefined as Promise<void> | undefined,
    record(outPath: string) {
      state.started.push(outPath);
      let exit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => { exit = resolve; });
      return {
        exited,
        kill: () => {
          state.kills += 1;
          void Bun.write(outPath, "RIFFfake").then(() => exit(0));
        },
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
  };
  return state as unknown as AudioRecorder & { started: string[]; kills: number };
}

function listener(overrides: Partial<Parameters<typeof DictationListener.prototype.constructor>[0]> = {}) {
  dir = dir || mkdtempSync(join(tmpdir(), "cicero-dictation-"));
  const recorder = fakeRecorder();
  const typed: string[] = [];
  const deps = {
    stt: { transcribe: async () => "hello world" },
    recorder,
    typeText: async (text: string) => { typed.push(text); },
    audioDir: dir,
    ...overrides,
  };
  return { dict: new DictationListener(deps as never), recorder, typed, deps };
}

describe("dictation state machine", () => {
  test("press → record, press again → transcribe and type into the focused app", async () => {
    const { dict, recorder, typed } = listener();
    await dict.start();
    expect(dict.getState()).toBe("idle");

    await dict.toggle();
    expect(dict.getState()).toBe("recording");
    expect(recorder.started.length).toBe(1);
    expect(typed).toEqual([]);

    await dict.toggle();
    expect(recorder.kills).toBe(1);
    expect(typed).toEqual(["hello world"]);
    expect(dict.getState()).toBe("idle");
  });

  test("the capture file is removed after transcription", async () => {
    const { dict, recorder } = listener();
    await dict.start();
    await dict.toggle();
    const file = recorder.started[0]!;
    await dict.toggle();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a toggle before start() is ignored — no recorder is spawned", async () => {
    const { dict, recorder } = listener();
    await dict.toggle();
    expect(recorder.started.length).toBe(0);
    expect(dict.getState()).toBe("idle");
  });

  test("an empty transcript types nothing and returns to idle", async () => {
    const { dict, typed } = listener({ stt: { transcribe: async () => "   " } });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(typed).toEqual([]);
    expect(dict.getState()).toBe("idle");
  });

  test("a null transcript (STT miss) is handled without throwing", async () => {
    const { dict, typed } = listener({ stt: { transcribe: async () => null } });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(typed).toEqual([]);
    expect(dict.getState()).toBe("idle");
  });

  // A dictation failure is an operator annoyance, not a daemon-killing event.
  test("an STT failure is contained and leaves the listener usable", async () => {
    let calls = 0;
    const { dict, typed } = listener({
      stt: {
        transcribe: async () => {
          calls += 1;
          if (calls === 1) throw new Error("stt exploded");
          return "second attempt";
        },
      },
    });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(dict.getState()).toBe("idle");
    expect(typed).toEqual([]);

    // Still works afterwards — the failure did not wedge the state machine.
    await dict.toggle();
    await dict.toggle();
    expect(typed).toEqual(["second attempt"]);
  });

  test("an injector failure is contained too", async () => {
    const { dict } = listener({ typeText: async () => { throw new Error("no display"); } });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(dict.getState()).toBe("idle");
  });

  // Two captures racing to type into the same field is worse than dropping one.
  test("a press during transcription is ignored rather than starting a second capture", async () => {
    let releaseStt!: () => void;
    const gate = new Promise<void>((r) => { releaseStt = r; });
    const { dict, recorder, typed } = listener({
      stt: { transcribe: async () => { await gate; return "slow result"; } },
    });
    await dict.start();
    await dict.toggle();
    const finishing = dict.toggle();
    expect(dict.getState()).toBe("transcribing");

    await dict.toggle(); // ignored
    expect(recorder.started.length).toBe(1);

    releaseStt();
    await finishing;
    expect(typed).toEqual(["slow result"]);
  });

  test('the "cicero" target hands the transcript to the command callback, not the keyboard', async () => {
    const commands: string[] = [];
    const { dict, typed } = listener({ target: "cicero" });
    dict.onCommand((text) => commands.push(text));
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(commands).toEqual(["hello world"]);
    expect(typed).toEqual([]);
  });

  test('the "focused-app" target refuses to construct without an injector', () => {
    expect(() => new DictationListener({
      stt: { transcribe: async () => "" },
      recorder: fakeRecorder(),
      target: "focused-app",
    } as never)).toThrow(/requires a typeText injector/);
  });

  test("a forgotten dictation is stopped at its ceiling and still transcribes", async () => {
    const { dict, recorder, typed } = listener({ maxRecordingMs: 20 });
    await dict.start();
    await dict.toggle();
    expect(dict.getState()).toBe("recording");

    await Bun.sleep(60);
    expect(recorder.kills).toBe(1);
    expect(typed).toEqual(["hello world"]);
    expect(dict.getState()).toBe("idle");
  });

  // Shutdown must not start new work, and must not leave the recorder running.
  test("stop() during a recording kills the recorder, discards the file, and does not transcribe", async () => {
    let transcribed = 0;
    const { dict, recorder, typed } = listener({
      stt: { transcribe: async () => { transcribed += 1; return "should not happen"; } },
    });
    await dict.start();
    await dict.toggle();
    const file = recorder.started[0]!;

    await dict.stop();
    expect(recorder.kills).toBe(1);
    expect(transcribed).toBe(0);
    expect(typed).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(dict.getState()).toBe("idle");

    // And a hotkey press after shutdown does nothing.
    await dict.toggle();
    expect(recorder.started.length).toBe(1);
  });

  test("stop() with no capture in flight is a no-op", async () => {
    const { dict } = listener();
    await dict.start();
    await dict.stop();
    expect(dict.getState()).toBe("idle");
  });

  test("the ceiling timer is cleared by a normal stop, so it cannot fire later", async () => {
    const { dict, recorder } = listener({ maxRecordingMs: 40 });
    await dict.start();
    await dict.toggle();
    await dict.toggle(); // normal finish well before the ceiling
    expect(recorder.kills).toBe(1);

    await Bun.sleep(80); // the ceiling instant passes
    expect(recorder.kills).toBe(1); // it did not fire a second kill
    expect(recorder.started.length).toBe(1);
  });
});

// A transcript that already reached transcription is owned work. Shutdown must
// drain it rather than letting its typing land after the daemon reports stopped.
test("stop() during transcription drains the in-flight capture before returning", async () => {
  let releaseStt!: () => void;
  const gate = new Promise<void>((r) => { releaseStt = r; });
  const { dict, typed } = listener({
    stt: { transcribe: async () => { await gate; return "landed before shutdown"; } },
  });
  await dict.start();
  await dict.toggle();
  const finishing = dict.toggle(); // enters transcribing, parked on the gate

  let stopped = false;
  const stopping = dict.stop().then(() => { stopped = true; });
  await Bun.sleep(5);
  expect(stopped).toBe(false); // stop() is waiting on the owned transcription

  releaseStt();
  await stopping;
  await finishing;
  expect(stopped).toBe(true);
  expect(typed).toEqual(["landed before shutdown"]);
});

// ...but a wedged provider must not hold the daemon open forever.
test("a transcription that never finishes is abandoned at the shutdown drain bound", async () => {
  const { dict, typed } = listener({
    stt: { transcribe: () => new Promise<string>(() => { /* never settles */ }) },
    drainTimeoutMs: 20,
  });
  await dict.start();
  await dict.toggle();
  void dict.toggle();
  await Bun.sleep(5);

  const started = Date.now();
  await dict.stop();
  expect(Date.now() - started).toBeLessThan(500);
  expect(typed).toEqual([]);
});

// Codex caught this: production wired no command callback, so the "cicero"
// target completed the whole capture→STT path and then dropped the transcript.
test("a cicero-target listener with no command handler warns instead of pretending it delivered", async () => {
  const { dict } = listener({ target: "cicero" });
  await dict.start();
  await dict.toggle();
  await dict.toggle();
  // Nothing to assert but the absence of a throw and a clean return to idle;
  // the daemon-side wiring is what makes this path actually deliver.
  expect(dict.getState()).toBe("idle");
});

// A recorder that ignores its kill must not wedge the toggle or shutdown.
test("a recorder that never exits is abandoned at the bound rather than hanging", async () => {
  const stubborn = {
    started: [] as string[],
    record(outPath: string) {
      stubborn.started.push(outPath);
      return {
        exited: new Promise<number>(() => { /* never exits */ }),
        kill: () => { /* ignores it */ },
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
  };
  const { dict } = listener({ recorder: stubborn as never, recorderExitTimeoutMs: 20 });
  await dict.start();
  await dict.toggle();

  const started = Date.now();
  await dict.toggle();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(dict.getState()).toBe("idle");
});

// Regression: the in-flight latch used to be compared against the un-chained
// promise, so it never cleared — stop() kept awaiting a long-settled task and
// the "nothing in flight" path was unreachable.
test("the in-flight latch clears between captures", async () => {
  const { dict, typed } = listener();
  await dict.start();

  await dict.toggle();
  await dict.toggle();
  expect(typed).toEqual(["hello world"]);

  // A second full cycle must behave identically to the first.
  await dict.toggle();
  await dict.toggle();
  expect(typed).toEqual(["hello world", "hello world"]);

  // And a stop with nothing in flight returns promptly.
  const started = Date.now();
  await dict.stop();
  expect(Date.now() - started).toBeLessThan(200);
});

// Finding 1 (Codex): dictation called the recorder directly while clap detection
// held a raw `rec` process. On an exclusive capture device that is two owners of
// one stream, so the capture now goes through an explicit microphone handoff.
describe("microphone ownership", () => {
  test("the microphone is taken before the recorder spawns and handed back after", async () => {
    const events: string[] = [];
    const { dict, recorder } = listener({
      acquireMicrophone: async () => { events.push("acquire"); },
      releaseMicrophone: async () => { events.push("release"); },
    });
    const spawned = recorder.record.bind(recorder);
    (recorder as { record: unknown }).record = (path: string, opts: unknown) => {
      events.push("record");
      return spawned(path, opts as never);
    };

    await dict.start();
    await dict.toggle();
    expect(events).toEqual(["acquire", "record"]);

    await dict.toggle();
    // Released once the recorder is confirmed stopped — not left held across the
    // transcription, which needs no microphone.
    expect(events).toEqual(["acquire", "record", "release"]);
  });

  test("a refused handoff aborts the capture instead of competing for the device", async () => {
    const { dict, recorder } = listener({
      acquireMicrophone: async () => { throw new Error("voice mode is holding the microphone"); },
    });
    await dict.start();
    await dict.toggle();

    expect(recorder.started.length).toBe(0);
    expect(dict.getState()).toBe("idle");
  });

  test("a capture that never spawns still hands the microphone back", async () => {
    const events: string[] = [];
    const exploding = { record: () => { throw new Error("rec is not installed"); } };
    const { dict } = listener({
      recorder: exploding as never,
      acquireMicrophone: async () => { events.push("acquire"); },
      releaseMicrophone: async () => { events.push("release"); },
    });
    await dict.start();
    await dict.toggle();
    expect(events).toEqual(["acquire", "release"]);
    expect(dict.getState()).toBe("idle");
  });
});

// Finding 2 (Codex): the recorders append the SoX `silence` effect by default, so
// a dictation was cut at the first pause longer than 1.5s and every word after it
// was lost. Dictation must opt out.
test("the dictation capture disables silence-based auto-stop", async () => {
  let opts: unknown;
  const capturing = {
    started: [] as string[],
    record(outPath: string, options: unknown) {
      capturing.started.push(outPath);
      opts = options;
      return {
        exited: Promise.resolve(0),
        kill: () => { void Bun.write(outPath, "RIFFfake"); },
      } as unknown as ReturnType<typeof Bun.spawn>;
    },
  };
  const { dict } = listener({ recorder: capturing as never });
  await dict.start();
  await dict.toggle();
  expect(opts).toMatchObject({ stopOnSilence: false });
});

// Finding 4 (Codex): stop() gave up on a wedged transcription but nothing stopped
// it from delivering when it eventually settled — typing into whatever the
// operator was doing minutes later, or dispatching a command to a dead daemon.
test("a transcription abandoned at the drain does not type when it finally settles", async () => {
  let releaseStt!: (text: string) => void;
  const { dict, typed } = listener({
    stt: { transcribe: () => new Promise<string>((resolve) => { releaseStt = resolve; }) },
    drainTimeoutMs: 20,
  });
  await dict.start();
  await dict.toggle();
  const finishing = dict.toggle();
  await Bun.sleep(5);

  await dict.stop(); // gives up on the transcription at the 20ms bound
  expect(typed).toEqual([]);

  // The provider comes back long after shutdown reported done.
  releaseStt("late text");
  await finishing;
  expect(typed).toEqual([]);
});

test("the same abandonment applies to the cicero target's command dispatch", async () => {
  let releaseStt!: (text: string) => void;
  const commands: string[] = [];
  const { dict } = listener({
    target: "cicero",
    stt: { transcribe: () => new Promise<string>((resolve) => { releaseStt = resolve; }) },
    drainTimeoutMs: 20,
  });
  dict.onCommand((text) => commands.push(text));
  await dict.start();
  await dict.toggle();
  const finishing = dict.toggle();
  await Bun.sleep(5);

  await dict.stop();
  releaseStt("late command");
  await finishing;
  expect(commands).toEqual([]);
});

// Finding 5 (Codex): a recorder that ignored its kill was forgotten and the
// listener returned to idle, so the very next press started a second recorder
// while the first was still holding the microphone.
describe("a recorder that will not exit", () => {
  function stubbornRecorder() {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const state = {
      started: [] as string[],
      release: () => exit(0),
      record(outPath: string) {
        state.started.push(outPath);
        return { exited, kill: () => { /* ignores it */ } } as unknown as ReturnType<typeof Bun.spawn>;
      },
    };
    return state;
  }

  test("no second capture is admitted while it is still alive", async () => {
    const stubborn = stubbornRecorder();
    const { dict, typed } = listener({ recorder: stubborn as never, recorderExitTimeoutMs: 20 });
    await dict.start();
    await dict.toggle();
    await dict.toggle(); // release is unconfirmed

    expect(dict.getState()).toBe("idle");
    expect(typed).toEqual([]); // a partial file is not transcribed
    await dict.toggle();
    expect(stubborn.started.length).toBe(1); // refused, not stacked on the live one
  });

  test("dictation recovers on its own once the recorder finally exits", async () => {
    const stubborn = stubbornRecorder();
    const { dict } = listener({ recorder: stubborn as never, recorderExitTimeoutMs: 20 });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    expect(stubborn.started.length).toBe(1);

    stubborn.release(); // the process goes away
    await dict.toggle();
    expect(stubborn.started.length).toBe(2); // no daemon restart needed
  });

  test("the microphone is not handed back while the recorder still holds it", async () => {
    const stubborn = stubbornRecorder();
    const events: string[] = [];
    const { dict } = listener({
      recorder: stubborn as never,
      recorderExitTimeoutMs: 20,
      acquireMicrophone: async () => { events.push("acquire"); },
      releaseMicrophone: async () => { events.push("release"); },
    });
    await dict.start();
    await dict.toggle();
    await dict.toggle();
    // Telling the daemon the device is free would let clap re-arm on top of the
    // recorder that is still running.
    expect(events).toEqual(["acquire"]);

    stubborn.release();
    await dict.toggle(); // the reap succeeds, and only now is it handed back
    expect(events).toEqual(["acquire", "release", "acquire"]);
  });
});
