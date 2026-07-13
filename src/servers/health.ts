import { PROVIDER_TIMEOUT_MS, providerSignal, responseIsOk } from "../backends/http-transfer";

export class HealthChecker {
  async waitForHealth(url: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const res = await fetch(url, {
          signal: providerSignal(Math.min(PROVIDER_TIMEOUT_MS.health, remainingMs)),
        });
        if (await responseIsOk(res)) return true;
      } catch {}
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await Bun.sleep(Math.min(Math.max(0, intervalMs), remainingMs));
    }

    return false;
  }

  async check(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: providerSignal(PROVIDER_TIMEOUT_MS.health) });
      return await responseIsOk(res);
    } catch {
      return false;
    }
  }
}
