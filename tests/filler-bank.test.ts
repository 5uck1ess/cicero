import { test, expect } from "bun:test";
import { FillerBank, type FillerBankLimits } from "../src/speaker/filler-bank";
import { encodeWav } from "../src/platform/wav";

const tinyWav = () => encodeWav(new Int16Array([1])).buffer as ArrayBuffer;
const onlyDefault = (lines: readonly string[]) => ({
  default: lines,
  connect: [],
  task: [],
  lookup: [],
  question: [],
});

function generousLimits(overrides: Partial<FillerBankLimits> = {}): FillerBankLimits {
  return {
    maxClips: 100,
    maxBytes: 1024 * 1024,
    maxFrames: 1_000_000,
    maxDurationMs: 60_000,
    ...overrides,
  };
}

test("prime synthesizes each phrase once and reports how many are ready", async () => {
  const synth: string[] = [];
  const bank = new FillerBank({ generateAudio: async (t) => { synth.push(t); return tinyWav(); } }, { default: ["A", "B", "C"], connect: [], task: [], lookup: [], question: [] });
  expect(bank.ready).toBe(false);
  const n = await bank.prime();
  expect(n).toBe(3);
  expect(synth).toEqual(["A", "B", "C"]);
  expect(bank.ready).toBe(true);
});

test("pick returns a prepared clip and never repeats back-to-back", async () => {
  const bank = new FillerBank({ generateAudio: async () => tinyWav() }, { default: ["A", "B"], connect: [], task: [], lookup: [], question: [] });
  await bank.prime();
  let last = "";
  for (let i = 0; i < 10; i++) {
    const f = bank.pick()!;
    expect(f.audio.byteLength).toBe(tinyWav().byteLength);
    expect(f.text === last).toBe(false); // never the same line twice in a row
    last = f.text;
  }
});

test("pick returns undefined before priming (turn during startup)", () => {
  const bank = new FillerBank({ generateAudio: async () => tinyWav() }, { default: ["A"], connect: [], task: [], lookup: [], question: [] });
  expect(bank.pick()).toBeUndefined();
});

test("prime skips phrases that throw or return empty audio", async () => {
  const bank = new FillerBank(
    {
      generateAudio: async (t) => {
        if (t === "bad") throw new Error("boom");
        if (t === "empty") return new ArrayBuffer(0);
        if (t === "malformed") return new ArrayBuffer(8);
        return tinyWav();
      },
    },
    { default: ["ok1", "bad", "empty", "malformed", "ok2"], connect: [], task: [], lookup: [], question: [] },
  );
  const n = await bank.prime();
  expect(n).toBe(2); // only ok1 + ok2 survive
  expect(bank.ready).toBe(true);
});

test("the aggregate filler budget admits exact boundaries and rejects the next clip", async () => {
  const clip = tinyWav();
  const frameDurationMs = 1_000 / 16_000;
  const exact = new FillerBank(
    okTts(),
    onlyDefault(["A", "B"]),
    {
      maxClips: 2,
      maxBytes: clip.byteLength * 2,
      maxFrames: 2,
      maxDurationMs: frameDurationMs * 2,
    },
  );
  expect(await exact.prime()).toBe(2);

  const overCases: Array<Partial<FillerBankLimits>> = [
    { maxClips: 1 },
    { maxBytes: clip.byteLength * 2 - 1 },
    { maxFrames: 1 },
    { maxDurationMs: frameDurationMs * 2 - 0.001 },
  ];
  for (const limit of overCases) {
    const bank = new FillerBank(okTts(), onlyDefault(["A", "B"]), generousLimits(limit));
    expect(await bank.prime()).toBe(1);
  }
});

test("replacement and per-voice priming share one transactional budget", async () => {
  const bank = new FillerBank(
    okTts(),
    onlyDefault(["A", "B"]),
    generousLimits({ maxClips: 3 }),
  );

  expect(await bank.prime()).toBe(2);
  expect(await bank.prime()).toBe(2); // replacement does not double-count the old bank
  expect(await bank.primeVoice("alice", 1)).toBe(1);
  expect(await bank.primeVoice("alice", 1)).toBe(1); // same-voice replacement is deductible
  expect(await bank.primeVoice("bob", 1)).toBe(0); // the shared bank is now full
  expect(bank.pick(undefined, "alice")?.text).toBe("A");
  expect(bank.pick(undefined, "bob")).toBeUndefined();
});

