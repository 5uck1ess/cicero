import type { Command } from "commander";
import { join } from "node:path";
import { VoiceLibrary } from "../voice/library";
import { provisionVoice } from "../voice/provision";
import {
  VOICE_CONFIG_CLEAR_NESTED,
  VOICE_CONFIG_PRESERVE_WHEN_SAME,
  VOICE_CONFIG_REPLACE_KEYS,
  voiceToConfigFields,
} from "../voice/resolve";
import { ensureConfigDir, updateConfigFields } from "../config";
import { ciceroPath } from "../platform/paths";
import { SUPPORTED_VOICE_PROVIDERS, isSupportedVoiceProvider } from "../voice/provider-contract";

const VOICES_DIR = ciceroPath("voices");

function openVoiceLibrary(): VoiceLibrary {
  ensureConfigDir();
  return new VoiceLibrary(VOICES_DIR);
}

/** Register the `cicero voice {add,list,use,remove,inspect}` command group. */
export function registerVoiceCommand(program: Command): void {
  const voice = program.command("voice").description("Manage cloned voices");

  voice
    .command("add <name> <clip>")
    .description("Add a voice from a clean reference clip")
    .option("--provider <provider>", `voice provider: ${SUPPORTED_VOICE_PROVIDERS.join(", ")}`, "audiocpp")
    .option("--ref-text <text>", "Store transcript metadata for engines that support it")
    .action(async (name: string, clip: string, opts: { provider: string; refText?: string }) => {
      try {
        if (!isSupportedVoiceProvider(opts.provider)) {
          throw new Error(`unknown provider '${opts.provider}' (valid: ${SUPPORTED_VOICE_PROVIDERS.join(", ")})`);
        }
        const lib = openVoiceLibrary();
        if (await lib.get(name)) {
          throw new Error(`voice '${name}' already exists — remove it first or pick another name`);
        }
        const targetDir = lib.prepareVoiceDir(name);
        const manifest = await provisionVoice({
          name,
          provider: opts.provider,
          source_clip: clip,
          targetDir,
          ref_text: opts.refText,
        });
        await lib.add(manifest);
        console.log(`Added voice '${name}' (${opts.provider}). Activate with: cicero voice use ${name}`);
      } catch (err) {
        console.error(`[cicero] voice add failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  voice
    .command("list")
    .description("List voices in your library")
    .action(async () => {
      const lib = openVoiceLibrary();
      const voices = await lib.list();
      if (voices.length === 0) {
        console.log("(no voices yet — add one with: cicero voice add <name> <clip.wav>)");
        return;
      }
      for (const v of voices) {
        const idStr = v.voice_id ? ` voice_id=${v.voice_id}` : "";
        console.log(
          `  ${v.name.padEnd(20)} ${v.provider.padEnd(12)} ${v.duration_s?.toFixed(1) ?? "?"}s${idStr}`,
        );
      }
    });

  voice
    .command("use <name>")
    .description("Set the active voice")
    .action(async (name: string) => {
      try {
        const lib = openVoiceLibrary();
        const manifest = await lib.get(name);
        if (!manifest) {
          throw new Error(`voice '${name}' not found — list voices with: cicero voice list`);
        }
        updateConfigFields(voiceToConfigFields(manifest), undefined, {
          replaceTopLevel: VOICE_CONFIG_REPLACE_KEYS,
          preserveTopLevelWhenSame: VOICE_CONFIG_PRESERVE_WHEN_SAME,
          clearNested: VOICE_CONFIG_CLEAR_NESTED,
        });
        console.log(`Active voice → ${name}`);
      } catch (err) {
        console.error(`[cicero] voice use failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  voice
    .command("remove <name>")
    .description("Delete a voice and its clips")
    .action(async (name: string) => {
      try {
        const lib = openVoiceLibrary();
        await lib.remove(name);
        console.log(`Removed voice '${name}'`);
      } catch (err) {
        console.error(`[cicero] voice remove failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  voice
    .command("inspect <name>")
    .description("Show a voice's manifest")
    .action(async (name: string) => {
      const lib = openVoiceLibrary();
      const m = await lib.get(name);
      if (!m) {
        console.error(`[cicero] voice '${name}' not found`);
        process.exit(1);
      }
      console.log(JSON.stringify(m, null, 2));
    });
}
