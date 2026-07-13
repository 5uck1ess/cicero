import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, updateConfigFields } from "../src/config";

const mode = (file: string): number => statSync(file).mode & 0o777;

describe("updateConfigFields", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cicero-cfg-"));
    path = join(dir, "config.yaml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes fields to a fresh config file", async () => {
    updateConfigFields({ voice: "jarvis", voice_ref_audio: "/v/jarvis.wav" }, path);
    expect(existsSync(path)).toBe(true);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.voice).toBe("jarvis");
    expect(parsed.voice_ref_audio).toBe("/v/jarvis.wav");
  });

  test("merges into existing config without clobbering other keys", async () => {
    updateConfigFields({ voice: "jarvis", tts_enabled: true }, path);
    updateConfigFields({ voice: "athena" }, path);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.voice).toBe("athena"); // overwritten
    expect(parsed.tts_enabled).toBe(true); // preserved
  });

  test("deep-merges nested tts object", async () => {
    updateConfigFields({ tts: { backend: "vibevoice", voice: "Ryan" } }, path);
    updateConfigFields({ tts: { backend: "elevenlabs" } }, path);
    const parsed = parseYaml(await Bun.file(path).text());
    expect(parsed.tts.backend).toBe("elevenlabs"); // overwritten
    expect(parsed.tts.voice).toBe("Ryan"); // preserved by deep merge
  });

  test("can replace provider-owned top-level fields without retaining stale nested values", () => {
    writeFileSync(path, [
      "voice_ref_audio: /stale.wav",
      "voice_ref_text: stale transcript",
      "tts:",
      "  backend: audiocpp",
      "  port: 8092",
      "  model: pocket-tts",
      "  refAudio: /stale.wav",
      "brain:",
      "  backend: acp",
      "",
    ].join("\n"));

    updateConfigFields(
      { tts: { backend: "elevenlabs", voice: "cloud-id" } },
      path,
      { replaceTopLevel: ["tts", "voice_ref_audio", "voice_ref_text"] },
    );

    expect(parseYaml(readFileSync(path, "utf-8"))).toEqual({
      tts: { backend: "elevenlabs", voice: "cloud-id" },
      brain: { backend: "acp" },
    });
  });

  test("updates empty and comment-only config documents", () => {
    for (const original of ["", "# keep this note\n"]) {
      writeFileSync(path, original);

      updateConfigFields({ voice: "athena" }, path);

      expect(parseYaml(readFileSync(path, "utf-8"))).toEqual({ voice: "athena" });
    }
  });

  test("refuses malformed YAML without changing a byte or leaving a temp file", () => {
    const original = Buffer.from("voice: old\nbrain: [unterminated\n# keep this recovery note\n");
    writeFileSync(path, original);

    expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(
      /Refusing to update .*existing file is not valid mapping YAML.*Fix it manually or move it aside.*original file was not changed/,
    );

    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("refuses non-mapping YAML without rewriting the original document", () => {
    for (const original of ["null\n", "- voice\n- old\n", "plain scalar\n"]) {
      writeFileSync(path, original);
      expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(/document root must be a mapping/);
      expect(readFileSync(path, "utf-8")).toBe(original);
    }
  });

  test.skipIf(process.platform === "win32")("writes private modes and tightens an existing config", () => {
    chmodSync(dir, 0o755);
    writeFileSync(path, "voice: old\n", { mode: 0o644 });

    updateConfigFields({ voice: "athena" }, path);

    expect(mode(dir)).toBe(0o700);
    expect(mode(path)).toBe(0o600);

    const freshPath = join(dir, "fresh.yaml");
    updateConfigFields({ voice: "new" }, freshPath);
    expect(mode(freshPath)).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("loading tightens an existing config without changing its data", () => {
    chmodSync(dir, 0o755);
    writeFileSync(path, "voice: jarvis\n", { mode: 0o644 });

    expect(loadConfig({}, { home: dir }).raw.voice).toBe("jarvis");
    expect(mode(path)).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("refuses to read or overwrite a config symlink", () => {
    const target = join(dir, "outside.yaml");
    writeFileSync(target, "voice: untouched\n");
    symlinkSync(target, path, "file");

    expect(() => loadConfig({}, { home: dir })).toThrow(/unsafe private file/);
    expect(() => updateConfigFields({ voice: "changed" }, path)).toThrow(/unsafe private file/);
    expect(readFileSync(target, "utf-8")).toBe("voice: untouched\n");
  });
});
