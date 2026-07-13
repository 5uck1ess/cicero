import { SubprocessCLIBrain } from "./subprocess-cli";

/**
 * Gemini CLI brain. gemini-cli reads the prompt from stdin in non-interactive
 * mode, avoiding argv length/quoting issues. Extra flags (e.g. --model) can be
 * passed through.
 */
export class GeminiBrain extends SubprocessCLIBrain {
  constructor(binary = "gemini", extraArgs: string[] = []) {
    super({
      name: "Gemini CLI",
      binary,
      args: extraArgs,
      promptViaStdin: true,
    });
  }
}
