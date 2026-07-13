import type { Tool } from "../tool";
import type { Browser as PlaywrightBrowser } from "playwright";
import {
  assertPublicBrowserAddress,
  authorizeBrowserUrl,
  BrowserUrlPolicyError,
  type BrowserHostResolver,
} from "../browser-policy";

export type BrowserUrlGuard = (url: string) => Promise<string>;

export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  readText(): Promise<string>;
  currentUrl(): string | Promise<string>;
  close(): Promise<void>;
}

export type BrowserDriverFactory = (guardUrl: BrowserUrlGuard) => Promise<BrowserDriver>;

export interface BrowserToolOptions {
  /** DNS override for deterministic tests; production resolves every hostname. */
  resolveHost?: BrowserHostResolver;
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

async function configurePlaywrightDriver(
  browser: PlaywrightBrowser,
  guardUrl: BrowserUrlGuard,
): Promise<BrowserDriver> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let blocked: Error | null = null;
  const responseChecks = new Set<Promise<void>>();

  const recordBlocked = (err: unknown): void => {
    blocked ??= errorOf(err);
  };
  const drainResponseChecks = async (): Promise<void> => {
    while (responseChecks.size > 0) {
      await Promise.all([...responseChecks]);
    }
  };
  const throwIfBlocked = async (): Promise<void> => {
    await drainResponseChecks();
    if (!blocked) return;
    const error = blocked;
    blocked = null;
    throw error;
  };
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    await throwIfBlocked();
    try {
      const result = await operation();
      await throwIfBlocked();
      return result;
    } catch (err: unknown) {
      // A route handler can reject a redirect/subrequest while Playwright reports
      // only a generic navigation error. Prefer the policy cause when one exists.
      await throwIfBlocked();
      throw err;
    }
  };

  // Context-wide routing covers redirects, frames, popups, and subresources.
  // Service workers are disabled above because Playwright cannot route requests
  // they handle internally.
  await context.route("**/*", async (route, request) => {
    try {
      await guardUrl(request.url());
      await route.continue();
    } catch (err: unknown) {
      recordBlocked(err);
      try {
        await route.abort("blockedbyclient");
      } catch (abortErr: unknown) {
        recordBlocked(new Error(`failed to abort blocked browser request: ${errorOf(abortErr).message}`));
      }
    }
  });

  // WebSockets are a separate Playwright transport and do not pass through the
  // HTTP route above. The browser tool intentionally permits HTTP(S) only.
  await context.routeWebSocket("**/*", async (socket) => {
    recordBlocked(new BrowserUrlPolicyError(`browser WebSocket subrequest is blocked: ${socket.url()}`));
    try {
      await socket.close({ code: 1008, reason: "Cicero browser permits HTTP(S) only" });
    } catch (err: unknown) {
      recordBlocked(new Error(`failed to close blocked browser WebSocket: ${errorOf(err).message}`));
    }
  });

  const page = await context.newPage();
  page.on("response", (response) => {
    let check: Promise<void>;
    check = response.serverAddr()
      .then((address) => {
        if (address) {
          assertPublicBrowserAddress(address.ipAddress, `browser response from ${response.url()}`);
        }
      })
      .catch((err: unknown) => {
        recordBlocked(new BrowserUrlPolicyError(`browser response address verification failed: ${errorOf(err).message}`));
      })
      .finally(() => { responseChecks.delete(check); });
    responseChecks.add(check);
  });

  return {
    async navigate(url) {
      await guarded(async () => { await page.goto(url, { waitUntil: "domcontentloaded" }); });
    },
    async click(selector) {
      await guarded(async () => { await page.click(selector); });
    },
    async type(selector, text) {
      await guarded(async () => { await page.fill(selector, text); });
    },
    async readText() {
      return guarded(async () => (await page.innerText("body")).slice(0, 4000));
    },
    currentUrl() { return page.url(); },
    async close() {
      const errors: Error[] = [];
      try {
        await throwIfBlocked();
      } catch (err: unknown) {
        errors.push(errorOf(err));
      }
      try {
        await browser.close();
      } catch (err: unknown) {
        errors.push(errorOf(err));
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "browser policy check and cleanup both failed");
    },
  };
}

/** Default driver factory: launches Chromium via Playwright. Lazy-imported so the
 *  dependency is only required when the browser tool actually runs. */
async function launchPlaywrightDriver(guardUrl: BrowserUrlGuard): Promise<BrowserDriver> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    return await configurePlaywrightDriver(browser, guardUrl);
  } catch (err: unknown) {
    const setupError = errorOf(err);
    try {
      await browser.close();
    } catch (closeErr: unknown) {
      throw new AggregateError(
        [setupError, errorOf(closeErr)],
        "browser setup and cleanup both failed",
      );
    }
    throw setupError;
  }
}

