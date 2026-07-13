import { once } from "node:events";

type FixtureMode = "silent" | "term-tree" | "early-return" | "stdout-close" | "stderr-flood" | "remembered-cap";

async function write(stream: NodeJS.WriteStream, value: string): Promise<void> {
  try {
    if (!stream.write(value)) await once(stream, "drain");
  } catch (error: unknown) {
    throw new Error(`fixture output failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function emitText(text: string): Promise<void> {
  await write(process.stdout, `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  })}\n`);
}

async function remainAlive(): Promise<never> {
  return new Promise<never>(() => { setInterval(() => {}, 1_000); });
}

async function run(mode: FixtureMode): Promise<number> {
  try {
    switch (mode) {
      case "silent":
        return await remainAlive();
      case "term-tree": {
        const child = Bun.spawn([
          process.execPath,
          "-e",
          `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
        ], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        process.on("SIGTERM", () => {});
        await emitText(`PARENT=${process.pid};CHILD=${child.pid}`);
        return await remainAlive();
      }
      case "early-return":
        await emitText(`PARENT=${process.pid}`);
        return await remainAlive();
      case "stderr-flood":
        await write(process.stderr, "HEAD_TOKEN\n");
        for (let index = 0; index < 64; index++) {
          await write(process.stderr, "x".repeat(64 * 1024));
        }
        await write(process.stderr, "\nTAIL_TOKEN");
        return 7;
      case "remembered-cap":
        for (let index = 0; index < 64; index++) {
          await emitText(`${"r".repeat(16 * 1024)} chunk-${index}`);
        }
        return 0;
      default:
        throw new Error(`unknown fixture mode: ${String(mode)}`);
    }
  } catch (error: unknown) {
    throw new Error(`Claude progress fixture failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

const mode = process.argv[2] as FixtureMode | undefined;
if (!mode) {
  process.stderr.write("fixture mode is required\n");
  process.exitCode = 2;
} else {
  void run(mode)
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
