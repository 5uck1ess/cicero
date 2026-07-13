import { SubprocessCLIBrain } from "./subprocess-cli";

/**
 * Qwen CLI brain (Alibaba). Reads the prompt from stdin in non-interactive
 * mode. `binary` can be overridden (e.g. "qwen-coder").
 */
export class QwenBrain extends SubprocessCLIBrain {
  constructor(binary = "qwen", extraArgs: string[] = []) {
    super({
      name: "Qwen CLI",
      binary,
      args: extraArgs,
      promptViaStdin: true,
    });
  }
}
