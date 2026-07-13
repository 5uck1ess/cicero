/**
 * A codex `--json` event. Loosely typed — we read only the fields we narrate.
 * Shapes observed from codex-cli `exec --json`:
 *   {type:"item.started",   item:{type:"command_execution", command, status}}
 *   {type:"item.completed", item:{type:"command_execution", command, exit_code, status}}
 *   {type:"item.completed", item:{type:"agent_message", text}}
 *   {type:"thread.started"|"turn.started"|"turn.completed", …}  (bookkeeping)
 */
export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string; command?: string; exit_code?: number | null };
}

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Read and validate the explicit session identity from `thread.started`. */
export function codexThreadId(raw: unknown): string | null {
  const event = raw as CodexEvent;
  if (event?.type !== "thread.started") return null;
  if (typeof event.thread_id !== "string" || !THREAD_ID.test(event.thread_id)) {
    throw new Error("Codex thread.started event did not contain a valid thread UUID");
  }
  return event.thread_id;
}

/** Normal answer stream: agent messages only, with boundaries kept readable. */
export async function* codexAgentMessages(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  let first = true;
  for await (const raw of events) {
    const event = raw as CodexEvent;
    const item = event.item;
    if (event.type !== "item.completed" || item?.type !== "agent_message" || !item.text) continue;
    yield `${first ? "" : "\n"}${item.text}`;
    first = false;
  }
}

/** Strip the shell wrapper codex prepends, e.g. "/bin/zsh -lc ls" -> "ls". */
export function cleanCommand(command: string): string {
  const stripped = command.replace(/^\/?(?:usr\/)?bin\/(?:ba|z)?sh\s+-l?c\s+/, "").trim();
  return stripped || command.trim();
}

/**
 * Turn a stream of codex `--json` events into speakable progress narration so
 * Cicero can say what the agent is doing as it works:
 *  - each `agent_message` (codex's own natural-language narration AND its final
 *    answer) is spoken verbatim,
 *  - each command run is announced ("Running ls."),
 *  - a non-zero command exit is flagged ("That command failed.").
 * Raw command output and bookkeeping events (thread/turn/error) are skipped.
 */
export async function* narrateCodexEvents(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const raw of events) {
    const ev = raw as CodexEvent;
    const item = ev.item;
    if (!item) continue;

    if (ev.type === "item.started" && item.type === "command_execution" && item.command) {
      yield `Running ${cleanCommand(item.command)}.`;
    } else if (ev.type === "item.completed") {
      if (item.type === "agent_message" && item.text) {
        yield item.text;
      } else if (item.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0) {
        yield "That command failed.";
      }
    }
  }
}
