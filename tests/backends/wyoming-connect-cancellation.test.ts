import { expect, test } from "bun:test";
import type { Socket } from "bun";
import { WyomingClient } from "../../src/backends/wyoming/client";
import { withWyomingAbort } from "../../src/backends/wyoming/abort";

test("Wyoming closes a socket that connects after abort and never writes to it", async () => {
  let resolveConnect!: (socket: Socket) => void;
  let writes = 0;
  let closes = 0;
  let dials = 0;
  const client = new WyomingClient({
    host: "127.0.0.1",
    port: 0,
    connectSocket: () => {
      dials++;
      return new Promise<Socket>((resolve) => { resolveConnect = resolve; });
    },
  });
  const controller = new AbortController();
  let send!: Promise<void>;
  const request = withWyomingAbort(client, controller.signal, () => {
    send = client.send({ type: "synthesize", data: { text: "old turn" } });
    return send;
  });

  controller.abort(new DOMException("turn ended", "AbortError"));
  await expect(request).rejects.toHaveProperty("name", "AbortError");
  resolveConnect({
    write: () => { writes++; return 0; },
    end: () => { closes++; },
  } as unknown as Socket);
  await send.catch(() => {});
  expect(writes).toBe(0);
  expect(closes).toBe(1);
  await expect(client.send({ type: "synthesize", data: { text: "too late" } })).rejects.toThrow("closed");
  expect(dials).toBe(1);
});