test("concurrent front-desk and voice priming cannot race past the shared budget", async () => {
  const bank = new FillerBank(
    okTts(),
    onlyDefault(["A", "B"]),
    generousLimits({ maxClips: 2 }),
  );

  const [frontDesk, voice] = await Promise.all([
    bank.prime(),
    bank.primeVoice("alice", 1),
  ]);
  expect([frontDesk, voice]).toEqual([2, 0]);
  expect(bank.pick(undefined, "alice")).toBeUndefined();
});

test("FillerBank owns provider clips and never exposes its accounting buffer", async () => {
  const providerClip = tinyWav();
  const bank = new FillerBank(
    { generateAudio: async () => providerClip },
    onlyDefault(["A"]),
  );
  expect(await bank.prime()).toBe(1);

  new Uint8Array(providerClip)[0] = 0;
  const firstPick = bank.pick()!;
  expect(new Uint8Array(firstPick.audio)[0]).toBe("R".charCodeAt(0));
  new Uint8Array(firstPick.audio)[0] = 0;
  expect(new Uint8Array(bank.pick()!.audio)[0]).toBe("R".charCodeAt(0));
});

test("FillerBank snapshots the first provider result before requesting the second", async () => {
  const first = tinyWav();
  const second = tinyWav();
  let generated = 0;
  const bank = new FillerBank(
    {
      generateAudio: async () => {
        generated += 1;
        if (generated === 1) return first;
        new Uint8Array(first)[0] = 0;
        return second;
      },
    },
    { connect: ["A"], task: ["B"], lookup: [], question: [], default: [] },
  );
  expect(await bank.prime()).toBe(2);
  expect(new Uint8Array(bank.pick("connect me")!.audio)[0]).toBe("R".charCodeAt(0));
});

const fillerSupportsResizableArrayBuffer = typeof (
  ArrayBuffer.prototype as unknown as { resize?: unknown }
).resize === "function";

test.skipIf(!fillerSupportsResizableArrayBuffer)(
  "FillerBank converts resizable provider buffers into fixed retained clips",
  async () => {
    interface ResizableBuffer extends ArrayBuffer { resize(byteLength: number): void }
    const valid = tinyWav();
    const ResizableArrayBuffer = ArrayBuffer as unknown as {
      new(byteLength: number, options: { maxByteLength: number }): ResizableBuffer;
    };
    const providerClip = new ResizableArrayBuffer(valid.byteLength, {
      maxByteLength: valid.byteLength + 64,
    });
    new Uint8Array(providerClip).set(new Uint8Array(valid));
    const bank = new FillerBank(
      { generateAudio: async () => providerClip },
      onlyDefault(["A"]),
    );

    expect(await bank.prime()).toBe(1);
    providerClip.resize(0);
    expect(bank.pick()!.audio.byteLength).toBe(valid.byteLength);
  },
);

function okTts() {
  return { generateAudio: async () => tinyWav() };
}

// ---------- contextual buckets ----------
import { classifyFillerBucket } from "../src/speaker/thinking-filler";

test("filler bucket matches the utterance's intent", () => {
  expect(classifyFillerBucket("Could you patch me through to whoever handles the code?")).toBe("connect");
  expect(classifyFillerBucket("Let me talk to someone about the deploy.")).toBe("connect");
  expect(classifyFillerBucket("Fix the login bug in the parser.")).toBe("task");
  expect(classifyFillerBucket("Please deploy the new build.")).toBe("task");
  expect(classifyFillerBucket("Check the status of the CI run.")).toBe("lookup");
  expect(classifyFillerBucket("Did the tests pass?")).toBe("lookup");
  expect(classifyFillerBucket("Why is the orb blue?")).toBe("question");
  expect(classifyFillerBucket("Tell me a story about databases")).toBe("default");
  expect(classifyFillerBucket(undefined)).toBe("default");
});

test("pick() answers a command with a task acknowledgment", async () => {
  const bank = new FillerBank(okTts());
  await bank.prime();
  for (let i = 0; i < 8; i++) {
    const f = bank.pick("Fix the flaky test.");
    expect(["On it.", "Working on it.", "Right away.", "Getting that going."]).toContain(f!.text);
  }
});

test("config lines override a single bucket, others keep defaults", async () => {
  const bank = new FillerBank(okTts(), { task: ["Right away, sir."] });
  await bank.prime();
  expect(bank.pick("Deploy it.")!.text).toBe("Right away, sir.");
  expect(["Hmm, good question.", "Let me think about that.", "Let me see.", "Hmm, thinking."]).toContain(bank.pick("Why though?")!.text);
});
