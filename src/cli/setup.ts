import { resolve } from "node:path";
import { ciceroHome } from "../platform/paths";
import { waitForShutdown } from "../process-lifecycle";
import { startSetupServer } from "../setup/server";
import { readBoundedText } from "../setup/read-bounded";

export interface SetupCliOptions {
  home?: string; lan?: boolean; port?: string;
  plan?: boolean; apply?: string; test?: boolean; json?: boolean;
  privacy?: string; agent?: string; acknowledgeNotReady?: boolean; backupInvalid?: boolean;
}

/** Exit codes for the headless modes: 0 ok, 1 rejected or blocked, 2 usage. */
export class SetupUsageError extends Error {}

const ANSWERS_LIMIT = 256 * 1024;

export async function runSetup(options: SetupCliOptions, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const modes = [options.plan, options.apply !== undefined, options.test].filter(Boolean).length;
  if (modes > 1) throw new SetupUsageError("--plan, --apply and --test are mutually exclusive");
  const home = resolve(options.home ?? ciceroHome());
  if (options.plan) {
    if (!options.json) throw new SetupUsageError("--plan requires --json");
    if (options.privacy !== "local" && options.privacy !== "cloud") throw new SetupUsageError("--plan requires --privacy local or --privacy cloud");
    const { planSetup } = await import("../setup/headless");
    const plan = await planSetup({ privacy: options.privacy, ...(options.agent ? { agent: options.agent } : {}) });
    write(JSON.stringify(plan, null, 2));
    return plan.blocked.length ? 1 : 0;
  }
  if (options.apply !== undefined) {
    let answers: unknown;
    try {
      answers = JSON.parse(readBoundedText(options.apply, ANSWERS_LIMIT, "the answers file"));
    } catch (error) { throw new SetupUsageError(`Cannot read ${options.apply}: ${error instanceof Error ? error.message : String(error)}`); }
    const { applySetup } = await import("../setup/headless");
    const result = await applySetup({ home, answers, acknowledgeNotReady: options.acknowledgeNotReady === true, backupInvalid: options.backupInvalid === true });
    if (options.json) write(JSON.stringify(result, null, 2));
    else write(result.ok ? `Wrote ${result.written}${result.backup ? ` (backed up the invalid config to ${result.backup})` : ""}` : `Setup stopped${result.step ? ` at ${result.step}` : ""}: ${result.error}`);
    return result.ok ? 0 : 1;
  }
  if (options.test) {
    if (!options.json) throw new SetupUsageError("--test requires --json");
    const { testSetup } = await import("../setup/headless");
    const results = await testSetup({ home });
    write(JSON.stringify({ version: 1, results }, null, 2));
    return results.some((r) => r.state === "failed" || r.state === "timeout" || r.state === "not running") ? 1 : 0;
  }
  if (options.json) throw new SetupUsageError("--json needs --plan, --apply or --test");
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new SetupUsageError("--port must be an integer from 0 to 65535");
  const server = await startSetupServer({ home, lan: options.lan, port });
  await waitForShutdown(server, process, server.closed);
  return 0;
}
