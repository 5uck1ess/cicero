import { test, expect, describe } from "bun:test";
import { WyomingClient } from "../src/backends/wyoming/client";

describe("WyomingClient", () => {
  test("connects, sends describe, receives info", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const line = data.toString().trim();
          const msg = JSON.parse(line);
          if (msg.type === "describe") {
            socket.write(
              JSON.stringify({ type: "info", data: { models: [{ name: "test" }] } }) + "\n",
            );
          }
        },
      },
    });

    const client = new WyomingClient({ host: "127.0.0.1", port: server.port });
    const info = await client.describe();
    expect(info.type).toBe("info");
    expect(info.data?.models).toEqual([{ name: "test" }]);
    client.close();
    server.stop();
  });

  test("frames a header + binary payload correctly", async () => {
    const payloadBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const msg = JSON.parse(data.toString().split("\n")[0]!);
          if (msg.type === "ask-audio") {
            const header = JSON.stringify({ type: "audio-chunk", data: { rate: 16000 }, payload_length: payloadBytes.byteLength }) + "\n";
            socket.write(header);
            socket.write(payloadBytes);
          }
        },
      },
    });

    const client = new WyomingClient({ host: "127.0.0.1", port: server.port });
    await client.send({ type: "ask-audio", data: {} });
    const event = await client.receive();
    expect(event.type).toBe("audio-chunk");
    expect(event.data?.rate).toBe(16000);
    expect(Array.from(event.payload!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    client.close();
    server.stop();
  });

  test("splits two events arriving in a single TCP chunk", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          const msg = JSON.parse(data.toString().split("\n")[0]!);
          if (msg.type === "go") {
            // Two complete events written back-to-back in one write.
            socket.write(
              JSON.stringify({ type: "transcript", data: { text: "one" } }) + "\n" +
                JSON.stringify({ type: "transcript", data: { text: "two" } }) + "\n",
            );
          }
        },
      },
    });

    const client = new WyomingClient({ host: "127.0.0.1", port: server.port });
    await client.send({ type: "go", data: {} });
    const first = await client.receive();
    const second = await client.receive();
    expect(first.data?.text).toBe("one");
    expect(second.data?.text).toBe("two");
    client.close();
    server.stop();
  });

  test("receive() rejects on timeout", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const client = new WyomingClient({ host: "127.0.0.1", port: server.port, timeoutMs: 150 });
    await client.connect();
    await expect(client.receive()).rejects.toThrow(/timed out/);
    client.close();
    server.stop();
  });

  test("rejects a newline-free header above the configured cap", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write("x".repeat(17));
        },
      },
    });
    const client = new WyomingClient({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500,
      maxHeaderBytes: 16,
    });
    try {
      await client.send({ type: "go", data: {} });
      await expect(client.receive()).rejects.toThrow("Wyoming header exceeds 16 bytes");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("rejects declared payloads above the configured frame cap", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(JSON.stringify({ type: "audio-chunk", payload_length: 9 }) + "\n");
        },
      },
    });
    const client = new WyomingClient({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500,
      maxPayloadBytes: 8,
    });
    try {
      await client.send({ type: "go", data: {} });
      await expect(client.receive()).rejects.toThrow("Wyoming payload_length exceeds 8 bytes");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("rejects declared extra data above the configured frame cap", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(JSON.stringify({ type: "info", data_length: 9 }) + "\n");
        },
      },
    });
    const client = new WyomingClient({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500,
      maxDataBytes: 8,
    });
    try {
      await client.send({ type: "go", data: {} });
      await expect(client.receive()).rejects.toThrow("Wyoming data_length exceeds 8 bytes");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("rejects malformed headers and invalid frame lengths", async () => {
    const responses = [
      "{not-json}\n",
      JSON.stringify({ type: "audio-chunk", payload_length: -1 }) + "\n",
    ];
    for (const response of responses) {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket) {
            socket.write(response);
          },
        },
      });
      const client = new WyomingClient({ host: "127.0.0.1", port: server.port, timeoutMs: 500 });
      try {
        await client.send({ type: "go", data: {} });
        await expect(client.receive()).rejects.toThrow(/Wyoming (header|payload_length)/);
      } catch (error: unknown) {
        throw error instanceof Error ? error : new Error(String(error));
      } finally {
        client.close();
        server.stop();
      }
    }
  });

  test("rejects malformed extra-data JSON instead of desynchronizing", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(JSON.stringify({ type: "info", data_length: 1 }) + "\n" + "1");
        },
      },
    });
    const client = new WyomingClient({ host: "127.0.0.1", port: server.port, timeoutMs: 500 });
    try {
      await client.send({ type: "go", data: {} });
      await expect(client.receive()).rejects.toThrow("Wyoming extra data must be a JSON object");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("bounds events queued before a receiver starts", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          const event = JSON.stringify({ type: "noise", data: {} }) + "\n";
          socket.write(event + event + event);
        },
      },
    });
    const client = new WyomingClient({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500,
      maxQueuedEvents: 2,
    });
    try {
      await client.send({ type: "go", data: {} });
      await Bun.sleep(20);
      await expect(client.receive()).rejects.toThrow("Wyoming event queue exceeds 2 events");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("bounds framed bytes queued before a receiver starts", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(JSON.stringify({ type: "noise", data: {} }) + "\n");
        },
      },
    });
    const client = new WyomingClient({
      host: "127.0.0.1",
      port: server.port,
      timeoutMs: 500,
      maxQueuedBytes: 1,
    });
    try {
      await client.send({ type: "go", data: {} });
      await Bun.sleep(20);
      await expect(client.receive()).rejects.toThrow("or 1 bytes");
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      client.close();
      server.stop();
    }
  });

  test("receiveOfType uses one absolute deadline despite irrelevant events", async () => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          const noise = JSON.stringify({ type: "noise", data: {} }) + "\n";
          interval = setInterval(() => socket.write(noise), 5);
          stopTimer = setTimeout(() => {
            if (interval) clearInterval(interval);
          }, 250);
        },
      },
    });
    const client = new WyomingClient({ host: "127.0.0.1", port: server.port, timeoutMs: 500 });
    const started = Date.now();
    try {
      await client.send({ type: "go", data: {} });
      await expect(client.receiveOfType("wanted", 60)).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(200);
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (interval) clearInterval(interval);
      if (stopTimer) clearTimeout(stopTimer);
      client.close();
      server.stop();
    }
  });
});
