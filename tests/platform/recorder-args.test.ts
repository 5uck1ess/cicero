import { describe, expect, test } from "bun:test";
import { soxRecordArgs } from "../../src/platform/recorder-sox";
import { windowsRecordArgs } from "../../src/platform/recorder-windows";

// Codex: both recorders appended the SoX `silence` effect unconditionally, and
// dictation only passed `maxDuration`. A dictation that paused for longer than
// the 1.5s default ended right there, and every word spoken after the pause was
// silently lost. Asserted on both platforms — a capture contract that holds only
// where the feature was developed is not a contract.
for (const [platform, build] of [["posix", soxRecordArgs], ["windows", windowsRecordArgs]] as const) {
  describe(`${platform} record arguments`, () => {
    test("a conversational capture keeps silence-based auto-stop", () => {
      const args = build("/tmp/turn.wav", {});
      expect(args).toContain("silence");
      // The effect's stop half: 1.5s under the threshold ends the turn.
      expect(args.join(" ")).toContain("1 1.5 3%");
    });

    test("a dictation capture carries no silence effect at all", () => {
      const args = build("/tmp/dictation.wav", { stopOnSilence: false, maxDuration: 300 });
      expect(args).not.toContain("silence");
      // Widening the pause window would not be enough — a long pause is normal
      // dictation, and the leading half would also clip the first word.
      expect(args.join(" ")).not.toContain("3%");
      // The ceiling still applies, so a forgotten session cannot record forever.
      expect(args.slice(-3)).toEqual(["trim", "0", "300"]);
    });

    test("the file path and ceiling survive either way", () => {
      expect(build("/tmp/a.wav", { maxDuration: 42 })).toContain("/tmp/a.wav");
      expect(build("/tmp/a.wav", { maxDuration: 42 }).slice(-3)).toEqual(["trim", "0", "42"]);
    });
  });
}
