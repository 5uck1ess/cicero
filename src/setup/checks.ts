import type { Check } from "../cli/doctor";

export interface SetupCheckGroups {
  blocking: Check[];
  notReady: Check[];
  warnings: Check[];
  ok: Check[];
}

const CONFIG_CHECKS = new Set(["config", "web_voice token", "web_voice TLS"]);

/** Config failures block Write; runtime failures require an explicit acknowledgement. */
export function classifySetupChecks(checks: readonly Check[]): SetupCheckGroups {
  const groups: SetupCheckGroups = { blocking: [], notReady: [], warnings: [], ok: [] };
  for (const check of checks) {
    if (check.level === "ok") groups.ok.push(check);
    else if (check.level === "warn") groups.warnings.push(check);
    else if (CONFIG_CHECKS.has(check.name)) groups.blocking.push(check);
    else groups.notReady.push(check);
  }
  return groups;
}
