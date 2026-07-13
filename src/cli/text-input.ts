export interface CliTextLimit {
  label: string;
  maxBytes: number;
  maxChars: number;
}

function validateLimit(limit: CliTextLimit): void {
  if (!Number.isSafeInteger(limit.maxBytes) || limit.maxBytes <= 0) {
    throw new RangeError(`${limit.label} byte limit must be a positive integer`);
  }
  if (!Number.isSafeInteger(limit.maxChars) || limit.maxChars <= 0) {
    throw new RangeError(`${limit.label} character limit must be a positive integer`);
  }
}

export function normalizeCliText(text: string, limit: CliTextLimit): string {
  validateLimit(limit);
  const normalized = text.trim();
  if (!normalized) throw new Error(`${limit.label} is empty`);
  if (normalized.length > limit.maxChars) {
    throw new RangeError(`${limit.label} exceeds ${limit.maxChars} characters`);
  }
  if (new TextEncoder().encode(normalized).byteLength > limit.maxBytes) {
    throw new RangeError(`${limit.label} exceeds ${limit.maxBytes} UTF-8 bytes`);
  }
  return normalized;
}

export async function readBoundedCliText(
  stream: ReadableStream<Uint8Array>,
  limit: CliTextLimit,
): Promise<string> {
  validateLimit(limit);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit.maxBytes) {
        try {
          void reader.cancel(`${limit.label} exceeded its byte limit`).catch(() => {});
        } catch {
          // The producer may already have closed while the cap was detected.
        }
        throw new RangeError(`${limit.label} exceeds ${limit.maxBytes} UTF-8 bytes`);
      }
      chunks.push(value.slice());
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err: unknown) {
    throw new Error(`${limit.label} is not valid UTF-8`, { cause: err });
  }
  return normalizeCliText(text, limit);
}

export async function commandText(
  textParts: string[],
  stdin: ReadableStream<Uint8Array>,
  limit: CliTextLimit,
): Promise<string> {
  return textParts.length > 0
    ? normalizeCliText(textParts.join(" "), limit)
    : await readBoundedCliText(stdin, limit);
}
