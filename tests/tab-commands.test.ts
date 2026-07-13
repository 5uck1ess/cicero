import { test, expect, describe } from "bun:test";
import {
  cleanTabName,
  isVagueTabName,
  expandAliases,
  parseTabCommand,
} from "../src/tab-parser";

describe("cleanTabName", () => {
  test("strips trailing 'tab' word", () => {
    expect(cleanTabName("working tab")).toBe("working");
  });

  test("strips trailing 'Tab' (case insensitive)", () => {
    expect(cleanTabName("Sales Tab")).toBe("Sales");
  });

  test("strips 'the' from name", () => {
    expect(cleanTabName("the working")).toBe("working");
  });

  test("strips trailing punctuation", () => {
    expect(cleanTabName("sales.")).toBe("sales");
    expect(cleanTabName("sales!")).toBe("sales");
    expect(cleanTabName("sales?")).toBe("sales");
  });

  test("handles combined cleanup", () => {
    expect(cleanTabName("the sales tab.")).toBe("sales");
  });

  test("preserves multi-word names", () => {
    expect(cleanTabName("PM tools")).toBe("PM tools");
  });

  test("trims whitespace", () => {
    expect(cleanTabName("  sales  ")).toBe("sales");
  });

  test("returns empty for just 'tab'", () => {
    expect(cleanTabName("tab")).toBe("");
  });

  test("returns empty for just 'the tab'", () => {
    expect(cleanTabName("the tab")).toBe("");
  });
});

describe("isVagueTabName", () => {
  test("rejects 'a different'", () => {
    expect(isVagueTabName("a different")).toBe(true);
  });

  test("rejects 'another'", () => {
    expect(isVagueTabName("another")).toBe(true);
  });

  test("rejects 'something'", () => {
    expect(isVagueTabName("something")).toBe(true);
  });

  test("rejects 'some other'", () => {
    expect(isVagueTabName("some other")).toBe(true);
  });

  test("rejects 'different'", () => {
    expect(isVagueTabName("different")).toBe(true);
  });

  test("rejects 'other'", () => {
    expect(isVagueTabName("other")).toBe(true);
  });

  test("rejects 'new'", () => {
    expect(isVagueTabName("new")).toBe(true);
  });

  test("rejects 'that'", () => {
    expect(isVagueTabName("that")).toBe(true);
  });

  test("rejects 'this'", () => {
    expect(isVagueTabName("this")).toBe(true);
  });

  test("rejects 'next'", () => {
    expect(isVagueTabName("next")).toBe(true);
  });

  test("rejects 'previous'", () => {
    expect(isVagueTabName("previous")).toBe(true);
  });

  test("rejects 'a new'", () => {
    expect(isVagueTabName("a new")).toBe(true);
  });

  test("rejects 'any'", () => {
    expect(isVagueTabName("any")).toBe(true);
  });

  test("rejects 'some'", () => {
    expect(isVagueTabName("some")).toBe(true);
  });

  test("rejects 'one'", () => {
    expect(isVagueTabName("one")).toBe(true);
  });

  test("rejects 'it'", () => {
    expect(isVagueTabName("it")).toBe(true);
  });

  test("accepts 'sales'", () => {
    expect(isVagueTabName("sales")).toBe(false);
  });

  test("accepts 'working'", () => {
    expect(isVagueTabName("working")).toBe(false);
  });

  test("accepts 'PM tools'", () => {
    expect(isVagueTabName("PM tools")).toBe(false);
  });

  test("accepts 'cicero-brain'", () => {
    expect(isVagueTabName("cicero-brain")).toBe(false);
  });

  test("accepts numeric tab id", () => {
    expect(isVagueTabName("42")).toBe(false);
  });
});

describe("expandAliases", () => {
  const aliases = {
    tabs: ["tubs", "hubs", "taps", "tops"],
    tab: ["tub", "hub", "tap", "top", "time", "tam", "type"],
    switch: ["swish", "stitch"],
    list: ["least", "last"],
  };

  test("expands single alias", () => {
    expect(expandAliases("show my tubs", aliases)).toBe("show my tabs");
  });

  test("expands multiple aliases in one phrase", () => {
    expect(expandAliases("stitch to sales tub", aliases)).toBe("switch to sales tab");
  });

  test("leaves non-alias text unchanged", () => {
    expect(expandAliases("check my email", aliases)).toBe("check my email");
  });

  test("handles case insensitivity", () => {
    expect(expandAliases("STITCH to SALES TUB", aliases)).toBe("switch to SALES tab");
  });

  test("empty aliases object doesn't modify text", () => {
    expect(expandAliases("stitch to tub", {})).toBe("stitch to tub");
  });

  test("treats regex punctuation and replacement tokens as literal config", () => {
    expect(expandAliases("switch to c++", { compiler: ["c++"] })).toBe("switch to compiler");
    expect(expandAliases("show cash", { "$&-literal": ["cash"] })).toBe("show $&-literal");
    expect(expandAliases("sc++ope", { compiler: ["c++"] })).toBe("sc++ope");
  });
});

