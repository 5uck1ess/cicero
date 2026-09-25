import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { AudioCppSTTProvider } from "../src/backends/stt/audiocpp";
import { FasterWhisperProvider } from "../src/backends/stt/faster-whisper";
import { MlxWhisperProvider } from "../src/backends/stt/mlx-whisper";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("STT hint config accepts bounded terms and rejects overlong input", () => {
  const home = mkdtempSync(join(tmpdir(), "cicero-stt-hints-"));
  try {
    const read = (yaml: string) => {
      writeFileSync(join(home, "config.yaml"), `stt:\n  backend: faster-whisper\n${yaml}`);
      return loadConfig({}, { home });
    };
    expect(read("  language: en-US\n  vocabulary: [Cicero, TypeGPU]\n").sttBackend)
      .toMatchObject({ language: "en-US", vocabulary: ["Cicero", "TypeGPU"] });
    expect(read("  language: yue-Hant-HK\n").sttBackend.language).toBe("yue-Hant-HK");
    for (const yaml of [
      "  vocabulary: [\"\"]\n",
      `  vocabulary: ["${"x".repeat(65)}"]\n`,
      `  vocabulary: [${Array.from({ length: 101 }, () => "x").join(", ")}]\n`,
      `  vocabulary: [${Array.from({ length: 9 }, () => `"${"é".repeat(64)}"`).join(", ")}]\n`,
    ]) expect(() => read(yaml)).toThrow(/stt\.vocabulary/);
    expect(() => read("  language: \"\"\n")).toThrow(/stt\.language/);
    for (const bad of ["en--US", "abcd-US", "en-ABCDE", "en-US-Hant", "en_ US", "en-Latn-US-extra"]) {
      expect(() => read(`  language: ${bad}\n`)).toThrow(/stt\.language/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("HTTP STT providers send supported language and vocabulary fields", async () => {
  const forms: FormData[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    forms.push(init.body as FormData);
    return Response.json({ text: "hello world" });
  }) as typeof fetch;
  const home = mkdtempSync(join(tmpdir(), "cicero-stt-hints-audio-"));
  const wav = join(home, "audio.wav");
  try {
    await Bun.write(wav, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    const config = { language: "en-US", vocabulary: ["Cicero", "TypeGPU"] };
    await new AudioCppSTTProvider(config).transcribe(wav);
    await new FasterWhisperProvider(config).transcribe(wav);
    await new MlxWhisperProvider(config).transcribe(wav);
    expect(forms.map((form) => form.get("language"))).toEqual(["en-US", "en", "en"]);
    for (const form of forms) {
      expect(form.get("prompt")).toContain("Cicero");
      expect(form.get("prompt")).toContain("TypeGPU");
    }
    forms.length = 0;
    const portuguese = { language: "PT-br" };
    await new FasterWhisperProvider(portuguese).transcribe(wav);
    await new MlxWhisperProvider(portuguese).transcribe(wav);
    expect(forms.map((form) => form.get("language"))).toEqual(["pt", "pt"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
