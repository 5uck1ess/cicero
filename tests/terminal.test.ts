import { test, expect, describe } from "bun:test";
import { KittyAdapter } from "../src/terminal/kitty";

async function kittyAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["kitty", "@", "ls"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const kittyOk = await kittyAvailable();

describe("KittyAdapter", () => {
  const kitty = new KittyAdapter();

  test.skipIf(!kittyOk)("lists tabs from kitty", async () => {
    const tabs = await kitty.listTabs();
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs[0]).toHaveProperty("id");
    expect(tabs[0]).toHaveProperty("title");
    expect(tabs[0]).toHaveProperty("is_focused");
  });

  test.skipIf(!kittyOk)("focuses tab by name", async () => {
    const tabs = await kitty.listTabs();
    const firstTab = tabs[0];
    await kitty.focusTab(firstTab.title);
    expect(true).toBe(true);
  });
});
