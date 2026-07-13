export type BrainChatMessage = { role: "system" | "user" | "assistant"; content: string };

const MAX_PENDING_ENTRIES = 50;
const MAX_PENDING_CHARS = 24_000;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 32_000;

function tail(value: string, max: number): string {
  return value.length <= max ? value : `[earlier content truncated]\n${value.slice(-max)}`;
}

/**
 * Shared context contract for every brain adapter.
 *
 * Injected context is one-shot: it rides the next actual model/agent turn and
 * is consumed when that turn starts. Stateless adapters may also retain a
 * bounded transcript; stateful sessions disable transcript replay.
 */
export class BrainTurnContext {
  private pending: string[] = [];
  private history: Array<{ user: string; assistant: string }> = [];

  inject(context: string): void {
    const value = context.trim();
    if (!value) return;
    this.pending.push(tail(value, 8_000));
    if (this.pending.length > MAX_PENDING_ENTRIES) this.pending = this.pending.slice(-MAX_PENDING_ENTRIES);
    while (this.pending.join("\n").length > MAX_PENDING_CHARS && this.pending.length > 1) this.pending.shift();
  }

  clear(): void {
    this.pending = [];
    this.history = [];
  }

  get pendingSize(): number {
    return this.pending.length;
  }

  takePending(): string | null {
    if (this.pending.length === 0) return null;
    const value = this.pending.join("\n\n");
    this.pending = [];
    return value;
  }

  remember(user: string, assistant: string): void {
    const reply = assistant.trim();
    if (!reply) return;
    this.history.push({ user: tail(user.trim(), 4_000), assistant: tail(reply, 8_000) });
    if (this.history.length > MAX_HISTORY_TURNS) this.history = this.history.slice(-MAX_HISTORY_TURNS);
    const chars = () => this.history.reduce((n, turn) => n + turn.user.length + turn.assistant.length, 0);
    while (chars() > MAX_HISTORY_CHARS && this.history.length > 1) this.history.shift();
  }

  buildTextPrompt(message: string, includeHistory: boolean): string {
    const sections: string[] = [];
    if (includeHistory && this.history.length > 0) {
      sections.push(
        "Conversation so far:\n" + this.history
          .map((turn) => `User: ${turn.user}\nAssistant: ${turn.assistant}`)
          .join("\n\n"),
      );
    }
    const pending = this.takePending();
    if (pending) sections.push(`Context for this turn:\n${pending}`);
    if (sections.length === 0) return message;
    sections.push(`Current user request:\n${message}`);
    return sections.join("\n\n");
  }

  buildChatMessages(message: string, systemPrompt?: string): BrainChatMessage[] {
    const messages: BrainChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    const pending = this.takePending();
    if (pending) messages.push({ role: "system", content: `Context for this turn:\n${pending}` });
    for (const turn of this.history) {
      messages.push({ role: "user", content: turn.user });
      messages.push({ role: "assistant", content: turn.assistant });
    }
    messages.push({ role: "user", content: message });
    return messages;
  }
}
