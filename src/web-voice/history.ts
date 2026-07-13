import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDirectorySync,
  ensurePrivateFileIfExistsSync,
} from "../platform/secure-storage";

/**
 * Persistent web-voice conversation log: one JSONL line per completed turn.
 * On (re)connect the page gets the recent tail back, so a browser refresh —
 * or picking the phone back up hours later — doesn't wipe the chat log.
 * Speech is private data: this stays on disk in ~/.cicero, nothing leaves.
 */

export interface HistoryTurn {
  t: number;      // epoch ms
  user: string;   // transcript
  reply: string;  // spoken sentences, joined
  lane?: string;  // who spoke the reply (undefined = the front desk) — the resume primer needs the speaker
}

const MAX_LINES = 1000;   // trim threshold …
const KEEP_LINES = 500;   // … rewrite keeping this many

export class TurnHistory {
  private pending: Promise<void> = Promise.resolve();
  private available = true;

  constructor(private file: string) {
    try {
      ensurePrivateDirectorySync(dirname(file));
      ensurePrivateFileIfExistsSync(file);
    } catch (err: unknown) {
      // History is a convenience, not a startup dependency. Keep the unsafe
      // path fail-closed while allowing Telegram, web voice, and warmup to run.
      this.available = false;
      log("warn", `web-voice history disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Append a turn (serialized through a chain so concurrent turns can't interleave writes). */
  append(turn: HistoryTurn): Promise<void> {
    if (!this.available) return Promise.resolve();
    this.pending = this.pending.then(async () => {
      try {
        await appendFile(this.file, JSON.stringify(turn) + "\n", { mode: PRIVATE_FILE_MODE });
        await this.trimIfNeeded();
      } catch (err: unknown) {
        log("info", `web-voice history write skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return this.pending;
  }

  /** The most recent `n` turns, oldest first. */
  async recent(n: number): Promise<HistoryTurn[]> {
    try {
      if (!this.available) return [];
      if (!existsSync(this.file)) return [];
      const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
      const out: HistoryTurn[] = [];
      for (const line of lines.slice(-n)) {
        try { out.push(JSON.parse(line) as HistoryTurn); } catch { /* skip corrupt line */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async trimIfNeeded(): Promise<void> {
    const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    await writeFile(this.file, lines.slice(-KEEP_LINES).join("\n") + "\n", { mode: PRIVATE_FILE_MODE });
  }
}
