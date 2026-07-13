import { iterateBoundedUtf8Lines } from "../../stream/bounded-lines";

// Parse an OpenAI-style chat-completions SSE stream into `delta.content` tokens.
//
// Keeps an incomplete line buffered across network chunks: fetch/TCP chunk
// boundaries do NOT align with SSE event boundaries, so a JSON event split mid
// frame must not be dropped. Non-JSON keepalive lines are ignored.

const DONE = Symbol("sse-done");
export const DEFAULT_SSE_MAX_LINE_BYTES = 1024 * 1024;

export interface SSEStreamOptions {
  /** Per-event-line UTF-8 byte cap. Defaults to 1 MiB. */
  maxLineBytes?: number;
}

function parseLine(line: string): string | typeof DONE | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return DONE;
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
    return parsed.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null; // partial or non-JSON line (e.g. an SSE comment / keepalive)
  }
}

export async function* streamSSEContent(
  body: ReadableStream<Uint8Array>,
  options: SSEStreamOptions = {},
): AsyncGenerator<string> {
  try {
    for await (const rawLine of iterateBoundedUtf8Lines(body, {
      maxLineBytes: options.maxLineBytes ?? DEFAULT_SSE_MAX_LINE_BYTES,
      context: "SSE",
    })) {
      const line = rawLine.replace(/\r$/, "");
      const token = parseLine(line);
      if (token === DONE) return;
      if (token) yield token;
    }
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`SSE stream failed: ${String(error)}`);
  }
}