export function createBrowserTool(
  makeDriver: BrowserDriverFactory = launchPlaywrightDriver,
  options: BrowserToolOptions = {},
): Tool {
  let driver: BrowserDriver | null = null;
  let currentUrl: string | null = null;
  const guardUrl: BrowserUrlGuard = (url) => options.resolveHost
    ? authorizeBrowserUrl(url, options.resolveHost)
    : authorizeBrowserUrl(url);
  const ensure = async (): Promise<BrowserDriver> => (driver ??= await makeDriver(guardUrl));
  const safeCurrentUrl = async (d: BrowserDriver): Promise<string> => {
    const safe = await guardUrl(await d.currentUrl());
    currentUrl = safe;
    return safe;
  };
  const requireCurrentUrl = async (action: string): Promise<string> => {
    if (!driver || !currentUrl) {
      throw new BrowserUrlPolicyError(`navigate to a safe HTTP(S) URL before browser ${action}`);
    }
    try {
      return await safeCurrentUrl(driver);
    } catch (err: unknown) {
      currentUrl = null;
      throw err;
    }
  };
  const assertConfirmedUrl = async (
    args: Record<string, unknown>,
    actualUrl: string,
    action: string,
  ): Promise<void> => {
    try {
      if (args.expectedCurrentUrl === undefined) return;
      const expectedUrl = await guardUrl(String(args.expectedCurrentUrl));
      if (actualUrl !== expectedUrl) {
        throw new BrowserUrlPolicyError(
          `browser page changed from ${expectedUrl} to ${actualUrl} after ${action} confirmation`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof BrowserUrlPolicyError) throw err;
      throw new BrowserUrlPolicyError(
        `browser ${action} confirmation URL verification failed: ${errorOf(err).message}`,
      );
    }
  };

  return {
    name: "browser",
    description: "control a public HTTP(S) web page: navigate|click|type|read",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "click", "type", "read"] },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    },
    async prepare(args) {
      const action = String(args.action ?? "");
      switch (action) {
        case "navigate": {
          const target = await guardUrl(String(args.url ?? ""));
          return {
            args: { ...args, action, url: target },
            confirmation: `navigate browser from ${currentUrl ?? "(no page)"} to ${target}`,
          };
        }
        case "click": {
          const pageUrl = await requireCurrentUrl(action);
          const selector = String(args.selector ?? "").trim();
          if (!selector) throw new Error("browser click requires a selector");
          return {
            args: { ...args, action, selector, expectedCurrentUrl: pageUrl },
            confirmation: `click ${selector} on ${pageUrl}`,
          };
        }
        case "type": {
          const pageUrl = await requireCurrentUrl(action);
          const selector = String(args.selector ?? "").trim();
          if (!selector) throw new Error("browser type requires a selector");
          const text = String(args.text ?? "");
          return {
            args: { ...args, action, selector, text, expectedCurrentUrl: pageUrl },
            confirmation: `type ${JSON.stringify(text)} into ${selector} on ${pageUrl}`,
          };
        }
        case "read": {
          const pageUrl = await requireCurrentUrl(action);
          return {
            args: { ...args, action, expectedCurrentUrl: pageUrl },
            confirmation: `read browser page at ${pageUrl}`,
          };
        }
        default:
          throw new Error(`unknown browser action '${action}'`);
      }
    },
    async run(args) {
      const action = String(args.action ?? "");
      try {
        switch (action) {
          case "navigate": {
            const target = await guardUrl(String(args.url ?? ""));
            const d = await ensure();
            await d.navigate(target);
            const finalUrl = await safeCurrentUrl(d);
            return { ok: true, output: `navigated to ${finalUrl}` };
          }
          case "click": {
            const d = await ensure();
            const before = await safeCurrentUrl(d);
            await assertConfirmedUrl(args, before, action);
            const selector = String(args.selector ?? "");
            await d.click(selector);
            const finalUrl = await safeCurrentUrl(d);
            return { ok: true, output: `clicked ${selector} on ${before}; current URL ${finalUrl}` };
          }
          case "type": {
            const d = await ensure();
            const before = await safeCurrentUrl(d);
            await assertConfirmedUrl(args, before, action);
            const selector = String(args.selector ?? "");
            await d.type(selector, String(args.text ?? ""));
            const finalUrl = await safeCurrentUrl(d);
            return { ok: true, output: `typed into ${selector} on ${before}; current URL ${finalUrl}` };
          }
          case "read": {
            const d = await ensure();
            const before = await safeCurrentUrl(d);
            await assertConfirmedUrl(args, before, action);
            const text = await d.readText();
            const finalUrl = await safeCurrentUrl(d);
            return { ok: true, output: `URL: ${finalUrl || before}\n${text}` };
          }
          default:
            return { ok: false, output: `unknown browser action '${action}'` };
        }
      } catch (err: unknown) {
        // After any failed action the actual page may differ from the last
        // authorized one. Require another explicit navigate before reuse.
        currentUrl = null;
        return { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
    },
    async dispose() {
      currentUrl = null;
      if (!driver) return; // never launched — nothing to close
      const d = driver;
      driver = null;
      await d.close();
    },
  };
}
