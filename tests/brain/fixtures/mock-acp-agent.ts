// Deterministic mock ACP agent for AcpBrain tests. Speaks REAL ACP over stdio via
// the official AgentSideConnection — no network, no credentials — so the brain's
// stdio + ndjson + session lifecycle is exercised end-to-end against a real peer.
//
// Behavior:
//   - prompt containing "use tool" -> requests a tool permission, then replies
//     `perm:<optionId>` (lets a test assert auto-approve vs reject wiring).
//   - prompt containing "wait for cancel" -> stays silent until cancel, then
//     settles after a short delay (exercises cancellation + turn serialization).
//   - any other prompt -> streams the reply back as two chunks: "echo:" then the
//     received text (lets a test assert both batch and incremental streaming).
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type PromptRequest,
} from "@zed-industries/agent-client-protocol";
import { appendFileSync } from "node:fs";

const spawnPidLog = process.env.CICERO_TEST_ACP_SPAWN_PID_LOG;
if (spawnPidLog) appendFileSync(spawnPidLog, `${process.pid}\n`);

const sink = Bun.stdout.writer();
const output = new WritableStream<Uint8Array>({
  write(chunk) { sink.write(chunk); void sink.flush(); },
});
const input = Bun.stdin.stream() as ReadableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

// Process-ownership fixture mode: the ACP root and a same-group descendant both
// ignore TERM. The parent test waits for this PID manifest before calling stop(),
// so escalation and group-disappearance assertions are deterministic.
const stubbornPidFile = process.env.CICERO_TEST_ACP_STUBBORN_PID_FILE;
if (stubbornPidFile) {
  process.on("SIGTERM", () => {});
  const childSource = [
    `process.on("SIGTERM", () => {});`,
    `process.stdout.write("ready\\n");`,
    `setInterval(() => {}, 1_000);`,
  ].join("\n");
  try {
    const child = Bun.spawn([process.execPath, "-e", childSource], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    if (ready.done) throw new Error("stubborn descendant exited before ready");
    await Bun.write(stubbornPidFile, JSON.stringify({ rootPid: process.pid, childPid: child.pid }));
  } catch (error: unknown) {
    process.stderr.write(`stubborn fixture setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

new AgentSideConnection((client: Client): Agent => {
  let releaseSilentTurn: (() => void) | null = null;
  let cancelRequested = false;
  let ignoreCancellation = false;
  const emit = (sessionId: string, text: string) =>
    client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });

  return {
    async initialize() {
      try {
        const delayMs = Number.parseInt(process.env.CICERO_TEST_ACP_INITIALIZE_DELAY_MS ?? "0", 10);
        if (Number.isFinite(delayMs) && delayMs > 0) await Bun.sleep(delayMs);
        return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] };
      } catch (error: unknown) {
        throw error;
      }
    },
    async newSession() {
      return { sessionId: "mock-session-1" };
    },
    async authenticate() {
      return null;
    },
    async prompt(params: PromptRequest) {
      const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");

      if (text.includes("ignore cancellation until stopped")) {
        ignoreCancellation = true;
        await new Promise<void>(() => { /* process termination is the only release */ });
        return { stopReason: "cancelled" };
      }

      if (text.includes("wait for cancel")) {
        if (cancelRequested) {
          cancelRequested = false;
        } else {
          await new Promise<void>((resolve) => { releaseSilentTurn = resolve; });
        }
        releaseSilentTurn = null;
        // Cancellation acknowledgement and prompt settlement are distinct in
        // real harnesses. Keep the prompt alive briefly so the host can prove
        // that it does not release the next turn early.
        await Bun.sleep(150);
        return { stopReason: "cancelled" };
      }

      if (text.includes("flood paused consumer")) {
        cancelRequested = false;
        for (let i = 0; i < 20_000; i++) {
          if (cancelRequested) return { stopReason: "cancelled" };
          await emit(params.sessionId, "0123456789");
        }
        return { stopReason: "end_turn" };
      }

      if (text.includes("many tiny chunks")) {
        cancelRequested = false;
        for (let i = 0; i < 20_000; i++) await emit(params.sessionId, "x");
        return { stopReason: "end_turn" };
      }

      if (text.includes("endless aggregation")) {
        cancelRequested = false;
        for (let i = 0; i < 20_000; i++) {
          if (cancelRequested) return { stopReason: "cancelled" };
          await emit(params.sessionId, "0123456789");
          await Bun.sleep(1);
        }
        return { stopReason: "end_turn" };
      }

      if (text.includes("use tool")) {
        const res = await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: "mock-tool-1" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        const decided = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled";
        await emit(params.sessionId, `perm:${decided}`);
        return { stopReason: "end_turn" };
      }

      await emit(params.sessionId, "echo:");
      await emit(params.sessionId, text);
      return { stopReason: "end_turn" };
    },
    async cancel() {
      if (ignoreCancellation) return;
      if (releaseSilentTurn) {
        const release = releaseSilentTurn;
        releaseSilentTurn = null;
        release();
      } else {
        cancelRequested = true;
      }
    },
  };
}, stream);
