import type { Tool } from "./tool";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Best-effort cleanup of every tool that holds resources (e.g. the browser). */
  async dispose(): Promise<void> {
    for (const tool of this.tools.values()) {
      if (!tool.dispose) continue;
      try { await tool.dispose(); } catch { /* best-effort cleanup */ }
    }
  }

  /** One line per tool: `- name(arg1, arg2) — description`, for the system prompt. */
  manifest(): string {
    return this.list()
      .map((tool) => {
        const props = (tool.parameters?.properties ?? {}) as Record<string, unknown>;
        const argList = Object.keys(props).join(", ");
        return `- ${tool.name}(${argList}) — ${tool.description}`;
      })
      .join("\n");
  }
}
