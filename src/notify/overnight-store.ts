import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PrivateJsonTooLargeError, readPrivateJson, writePrivateJson } from "../platform/private-json";
import { ensurePrivateDirectorySync, ensurePrivateFileIfExistsSync } from "../platform/secure-storage";

export interface OvernightItem {
  id: string;
  queuedAt: number;
  text: string;
}

const MAX_ITEMS = 40;
const MAX_TEXT_CHARS = 12_000;

export function overnightFilePath(): string {
  return join(homedir(), ".cicero", "overnight.json");
}

/** Durable, serialized quiet-hours queue. Reads never consume queued news. */
export class OvernightStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string = overnightFilePath(),
    private readonly now: () => number = Date.now,
    private readonly makeId: () => string = randomUUID,
  ) {
    ensurePrivateDirectorySync(dirname(file));
    ensurePrivateFileIfExistsSync(file);
  }

  enqueue(text: string): Promise<void> {
    return this.serialize(async () => {
      const { items } = await this.read();
      items.push({ id: this.makeId(), queuedAt: this.now(), text: text.slice(0, MAX_TEXT_CHARS) });
      await writePrivateJson(this.file, items.slice(-MAX_ITEMS));
    });
  }

  peek(): Promise<readonly OvernightItem[]> {
    return this.serialize(async () => {
      const { items, migrated } = await this.read();
      if (migrated) await writePrivateJson(this.file, items);
      return items.map((item) => ({ ...item }));
    });
  }

  ack(ids: readonly string[]): Promise<void> {
    return this.serialize(async () => {
      const remove = new Set(ids);
      if (remove.size === 0) return;
      const { items } = await this.read();
      await writePrivateJson(this.file, items.filter((item) => !remove.has(item.id)));
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async read(): Promise<{ items: OvernightItem[]; migrated: boolean }> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.file);
    } catch (error: unknown) {
      // Unsafe paths are a policy failure, not corrupt content to ignore.
      if (error instanceof SyntaxError || error instanceof PrivateJsonTooLargeError) {
        return { items: [], migrated: false };
      }
      throw error;
    }
    if (value === undefined) return { items: [], migrated: false };
    if (!Array.isArray(value)) return { items: [], migrated: false };

    let migrated = false;
    const items: OvernightItem[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        migrated = true;
        items.push({ id: this.makeId(), queuedAt: this.now(), text: entry.slice(0, MAX_TEXT_CHARS) });
        continue;
      }
      if (!isItem(entry)) continue;
      items.push({ id: entry.id, queuedAt: entry.queuedAt, text: entry.text.slice(0, MAX_TEXT_CHARS) });
    }
    // Legacy string[] migration intentionally shares the write-path MAX_ITEMS bound: the old writer
    // also used slice(-40), so retaining only the newest 40 remains the queue's memory bound.
    return { items: items.slice(-MAX_ITEMS), migrated };
  }
}

function isItem(value: unknown): value is OvernightItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OvernightItem>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 128
    && typeof item.queuedAt === "number" && Number.isFinite(item.queuedAt)
    && typeof item.text === "string";
}
