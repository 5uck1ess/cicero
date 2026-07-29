import { afterEach, describe, expect, test } from "bun:test";
import { createTextInjector, TextInjectionUnavailableError } from "../../src/platform/text-inject-run";
import type { TextInjectionSpec } from "../../src/platform/text-inject";

const savedSessionType = process.env.XDG_SESSION_TYPE;
const savedWaylandDisplay = process.env.WAYLAND_DISPLAY;
afterEach(() => {
  restore("XDG_SESSION_TYPE", savedSessionType);
  restore("WAYLAND_DISPLAY", savedWaylandDisplay);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A helper process whose exit the test controls, like a real xdotool/osascript. */
function fakeHelper() {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const proc = {
    exited,
    stderr: null,
    kills: 0,
    kill(): void { proc.kills += 1; },
  };
  return { proc, finish: (code = 0) => exit(code) };
}

// Codex: production called the resolver with only `hasBinary`, so the Wayland
// branch was unreachable outside tests. On a Wayland session dictation reported
// xdotool as supported — it reaches XWayland clients only, so typing would have
// worked in some windows and silently done nothing in others.
describe("session detection in production shape", () => {
  test("a Wayland session is refused when nothing is passed explicitly", () => {
    process.env.XDG_SESSION_TYPE = "wayland";
    delete process.env.WAYLAND_DISPLAY;
    expect(() => createTextInjector({ platform: "linux", hasBinary: () => true }))
      .toThrow(TextInjectionUnavailableError);
  });

  test("WAYLAND_DISPLAY alone is enough — a session type of x11 does not override it", () => {
    process.env.XDG_SESSION_TYPE = "x11";
    process.env.WAYLAND_DISPLAY = "wayland-0";
    expect(() => createTextInjector({ platform: "linux", hasBinary: () => true }))
      .toThrow(/Wayland blocks synthetic keyboard input/);
  });

  test("an X11 session still resolves to xdotool", () => {
    process.env.XDG_SESSION_TYPE = "x11";
    delete process.env.WAYLAND_DISPLAY;
    expect(() => createTextInjector({ platform: "linux", hasBinary: () => true })).not.toThrow();
  });

  test("an explicit environment still wins over the process environment", () => {
    process.env.XDG_SESSION_TYPE = "wayland";
    expect(() => createTextInjector({ platform: "linux", sessionType: "x11", hasBinary: () => true }))
      .not.toThrow();
  });
});

// Codex: the timeout killed the helper but never confirmed it died, so a helper
// that ignored termination stayed alive typing into the focused field — and the
// next dictation spawned a second one on top of it.
describe("a typing helper that ignores its kill", () => {
  test("the failure says the helper is still alive, and it is not forgotten", async () => {
    const helpers: ReturnType<typeof fakeHelper>[] = [];
    const spawn = (_spec: TextInjectionSpec) => {
      const helper = fakeHelper();
      helpers.push(helper);
      return helper.proc as unknown as ReturnType<typeof Bun.spawn>;
    };
    const type = createTextInjector(
      { platform: "linux", sessionType: "x11", hasBinary: () => true },
      spawn,
      { injectMs: 20, reapMs: 20 },
    );

    await expect(type("hello")).rejects.toThrow(/did not exit when killed/);
    expect(helpers.length).toBe(1);
    expect(helpers[0]!.proc.kills).toBe(1);

    // The second press must not put a competing keyboard on the same field.
    await expect(type("world")).rejects.toThrow(/has not exited; refusing to type over it/);
    expect(helpers.length).toBe(1);

    // Retryable, not latched: once it goes away, dictation types again.
    helpers[0]!.finish(0);
    const third = type("third");
    await Bun.sleep(0);
    helpers[1]?.finish(0);
    await third;
    expect(helpers.length).toBe(2);
  }, 15_000);

  test("a helper that exits on its kill is not retained", async () => {
    const helpers: ReturnType<typeof fakeHelper>[] = [];
    const spawn = (_spec: TextInjectionSpec) => {
      const helper = fakeHelper();
      helpers.push(helper);
      // Honours termination, just too late for the deadline.
      setTimeout(() => helper.finish(0), 90);
      return helper.proc as unknown as ReturnType<typeof Bun.spawn>;
    };
    const type = createTextInjector(
      { platform: "linux", sessionType: "x11", hasBinary: () => true },
      spawn,
      { injectMs: 1, reapMs: 500 },
    );

    // The plain overrun message, with no "did not exit when killed" — that
    // distinction is what says nothing was retained.
    await expect(type("hello")).rejects.toThrow(/did not finish typing within \d+ms$/);
    // Nothing retained: the next injection actually spawns rather than being
    // refused, which is what distinguishes this from the case above.
    await expect(type("world")).rejects.not.toThrow(/refusing to type over it/);
    expect(helpers.length).toBe(2);
  }, 15_000);
});

// Round 2, finding 4 (Codex): the retained helper lived only in the closure, so
// the listener — its only owner — could not reach it at shutdown and the daemon
// dropped the last reference to a process that was still typing.
describe("releasing a retained helper at shutdown", () => {
  test("stop() reaps it, and reports when it still will not go", async () => {
    const helpers: ReturnType<typeof fakeHelper>[] = [];
    const spawn = (_spec: TextInjectionSpec) => {
      const helper = fakeHelper();
      helpers.push(helper);
      return helper.proc as unknown as ReturnType<typeof Bun.spawn>;
    };
    const type = createTextInjector(
      { platform: "linux", sessionType: "x11", hasBinary: () => true },
      spawn,
      { injectMs: 20, reapMs: 20 },
    );
    await expect(type("hello")).rejects.toThrow(/did not exit when killed/);

    // Still ignoring termination: an unconfirmed release must be reported, not
    // swallowed, so the caller keeps the listener alive and retries.
    await expect(type.stop()).rejects.toThrow(/has not exited/);
    expect(helpers[0]!.proc.kills).toBe(2); // killed again on the way out

    helpers[0]!.finish(0);
    await type.stop(); // now confirmed, and idempotent
    await type.stop();
  }, 15_000);

  // Round 3, finding 1 (Codex): only a helper retained after a refused kill was
  // reachable. A helper that is actively typing lived solely inside
  // runInjection(), so a shutdown mid-injection killed nothing and reported a
  // clean release while xdotool went on typing into the focused field.
  test("stop() kills a helper that is still typing", async () => {
    const helpers: ReturnType<typeof fakeHelper>[] = [];
    const spawn = (_spec: TextInjectionSpec) => {
      const helper = fakeHelper();
      helpers.push(helper);
      return helper.proc as unknown as ReturnType<typeof Bun.spawn>;
    };
    const type = createTextInjector(
      { platform: "linux", sessionType: "x11", hasBinary: () => true },
      spawn,
      // Generous: this helper is well inside its deadline, i.e. healthily typing.
      { injectMs: 10_000, reapMs: 500 },
    );

    const typing = type("a long transcript still being typed");
    await Bun.sleep(0);
    expect(helpers.length).toBe(1);

    const stopping = type.stop();
    await Bun.sleep(0);
    expect(helpers[0]!.proc.kills).toBe(1);

    // The helper honours the kill, as a real xdotool does.
    helpers[0]!.finish(143);
    await stopping;
    // The injection itself fails — it was killed — and that failure surfaces to
    // the dictation drain rather than being swallowed.
    await expect(typing).rejects.toThrow(/exited with 143/);

    // Nothing is left held afterwards: the next injection spawns rather than
    // being refused as typing-over.
    const next = type("after");
    await Bun.sleep(0);
    helpers[1]!.finish(0);
    await next;
    expect(helpers.length).toBe(2);
  }, 15_000);

  test("stop() with nothing retained is a no-op", async () => {
    const type = createTextInjector(
      { platform: "linux", sessionType: "x11", hasBinary: () => true },
      () => { throw new Error("must not spawn"); },
    );
    await type.stop();
  });
});

// Round 2, finding 6 (Codex): a fixed 30s deadline against a 10,000-character
// cap at 12ms per character meant any transcript over ~2,500 characters was
// predictably killed partway through a sentence and reported as a wedged helper.
test("the deadline scales with how long xdotool will actually take", async () => {
  const specs: TextInjectionSpec[] = [];
  let finish!: (code: number) => void;
  const spawn = (spec: TextInjectionSpec) => {
    specs.push(spec);
    const helper = fakeHelper();
    finish = helper.finish;
    return helper.proc as unknown as ReturnType<typeof Bun.spawn>;
  };
  // A base of 40ms would kill a 3,000-character run instantly on the old fixed
  // bound; the allowance (3,000 x 12ms) is what keeps it alive.
  const type = createTextInjector(
    { platform: "linux", sessionType: "x11", hasBinary: () => true },
    spawn,
    { injectMs: 40, reapMs: 20 },
  );

  const long = "a".repeat(3_000);
  const typing = type(long);
  await Bun.sleep(120); // well past the base bound alone
  finish(0);
  await typing; // not killed mid-sentence
  expect(specs[0]!.stdin.length).toBe(3_000);
  expect(specs[0]!.command).toContain("--delay");
  expect(specs[0]!.command[specs[0]!.command.indexOf("--delay") + 1]).toBe("12");
}, 15_000);
