import type { BackendProviderSet } from "../backends/registry";
import { log } from "../logger";
import type {
  BackendRole,
  BackendStartupPolicies,
  BackendStartupPolicy,
} from "./startup-policy";

interface ManagedProvider {
  readonly name: string;
  health(): Promise<boolean>;
  requiredHealth?(): Promise<boolean>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export class ServerManager {
  async start(
    providers: BackendProviderSet,
    policies: BackendStartupPolicies = {},
  ): Promise<void> {
    for (const [role, provider] of providerEntries(providers)) {
      const policy = policies[role];
      if (policy?.startupNotice) log("info", policy.startupNotice);
      if (policy?.skipReason) {
        log("info", policy.skipReason);
        continue;
      }
      if (policy?.required && policy.blockedReason) {
        throw requiredProviderError(
          role,
          policy,
          `cannot start on this platform: ${policy.blockedReason}`,
        );
      }

      if (provider.start) {
        try {
          await provider.start();
        } catch (error: unknown) {
          if (policy?.required) {
            throw requiredProviderError(role, policy, "failed to start", error);
          }
          log("warn", `${role} provider failed to start: ${errorDetail(error)}`);
        }
      }

      if (policy?.required) {
        await assertRequiredProviderHealthy(role, provider, policy);
        log("ok", `${role} configured primary ready (${policy.configKey}='${policy.backend}')`);
      }
    }

    // Optional pre-warm probes stay best-effort. Required primaries were
    // already checked above, so do not probe them twice during startup.
    await this.prewarm(providers, policies);
  }

  /**
   * `--no-servers` suppresses launches, not validation of explicitly
   * configured primaries. A remote or externally managed required provider
   * must still be reachable before the daemon advertises readiness.
   */
  async verifyRequired(
    providers: BackendProviderSet,
    policies: BackendStartupPolicies,
  ): Promise<void> {
    try {
      for (const [role, provider] of providerEntries(providers)) {
        const policy = policies[role];
        if (!policy?.required || policy.skipReason) continue;
        if (policy.blockedReason) {
          throw requiredProviderError(
            role,
            policy,
            `cannot run on this platform: ${policy.blockedReason}`,
          );
        }
        await assertRequiredProviderHealthy(role, provider, policy);
        log("ok", `${role} configured primary reachable (${policy.configKey}='${policy.backend}')`);
      }
    } catch (error: unknown) {
      if (isRequiredProviderError(error)) throw error;
      throw new Error(`Required provider verification failed: ${errorDetail(error)}`, { cause: error });
    }
  }

  private async prewarm(
    providers: BackendProviderSet,
    policies: BackendStartupPolicies,
  ): Promise<void> {
    const configured = providerEntries(providers).filter(([role]) => {
      const policy = policies[role];
      return !policy?.skipReason && !policy?.required;
    });
    const results = await Promise.allSettled(
      configured.map(([, provider]) => provider.health()),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result?.status === "fulfilled" && result.value) {
        log("ok", `${configured[index]![0]} pre-warm: healthy`);
      }
    }
  }

  async stop(providers: BackendProviderSet): Promise<void> {
    for (const provider of [providers.stt, providers.tts, providers.llm]) {
      if (provider?.stop) {
        try {
          await provider.stop();
        } catch (error: unknown) {
          log("info", `Provider stop failed (best effort): ${errorDetail(error)}`);
        }
      }
    }
  }
}

async function assertRequiredProviderHealthy(
  role: BackendRole,
  provider: ManagedProvider,
  policy: BackendStartupPolicy,
): Promise<void> {
  try {
    const healthy = provider.requiredHealth
      ? await provider.requiredHealth()
      : await provider.health();
    if (!healthy) {
      throw requiredProviderError(role, policy, "failed its health check");
    }
  } catch (error: unknown) {
    if (isRequiredProviderError(error)) throw error;
    throw requiredProviderError(role, policy, "health check failed", error);
  }
}

function requiredProviderError(
  role: BackendRole,
  policy: BackendStartupPolicy,
  failure: string,
  cause?: unknown,
): Error {
  const causeText = cause === undefined ? "" : `: ${errorDetail(cause)}`;
  const valid = policy.validValues
    ? ` Valid values for ${policy.configKey}: ${policy.validValues.join(", ")}.`
    : ` Check the provider or plugin configuration for ${policy.configKey}.`;
  const message = `Configured ${role.toUpperCase()} primary ${policy.configKey}='${policy.backend}' ${failure}${causeText}.${valid} Run \`cicero doctor\` for backend diagnostics.`;
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "RequiredProviderStartupError";
  return error;
}

function isRequiredProviderError(error: unknown): error is Error {
  return error instanceof Error && error.name === "RequiredProviderStartupError";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerEntries(
  providers: BackendProviderSet,
): Array<readonly [BackendRole, ManagedProvider]> {
  const entries: Array<readonly [BackendRole, ManagedProvider]> = [];
  if (providers.llm) entries.push(["llm", providers.llm]);
  if (providers.tts) entries.push(["tts", providers.tts]);
  if (providers.stt) entries.push(["stt", providers.stt]);
  return entries;
}

export type {
  BackendRole,
  BackendStartupPolicies,
  BackendStartupPolicy,
} from "./startup-policy";
export { createBackendStartupPolicies } from "./startup-policy";
