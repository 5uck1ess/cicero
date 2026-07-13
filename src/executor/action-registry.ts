import type { ActionConfig } from "../types";

export class ActionRegistry {
  private actions: Record<string, ActionConfig>;

  constructor(actions: Record<string, ActionConfig> = {}) {
    this.actions = actions;
  }

  get(name: string): ActionConfig | undefined {
    return this.actions[name];
  }

  list(): Record<string, ActionConfig> {
    return { ...this.actions };
  }

  add(name: string, action: ActionConfig): void {
    this.actions[name] = action;
  }

  remove(name: string): void {
    delete this.actions[name];
  }
}
