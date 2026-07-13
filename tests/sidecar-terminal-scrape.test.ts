import { test, expect, mock } from "bun:test";
import { TerminalScrapeAdapter } from "../src/sidecar/terminal-scrape";
import type { SpeakService } from "../src/sidecar/types";
import type { TerminalAdapter, Tab } from "../src/types";

function makeTerminalAdapter(textSequence: string[]): TerminalAdapter {
  let i = 0;
  return {
    listTabs: mock(async (): Promise<Tab[]> => [{ id: "1", title: "test", is_focused: false }]),
    focusTab: mock(async () => {}),
    sendText: mock(async () => {}),
    sendKey: mock(async () => {}),
    getText: mock(async () => textSequence[Math.min(i++, textSequence.length - 1)]),
  } as unknown as TerminalAdapter;
}

const makeService = (): SpeakService => ({
  speak: mock(async () => {}),
  stop: mock(async () => {}),
});

test("speaks new content appearing between polls", async () => {
  const terminal = makeTerminalAdapter([
    "$ claude\n> ",
    "$ claude\n> what time is it\nIt's 3pm.\n> ",
  ]);
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 30,
    promptMarker: /^> $/m,
  });
  const svc = makeService();

  await adapter.attach(svc);
  await new Promise(r => setTimeout(r, 80));
  await adapter.detach();

  expect(svc.speak).toHaveBeenCalledTimes(1);
  const call = (svc.speak as ReturnType<typeof mock>).mock.calls[0][0];
  expect(call.text).toContain("It's 3pm.");
  expect(call.agent).toBe("terminal-scrape");
});

test("does not speak when terminal text is unchanged", async () => {
  const terminal = makeTerminalAdapter(["$ claude\n> "]);
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 30,
    promptMarker: /^> $/m,
  });
  const svc = makeService();

  await adapter.attach(svc);
  await new Promise(r => setTimeout(r, 60));
  await adapter.detach();

  expect(svc.speak).not.toHaveBeenCalled();
});

test("detach stops the polling loop", async () => {
  const getTextMock = mock(async () => "$ \n> ");
  const terminal = { getText: getTextMock, listTabs: mock(async () => []) } as unknown as TerminalAdapter;
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 20,
    promptMarker: /^> $/m,
  });
  await adapter.attach(makeService());
  await adapter.detach();

  const callCountAtDetach = getTextMock.mock.calls.length;
  await new Promise(r => setTimeout(r, 50));
  expect(getTextMock.mock.calls.length).toBe(callCountAtDetach);
});

test("health flips to unhealthy after consecutive getText failures", async () => {
  const getTextMock = mock(async () => {
    throw new Error("kitty socket gone");
  });
  const terminal = { getText: getTextMock, listTabs: mock(async () => []) } as unknown as TerminalAdapter;
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 20,
    promptMarker: /^> $/m,
    unhealthyThreshold: 3,
  });

  await adapter.attach(makeService());
  // First call (during attach) already failed → 1 failure recorded
  await new Promise(r => setTimeout(r, 50)); // ≥ 3 more ticks at 10ms

  const h = await adapter.health();
  expect(h.ok).toBe(false);
  expect(h.reason).toContain("kitty socket gone");

  await adapter.detach();
});

test("health recovers after getText starts succeeding again", async () => {
  let failCount = 0;
  const getTextMock = mock(async () => {
    if (failCount < 4) {
      failCount += 1;
      throw new Error("transient");
    }
    return "$\n> ";
  });
  const terminal = { getText: getTextMock, listTabs: mock(async () => []) } as unknown as TerminalAdapter;
  const adapter = new TerminalScrapeAdapter({
    terminal,
    targetTab: "1",
    pollIntervalMs: 10,
    quietWindowMs: 20,
    promptMarker: /^> $/m,
    unhealthyThreshold: 3,
  });

  await adapter.attach(makeService());
  // Wait until at least one successful getText runs
  await new Promise(r => setTimeout(r, 100));

  const h = await adapter.health();
  expect(h.ok).toBe(true);

  await adapter.detach();
});
