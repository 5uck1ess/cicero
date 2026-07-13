import { iterateBoundedUtf8Lines } from "../stream/bounded-lines";

export const DEFAULT_JSONL_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonLineOptions {
  /** Per-record UTF-8 byte cap. Defaults to 8 MiB. */
  maxLineBytes?: number;
}

/**
 * Decode a byte stream of newline-delimited JSON (JSONL) into parsed objects —
 * e.g. `codex exec --json` or `claude --output-format stream-json`. Reassembles
 * records split across chunks, rejects oversized/invalid-UTF-8 records, and
 * silently skips blank or unparseable lines (some harnesses mix diagnostics in).
 */
export async function* iterateJsonLines(
  stream: ReadableStream<Uint8Array>,
  options: JsonLineOptions = {},
): AsyncGenerator<unknown> {
  try {
    for await (const rawLine of iterateBoundedUtf8Lines(stream, {
      maxLineBytes: options.maxLineBytes ?? DEFAULT_JSONL_MAX_LINE_BYTES,
      context: "JSONL",
    })) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Some CLI harnesses write diagnostics to stdout; retain compatibility.
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error) throw error;
    throw new Error(`JSONL stream failed: ${String(error)}`);
  }
}
