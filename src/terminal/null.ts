import type { TerminalAdapter, Tab, SpawnTabOptions } from "../types";

/**
 * No-op terminal adapter for headless deployments — voice → brain dispatch
 * without spawning or inspecting terminal windows. Every method is a safe
 * no-op that never throws.
 */
export class NullTerminalAdapter implements TerminalAdapter {
  async listTabs(): Promise<Tab[]> { return []; }
  async focusTab(): Promise<void> {}
  async sendText(): Promise<void> {}
  async sendKey(): Promise<void> {}
  async getText(): Promise<string> { return ""; }
  async spawnTab(opts: SpawnTabOptions): Promise<Tab> {
    return { id: "null", title: opts.title, is_focused: false };
  }
  async closeTab(): Promise<void> {}
  async health(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true, reason: "headless mode (no terminal integration)" };
  }
}
