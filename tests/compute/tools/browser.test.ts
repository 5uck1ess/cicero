import { test, expect } from "bun:test";
import {
  createBrowserTool,
  type BrowserDriver,
  type BrowserUrlGuard,
} from "../../../src/compute/tools/browser";

const publicResolver = async (): Promise<readonly string[]> => ["93.184.216.34"];

function fakeDriver(initialUrl = "about:blank"): {
  driver: BrowserDriver;
  calls: string[];
  setCurrentUrl(url: string): void;
} {
  const calls: string[] = [];
  let currentUrl = initialUrl;
  const driver: BrowserDriver = {
    async navigate(url) { calls.push(`navigate:${url}`); currentUrl = url; },
    async click(selector) { calls.push(`click:${selector}`); },
    async type(selector, text) { calls.push(`type:${selector}:${text}`); },
    async readText() { calls.push("readText"); return "page body text"; },
    currentUrl() { return currentUrl; },
    async close() { calls.push("close"); },
  };
  return { driver, calls, setCurrentUrl: (url) => { currentUrl = url; } };
}

function toolWith(driver: BrowserDriver) {
  return createBrowserTool(async () => driver, { resolveHost: publicResolver });
}

test("browser navigate dispatches to the driver and reports the final URL", async () => {
  const { driver, calls } = fakeDriver();
  const tool = toolWith(driver);
  const result = await tool.run({ action: "navigate", url: "https://example.com/start" });
  expect(result.ok).toBe(true);
  expect(calls).toContain("navigate:https://example.com/start");
  expect(result.output).toBe("navigated to https://example.com/start");
});

test("browser read returns page text with its verified current URL", async () => {
  const { driver } = fakeDriver();
  const tool = toolWith(driver);
  await tool.run({ action: "navigate", url: "https://example.com" });
  const result = await tool.run({ action: "read" });
  expect(result.output).toContain("URL: https://example.com/");
  expect(result.output).toContain("page body text");
});

test("browser type fills the selector with text", async () => {
  const { driver, calls } = fakeDriver();
  const tool = toolWith(driver);
  await tool.run({ action: "navigate", url: "https://example.com" });
  const result = await tool.run({ action: "type", selector: "#q", text: "cicero" });
  expect(result.ok).toBe(true);
  expect(calls).toContain("type:#q:cicero");
  expect(result.output).toContain("https://example.com/");
});

test("the driver is created once and reused across actions", async () => {
  let made = 0;
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async () => { made++; return driver; }, { resolveHost: publicResolver });
  await tool.run({ action: "navigate", url: "https://example.com" });
  await tool.run({ action: "read" });
  expect(made).toBe(1);
});

test("dispose closes the driver after it was launched", async () => {
  const { driver, calls } = fakeDriver();
  const tool = toolWith(driver);
  await tool.run({ action: "navigate", url: "https://example.com" });
  await tool.dispose?.();
  expect(calls).toContain("close");
});

test("dispose is a no-op when the driver was never launched", async () => {
  let made = 0;
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async () => { made++; return driver; }, { resolveHost: publicResolver });
  await tool.dispose?.();
  expect(made).toBe(0);
});

test("an unknown browser action returns ok=false", async () => {
  const { driver } = fakeDriver();
  const tool = toolWith(driver);
  const result = await tool.run({ action: "teleport" });
  expect(result.ok).toBe(false);
});

test("a driver error is caught and returned as ok=false", async () => {
  const driver: BrowserDriver = {
    async navigate() { throw new Error("net::ERR_NAME_NOT_RESOLVED"); },
    async click() {}, async type() {}, async readText() { return ""; },
    currentUrl() { return "about:blank"; }, async close() {},
  };
  const tool = toolWith(driver);
  const result = await tool.run({ action: "navigate", url: "https://nope.invalid" });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("ERR_NAME_NOT_RESOLVED");
});

test("file URLs are rejected before a browser process is created", async () => {
  let made = 0;
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async () => { made++; return driver; }, { resolveHost: publicResolver });
  const result = await tool.run({ action: "navigate", url: "file:///etc/passwd" });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("only HTTP(S) is allowed");
  expect(made).toBe(0);
});

test("a public URL redirecting to loopback fails final-URL verification", async () => {
  const { driver, setCurrentUrl } = fakeDriver();
  driver.navigate = async () => { setCurrentUrl("http://127.0.0.1/admin"); };
  const tool = toolWith(driver);
  const result = await tool.run({ action: "navigate", url: "https://redirect.example/start" });
  expect(result.ok).toBe(false);
  expect(result.output).toContain("blocked local/private address 127.0.0.1");
});

test("navigation reports the driver's verified final URL, not the requested URL", async () => {
  const { driver, setCurrentUrl } = fakeDriver();
  driver.navigate = async () => { setCurrentUrl("https://final.example/landing"); };
  const tool = toolWith(driver);
  const result = await tool.run({ action: "navigate", url: "https://start.example" });
  expect(result.ok).toBe(true);
  expect(result.output).toBe("navigated to https://final.example/landing");
});

test("the driver receives the same guard used for redirects and subrequests", async () => {
  let capturedGuard: BrowserUrlGuard | null = null;
  const { driver } = fakeDriver();
  const tool = createBrowserTool(async (guard) => {
    capturedGuard = guard;
    return driver;
  }, { resolveHost: publicResolver });
  await tool.run({ action: "navigate", url: "https://example.com" });
  expect(capturedGuard).not.toBeNull();
  await expect(capturedGuard!("http://169.254.169.254/latest/meta-data"))
    .rejects.toThrow("blocked local/private address");
});

test("preflight confirmation summaries include trusted target and current URLs", async () => {
  const { driver } = fakeDriver();
  const tool = toolWith(driver);
  const nav = await tool.prepare?.({ action: "navigate", url: "https://example.com/start" });
  expect(nav?.confirmation).toContain("to https://example.com/start");

  await tool.run(nav!.args);
  const read = await tool.prepare?.({ action: "read" });
  const click = await tool.prepare?.({ action: "click", selector: "#submit" });
  const type = await tool.prepare?.({ action: "type", selector: "#q", text: "cicero" });
  expect(read?.confirmation).toContain("https://example.com/start");
  expect(click?.confirmation).toContain("#submit on https://example.com/start");
  expect(type?.confirmation).toContain("#q on https://example.com/start");
});

test("a page action is rejected if the URL changes after confirmation", async () => {
  const { driver, calls, setCurrentUrl } = fakeDriver();
  const tool = toolWith(driver);
  await tool.run({ action: "navigate", url: "https://example.com/account" });
  const prepared = await tool.prepare?.({ action: "click", selector: "#approve" });
  setCurrentUrl("https://attacker.example/decoy");

  const result = await tool.run(prepared!.args);
  expect(result.ok).toBe(false);
  expect(result.output).toContain("changed from https://example.com/account");
  expect(calls).not.toContain("click:#approve");
});

test("page actions fail closed before the first safe navigation", async () => {
  const { driver } = fakeDriver();
  const tool = toolWith(driver);
  await expect(tool.prepare?.({ action: "read" })).rejects.toThrow("navigate to a safe HTTP(S) URL");
});
