import { resolve } from "node:path";
import { ciceroHome } from "../platform/paths";
import { waitForShutdown } from "../process-lifecycle";
import { startSetupServer } from "../setup/server";

export interface SetupCliOptions { home?: string; lan?: boolean; port?: string }

export async function runSetup(options: SetupCliOptions): Promise<void> {
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  const home = resolve(options.home ?? ciceroHome());
  const server = await startSetupServer({ home, lan: options.lan, port });
  await waitForShutdown(server, process, server.closed);
}
