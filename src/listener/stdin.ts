import type { Listener } from "../types";
import { createInterface } from "readline";

export class StdinListener implements Listener {
  private callback?: (text: string) => void;
  private rl?: ReturnType<typeof createInterface>;

  async start(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "cicero> ",
    });
    this.rl.prompt();
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed && this.callback) {
        this.callback(trimmed);
      }
      this.rl?.prompt();
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  onCommand(callback: (text: string) => void): void {
    this.callback = callback;
  }
}
