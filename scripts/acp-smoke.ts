/**
 * ACP harness smoke test — drives Cicero's real AcpBrain against any agent
 * binary to verify it can be a Cicero brain.
 *
 *   bun scripts/acp-smoke.ts hermes hermes -p voice acp
 *   bun scripts/acp-smoke.ts claude-code bun x @zed-industries/claude-code-acp@0.16.2
 *   bun scripts/acp-smoke.ts gemini gemini --acp
 *   bun scripts/acp-smoke.ts openclaw openclaw acp
 *
 * PASS = spawn → initialize/newSession handshake → a streamed prompt reply.
 */
import { AcpBrain } from "../src/brain/acp";

const [label, binary, ...args] = process.argv.slice(2);
if (!label || !binary) {
  console.error("usage: bun scripts/acp-smoke.ts <label> <binary> [args...]");
  process.exit(2);
}

const brain = new AcpBrain({
  binary,
  args,
  autoApproveTools: true,
  startTimeoutMs: 60_000,
  // Nested-session guards: claude-code-acp refuses to start inside Claude Code.
  unsetEnv: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"],
});

const t0 = Date.now();
try {
  await brain.start();
  console.log(`[${label}] handshake OK in ${Date.now() - t0}ms`);
  const t1 = Date.now();
  let chunks = 0;
  let firstChunkMs = -1;
  let out = "";
  for await (const chunk of brain.sendStream("Reply with exactly: ok")) {
    if (firstChunkMs < 0) firstChunkMs = Date.now() - t1;
    chunks++;
    out += chunk;
    if (out.length > 400) break; // enough to prove streaming
  }
  console.log(`[${label}] streamed ${chunks} chunk(s), first at ${firstChunkMs}ms, reply: ${JSON.stringify(out.trim().slice(0, 120))}`);
  console.log(`[${label}] PASS`);
} catch (err) {
  console.error(`[${label}] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await brain.stop();
}
