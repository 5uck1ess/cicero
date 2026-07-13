export interface Turn {
  text: string;
  intent: string;
  category: string;
  params: Record<string, string>;
  output?: string;
  timestamp?: number;
}

export class ContextStore {
  private entries: string[] = [];
  private turns: Turn[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 50) {
    this.maxEntries = maxEntries;
  }

  // --- Legacy API (unchanged) ---

  add(label: string, output: string): void {
    const entry = `[Command] ${label}\n[Output] ${output}`;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getContext(): string {
    return this.entries.join("\n\n");
  }

  clear(): void {
    this.entries = [];
    this.turns = [];
  }

  get size(): number {
    return this.entries.length;
  }

  // --- New structured turn API ---

  addTurn(turn: Turn): void {
    this.turns.push({ ...turn, timestamp: turn.timestamp ?? Date.now() });
    if (this.turns.length > this.maxEntries) {
      this.turns = this.turns.slice(-this.maxEntries);
    }
  }

  get lastTurn(): Turn | null {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
  }

  getRecentTurns(n: number): Turn[] {
    return this.turns.slice(-n);
  }

  /**
   * Format recent turns as a string for injection into LLM prompts.
   * Shows intent classification alongside user text for context.
   */
  getRecentTurnsForPrompt(n: number): string {
    return this.getRecentTurns(n)
      .map(t => {
        let line = `User: "${t.text}" → ${t.intent} (${t.category})`;
        if (t.output) line += `\nResult: ${t.output.substring(0, 100)}`;
        return line;
      })
      .join("\n");
  }
}
