import { join } from "path";
import { AcpBrain } from "../../../src/brain/acp";

const mockAgent = join(import.meta.dir, "mock-acp-agent.ts");
const brain = new AcpBrain({
  binary: process.execPath,
  args: [mockAgent],
  startTimeoutMs: 2_000,
  terminateGraceMs: 50,
});

try {
  await brain.start();
  const controller = new AbortController();
  const iterator = brain.sendStream("wait for cancel", { signal: controller.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  await Bun.sleep(30);
  controller.abort();
  await pending;
  await brain.stop();
} catch (error: unknown) {
  try { await brain.stop(); } catch { /* report the original failure */ }
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
