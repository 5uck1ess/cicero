import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { loadActionSnapshot, type RuntimeConfig } from "./config";
import { validateRuntimeConfig } from "./config-validation";

export interface ActionReloadOptions {
  debounceMs?: number;
  onReload?: (customCount: number) => void;
  onError?: (error: Error) => void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Watch the actions file's parent directory so rename-based atomic saves remain
 * observable. Runtime actions change only after a complete candidate config has
 * passed the same validator used during startup.
 */
export class ActionConfigReloader {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly actionsPath: string,
    private readonly config: RuntimeConfig,
    private readonly options: ActionReloadOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 500;
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(dirname(this.actionsPath), () => {
      // fs.watch filenames are optional and platform-dependent. Atomic writers
      // can report only their temporary filename on Linux, so filtering here
      // would miss the replacement. The debounce keeps unrelated directory
      // activity cheap; reloadNow still reads only actionsPath.
      this.scheduleReload();
    });
    this.watcher.on("error", (error) => this.options.onError?.(toError(error)));
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  reloadNow(): boolean {
    let snapshot: ReturnType<typeof loadActionSnapshot>;
    try {
      snapshot = loadActionSnapshot(this.actionsPath);
      const candidate = { ...this.config.raw, actions: snapshot.actions };
      validateRuntimeConfig(candidate, this.actionsPath);
    } catch (error: unknown) {
      this.options.onError?.(toError(error));
      return false;
    }

    this.config.raw.actions = snapshot.actions;
    this.options.onReload?.(snapshot.customCount);
    return true;
  }

  private scheduleReload(): void {
    // close() can race with a directory event already queued by the platform.
    // Once stop() clears watcher, that late callback must not recreate work.
    if (!this.watcher) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.watcher) return;
      this.reloadNow();
    }, this.debounceMs);
  }
}
