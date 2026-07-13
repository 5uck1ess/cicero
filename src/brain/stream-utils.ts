/**
 * Decode a byte ReadableStream (e.g. a subprocess stdout) into text pieces,
 * correctly handling multi-byte UTF-8 characters split across chunk boundaries.
 */
export async function* iterateTextStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}
