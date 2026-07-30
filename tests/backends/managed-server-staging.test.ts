import { expect, test } from "bun:test";
import { randomInt } from "node:crypto";
import {
  StagedManagedServerPortError,
  startManagedServer,
  type StartOpts,
  withStagedManagedServerPorts,
} from "../../src/backends/managed-server";

test("staged startup distinguishes refused adoption from a bind race", async () => {
  const adoptedPort = randomInt(20_000, 40_000);
  let bindPort = randomInt(40_000, 60_000);
  if (bindPort === adoptedPort) bindPort += 1;

  const adoption = await withStagedManagedServerPorts(
    new Set([adoptedPort]),
    async () => startManagedServer({
      name: "staged-adoption",
      port: adoptedPort,
      command: [process.execPath],
      healthUrl: `http://127.0.0.1:${adoptedPort}/health`,
      fetcher: async () => new Response("compatible", { status: 200 }),
      spawner: (() => { throw new Error("must not spawn over a healthy listener"); }) as StartOpts["spawner"],
    }),
  ).then(() => null, (error: unknown) => error);

  let probes = 0;
  const fakeProcess = {
    pid: 2_000_000_000,
    exited: Promise.resolve(98),
    exitCode: 98,
    signalCode: null,
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("EADDRINUSE: address already in use\n"));
        controller.close();
      },
    }),
    kill: () => {},
  };
  const bindFailure = await withStagedManagedServerPorts(
    new Set([bindPort]),
    async () => startManagedServer({
      name: "staged-bind",
      port: bindPort,
      command: [process.execPath],
      healthUrl: `http://127.0.0.1:${bindPort}/health`,
      fetcher: async () => {
        const response = probes === 0
          ? new Response("not ready", { status: 503 })
          : new Response("listener won", { status: 200 });
        probes += 1;
        return response;
      },
      spawner: (() => fakeProcess) as unknown as StartOpts["spawner"],
    }),
  ).then(() => null, (error: unknown) => error);

  expect(adoption).toBeInstanceOf(StagedManagedServerPortError);
  expect((adoption as StagedManagedServerPortError).outcome).toBe("adoption-refused");
  expect(bindFailure).toBeInstanceOf(StagedManagedServerPortError);
  expect((bindFailure as StagedManagedServerPortError).outcome).toBe("bind-failed");
});