describe("parseTabCommand — valid tab switches", () => {
  test("'switch to working' → switch to 'working'", () => {
    const result = parseTabCommand("switch to working");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("working");
  });

  test("'switch to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("switch to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("sales");
  });

  test("'go to PM tools' → switch to 'PM tools'", () => {
    const result = parseTabCommand("go to pm tools");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("pm tools");
  });

  test("'swap to working' → switch to 'working'", () => {
    const result = parseTabCommand("swap to working");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'jump to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("jump to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'change to working' → switch to 'working'", () => {
    const result = parseTabCommand("change to working");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'move to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("move to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'can you switch to working' → switch to 'working'", () => {
    const result = parseTabCommand("can you switch to working");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("working");
  });

  test("'please switch to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("please switch to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'switch back to working' → switch to 'working'", () => {
    const result = parseTabCommand("switch back to working");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'switch over to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("switch over to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
  });

  test("'use sales tab' → switch to 'sales'", () => {
    const result = parseTabCommand("use sales tab");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("sales");
  });

  test("'switch brain to sales' → switch to 'sales'", () => {
    const result = parseTabCommand("switch brain to sales");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("sales");
  });
});

describe("parseTabCommand — invalid/vague tab switches", () => {
  test("'switch to a different tab' → null (vague)", () => {
    const result = parseTabCommand("switch to a different tab");
    expect(result).toBeNull();
  });

  test("'switch to another tab' → null (vague)", () => {
    const result = parseTabCommand("switch to another tab");
    expect(result).toBeNull();
  });

  test("'switch to something' → null (vague)", () => {
    const result = parseTabCommand("switch to something");
    expect(result).toBeNull();
  });

  test("'go to a different tab' → null (vague)", () => {
    const result = parseTabCommand("go to a different tab");
    expect(result).toBeNull();
  });

  test("'switch to next' → null (vague)", () => {
    const result = parseTabCommand("switch to next");
    expect(result).toBeNull();
  });

  test("'switch to previous' → null (vague)", () => {
    const result = parseTabCommand("switch to previous");
    expect(result).toBeNull();
  });

  test("'switch to some other tab' → null (vague)", () => {
    const result = parseTabCommand("switch to some other tab");
    expect(result).toBeNull();
  });

  test("'switch to new tab' → null (vague)", () => {
    const result = parseTabCommand("switch to new tab");
    expect(result).toBeNull();
  });

  test("'switch to that' → null (vague)", () => {
    const result = parseTabCommand("switch to that");
    expect(result).toBeNull();
  });

  test("'switch to it' → null (vague)", () => {
    const result = parseTabCommand("switch to it");
    expect(result).toBeNull();
  });

  test("unrelated text returns null", () => {
    const result = parseTabCommand("check my email");
    expect(result).toBeNull();
  });

  test("'hello there' returns null", () => {
    const result = parseTabCommand("hello there");
    expect(result).toBeNull();
  });
});

describe("parseTabCommand — tab name cleaning in context", () => {
  test("'switch to working tab' extracts 'working'", () => {
    const result = parseTabCommand("switch to working tab");
    expect(result).not.toBeNull();
    expect((result as any).tabName).toBe("working");
  });

  test("'switch to the sales tab' extracts 'sales'", () => {
    const result = parseTabCommand("switch to the sales tab");
    expect(result).not.toBeNull();
    expect((result as any).tabName).toBe("sales");
  });

  test("'go to the working tab' extracts 'working'", () => {
    const result = parseTabCommand("go to the working tab");
    expect(result).not.toBeNull();
    expect((result as any).tabName).toBe("working");
  });
});

describe("parseTabCommand — switch + action commands", () => {
  test("'switch to sales and check the pipeline' parses both", () => {
    const result = parseTabCommand("switch to sales and check the pipeline");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch_and_do");
    expect((result as any).tabName).toBe("sales");
    expect((result as any).command).toBe("check the pipeline");
  });

  test("'go to working and run my checkin' parses both", () => {
    const result = parseTabCommand("go to working and run my checkin");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch_and_do");
    expect((result as any).tabName).toBe("working");
    expect((result as any).command).toBe("run my checkin");
  });

  test("'switch to a different tab and do something' → null (vague tab)", () => {
    const result = parseTabCommand("switch to a different tab and do something");
    expect(result).toBeNull();
  });
});

describe("parseTabCommand — in-tab commands", () => {
  test("'in PM tools, run my checkin' → in_tab", () => {
    const result = parseTabCommand("in pm tools, run my checkin");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("in_tab");
    expect((result as any).tabName).toBe("pm tools");
    expect((result as any).command).toBe("run my checkin");
  });

  test("'on sales tab, check the pipeline' → in_tab", () => {
    const result = parseTabCommand("on sales tab, check the pipeline");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("in_tab");
    expect((result as any).tabName).toBe("sales");
    expect((result as any).command).toBe("check the pipeline");
  });

  test("'in working, show status' → in_tab", () => {
    const result = parseTabCommand("in working, show status");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("in_tab");
    expect((result as any).tabName).toBe("working");
    expect((result as any).command).toBe("show status");
  });

  test("'in another, do stuff' → null (vague tab)", () => {
    const result = parseTabCommand("in another, do stuff");
    expect(result).toBeNull();
  });
});

describe("parseTabCommand — alias expansion + tab parsing combined", () => {
  const aliases = {
    tabs: ["tubs", "hubs"],
    tab: ["tub", "hub"],
    switch: ["swish", "stitch"],
  };

  test("'stitch to sales tub' after expansion → switch to 'sales'", () => {
    const expanded = expandAliases("stitch to sales tub", aliases);
    // expanded = "switch to sales tab"
    const result = parseTabCommand(expanded);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("sales");
  });

  test("'swish to working' after expansion → switch to 'working'", () => {
    const expanded = expandAliases("swish to working", aliases);
    const result = parseTabCommand(expanded);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("switch");
    expect((result as any).tabName).toBe("working");
  });
});
