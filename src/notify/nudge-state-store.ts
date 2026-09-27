import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../platform/private-json";

/** Reminders already sent for one unstarted task, and when the next is allowed. */
export interface NudgeState {
  count: number;
  nextAt: number;
}

export interface NudgeStateStore {
  load(): Promise<ReadonlyMap<string, NudgeState>>;
  save(entries: ReadonlyMap<string, NudgeState>): Promise<void>;
}

const MAX_ENTRIES = 500;
const MAX_ID_CHARS = 128;
const MAX_BYTES = 256 * 1024;

export function nudgeStateFilePath(): string {
  return join(homedir(), ".cicero", "kanban-nudges.json");
}

/** Bounded private JSON file; malformed entries are dropped, never trusted. */
export class NudgeStateFile implements NudgeStateStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string = nudgeStateFilePath()) {}

  async load(): Promise<ReadonlyMap<string, NudgeState>> {
    const raw = await readPrivateJson(this.file, MAX_BYTES);
    const entries = new Map<string, NudgeState>();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return entries;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (entries.size >= MAX_ENTRIES) break;
      if (!id || id.length > MAX_ID_CHARS || value === null || typeof value !== "object") continue;
      const { count, nextAt } = value as Record<string, unknown>;
      if (!Number.isSafeInteger(count) || (count as number) < 0 || typeof nextAt !== "number" || !Number.isFinite(nextAt)) continue;
      entries.set(id, { count: count as number, nextAt });
    }
    return entries;
  }

  save(entries: ReadonlyMap<string, NudgeState>): Promise<void> {
    const snapshot: Record<string, NudgeState> = {};
    let n = 0;
    for (const [id, { count, nextAt }] of entries) {
      if (n++ >= MAX_ENTRIES) break;
      if (id.length <= MAX_ID_CHARS) snapshot[id] = { count, nextAt };
    }
    const result = this.pending.catch(() => {}).then(() => writePrivateJson(this.file, snapshot));
    this.pending = result.then(() => {}, () => {});
    return result;
  }
}
