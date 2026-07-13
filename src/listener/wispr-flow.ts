import type { Listener } from "../types";
import { log } from "../logger";
import { join, dirname } from "path";

/**
 * WisprFlowListener — Activates Wispr Flow via global hotkey,
 * waits for dictation, and captures the result from the clipboard.
 *
 * Flow:
 * 1. Swift helper (cicero-hotkey) listens for global hotkey (ctrl+shift+space)
 * 2. On hotkey, we save current clipboard, simulate Wispr Flow's activation key
 * 3. User speaks, Wispr Flow transcribes and types the text
 * 4. We poll clipboard for changes (Wispr copies transcription to clipboard)
 *    OR we capture from a focused text field via Accessibility API
 * 5. Pass captured text to the command callback
 */
export class WisprFlowListener implements Listener {
  private callback?: (text: string) => void;
  private hotkeyProc: ReturnType<typeof Bun.spawn> | null = null;
  private running = false;
  private wisprHotkey: string; // AppleScript key code to activate Wispr Flow

  constructor(wisprHotkey = "option+space") {
    this.wisprHotkey = wisprHotkey;
  }

  async start(): Promise<void> {
    this.running = true;

    const helperPath = join(dirname(import.meta.dir), "..", "helpers", "cicero-hotkey");
    const exists = await Bun.file(helperPath).exists();

    if (!exists) {
      log("warn", `Hotkey helper not found at ${helperPath}`);
      log("warn", "  Build with: swiftc -O -o helpers/cicero-hotkey helpers/cicero-hotkey.swift -framework Cocoa");
      log("warn", "  Falling back to stdin mode");
      return;
    }

    log("info", "Starting global hotkey listener (ctrl+shift+space)...");

    this.hotkeyProc = Bun.spawn([helperPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Read stderr for READY signal
    this.readStderr();

    // Read stdout for HOTKEY events
    this.readHotkeyEvents();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.hotkeyProc) {
      try { this.hotkeyProc.kill(); } catch {}
      this.hotkeyProc = null;
    }
  }

  onCommand(callback: (text: string) => void): void {
    this.callback = callback;
  }

  private async readStderr(): Promise<void> {
    const stderr = this.hotkeyProc?.stderr;
    if (!stderr || typeof stderr === "number") return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trim();
        if (text.includes("READY")) {
          log("ok", "Global hotkey listener active (ctrl+shift+space)");
        } else if (text.includes("ERROR")) {
          log("error", `Hotkey helper: ${text}`);
        }
      }
    } catch {}
  }

  private async readHotkeyEvents(): Promise<void> {
    const stdout = this.hotkeyProc?.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "HOTKEY") {
            await this.onHotkeyPressed();
          }
        }
      }
    } catch {}
  }

  private async onHotkeyPressed(): Promise<void> {
    log("info", "Hotkey pressed — activating Wispr Flow");

    // Save current clipboard
    const prevClipboard = await this.getClipboard();

    // Activate Wispr Flow by simulating its hotkey
    await this.activateWisprFlow();

    // Poll clipboard for new text (Wispr types + some configs copy to clipboard)
    const capturedText = await this.waitForDictation(prevClipboard);

    if (capturedText && this.callback) {
      log("info", `Captured: "${capturedText.substring(0, 80)}${capturedText.length > 80 ? "..." : ""}"`);
      this.callback(capturedText);
    } else {
      log("warn", "No dictation captured — Wispr may not have produced output");
    }
  }

  private async activateWisprFlow(): Promise<void> {
    // Simulate Wispr Flow's activation hotkey via AppleScript
    // Default: Option+Space. Parse the configured hotkey.
    const { modifiers, keyCode } = this.parseHotkey(this.wisprHotkey);

    const script = `tell application "System Events" to key code ${keyCode}${modifiers}`;
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    await proc.exited;
  }

  private async waitForDictation(prevClipboard: string): Promise<string | null> {
    const maxWaitMs = 30_000; // 30s max dictation time
    const pollIntervalMs = 500;
    const startTime = Date.now();
    let stableCount = 0;
    let lastClipboard = prevClipboard;

    // Wait a moment for Wispr to activate
    await Bun.sleep(1000);

    while (Date.now() - startTime < maxWaitMs) {
      const currentClipboard = await this.getClipboard();

      // Clipboard changed from original — Wispr may have finished
      if (currentClipboard !== prevClipboard && currentClipboard.trim().length > 0) {
        // Wait for stability (clipboard not changing anymore)
        if (currentClipboard === lastClipboard) {
          stableCount++;
          if (stableCount >= 3) {
            return currentClipboard.trim();
          }
        } else {
          stableCount = 0;
        }
      }

      lastClipboard = currentClipboard;
      await Bun.sleep(pollIntervalMs);
    }

    return null;
  }

  private async getClipboard(): Promise<string> {
    const proc = Bun.spawn(["pbpaste"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  }

  private parseHotkey(hotkey: string): { modifiers: string; keyCode: number } {
    const parts = hotkey.toLowerCase().split("+").map(s => s.trim());
    const key = parts.pop() || "space";
    const mods: string[] = [];

    for (const part of parts) {
      switch (part) {
        case "cmd": case "command": mods.push("command down"); break;
        case "ctrl": case "control": mods.push("control down"); break;
        case "alt": case "option": mods.push("option down"); break;
        case "shift": mods.push("shift down"); break;
      }
    }

    // macOS key codes for common keys
    const keyCodes: Record<string, number> = {
      space: 49, return: 36, tab: 48, escape: 53, delete: 51,
      a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4,
      i: 34, j: 38, k: 40, l: 37, m: 46, n: 45, o: 31, p: 35,
      q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7,
      y: 16, z: 6,
    };

    const modString = mods.length > 0 ? ` using {${mods.join(", ")}}` : "";
    return { modifiers: modString, keyCode: keyCodes[key] ?? 49 };
  }
}
