import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Uses os.homedir() not process.env.HOME — HOME is usually unset on Windows
// (which resolves the home dir from USERPROFILE instead).

/** Root Cicero config/data directory (`<home>/.cicero`), resolved cross-platform. */
export function ciceroHome(): string {
  return join(homedir(), ".cicero");
}

/** Path inside the Cicero home dir, e.g. ciceroPath("voices", "alice"). */
export function ciceroPath(...segments: string[]): string {
  return join(ciceroHome(), ...segments);
}

/** Path inside the OS temp dir (cross-platform) — never hardcode /tmp. */
export function tempPath(name: string): string {
  return join(tmpdir(), name);
}
