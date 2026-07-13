/**
 * A Claude Code `--output-format stream-json` event. Loosely typed — we read
 * only the fields we narrate. Shapes observed from `claude -p --output-format
 * stream-json --verbose`:
 *   {type:"assistant", message:{content:[{type:"text", text}]}}
 *   {type:"assistant", message:{content:[{type:"thinking", …}]}}            (internal)
 *   {type:"assistant", message:{content:[{type:"tool_use", name, input}]}}
 *   {type:"user",      message:{content:[{type:"tool_result", is_error, content}]}}
 *   {type:"result", subtype:"success", result, is_error}                    (duplicate of final text)
 *   {type:"system"|"rate_limit_event", …}                                  (bookkeeping)
 */
interface ClaudePart {
  type?: string;
  text?: string;
  name?: string; // tool name for tool_use
  input?: { command?: string; file_path?: string; pattern?: string };
  is_error?: boolean;
}
interface ClaudeEvent {
  type?: string;
  message?: { content?: ClaudePart[] };
}

function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fileLabel(path: string | undefined): string {
  if (!path) return "a file";
  const name = path.split("/").pop();
  return name && name.length > 0 ? name : path;
}

/** A short spoken phrase for a Claude tool call, e.g. Bash -> "Running npm test." */
function narrateToolUse(name: string, input: ClaudePart["input"]): string {
  switch (name) {
    case "Bash":
      return input?.command ? `Running ${truncate(input.command)}.` : "Running a command.";
    case "Read":
      return `Reading ${fileLabel(input?.file_path)}.`;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return `Editing ${fileLabel(input?.file_path)}.`;
    case "Glob":
    case "Grep":
      return "Searching the codebase.";
    default:
      return `Using ${name}.`;
  }
}

/**
 * Turn a stream of Claude Code `stream-json` events into speakable progress
 * narration: each assistant text is spoken, each tool call is announced
 * ("Running ls.", "Editing auth.ts."), and a failed tool result is flagged.
 * Internal `thinking`, raw tool output, the duplicate `result` event, and
 * system/bookkeeping events are skipped.
 */
export async function* narrateClaudeEvents(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const raw of events) {
    const ev = raw as ClaudeEvent;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue; // system / result / rate_limit have no content
    for (const part of content) {
      if (ev.type === "assistant") {
        if (part.type === "text" && part.text && part.text.trim()) {
          yield part.text;
        } else if (part.type === "tool_use" && part.name) {
          yield narrateToolUse(part.name, part.input);
        }
        // `thinking` parts are internal reasoning — not spoken.
      } else if (ev.type === "user" && part.type === "tool_result" && part.is_error) {
        yield "That command failed.";
      }
    }
  }
}
