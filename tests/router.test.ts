import { test, expect, describe } from "bun:test";
import { FallbackRouter } from "../src/router/fallback-router";
import { LLMRouter } from "../src/router/llm-router";
import { MlxLmProvider } from "../src/backends/llm/mlx-lm";
import type { ActionConfig } from "../src/types";

// Create a mock LLM router that's always unhealthy (forces keyword fallback)
const mockProvider = new MlxLmProvider({ port: 9999, model: "mock-model" });
const mockLLM = new LLMRouter(mockProvider);

// Full default actions set (mirrors config.ts DEFAULT_ACTIONS)
const allActions: Record<string, ActionConfig> = {
  tab_switch: {
    category: "terminal",
    command: 'kitty @ focus-tab --match title:{tab}',
    tts_mode: "silent",
    examples: ["switch to {tab}", "go to {tab}", "open {tab} tab"],
  },
  tab_list: {
    category: "terminal",
    command: "kitty @ ls",
    tts_mode: "summary",
    examples: ["show my tabs", "list tabs", "what tabs are open", "how many tabs", "list out my tabs"],
  },
  slack_check: {
    category: "cli",
    command: "slack-cli.ts search --recent",
    tts_mode: "summary",
    examples: ["check slack", "any slack messages", "what's on slack"],
  },
  calendar_today: {
    category: "cli",
    command: "calendar-cli.ts today",
    tts_mode: "summary",
    examples: ["what's on my calendar", "any meetings today", "calendar"],
  },
  email_check: {
    category: "cli",
    command: "gmail-cli.ts inbox --unread",
    tts_mode: "summary",
    examples: ["check my email", "any new emails", "inbox"],
  },
  morning_checkin: {
    category: "brain",
    command: "/pm-checkin",
    tts_mode: "summary",
    examples: ["morning checkin", "run my checkin", "what's my day look like"],
  },
  sales_pipeline: {
    category: "brain",
    command: "/pm-pipeline",
    tts_mode: "silent",
    examples: ["check the pipeline", "show me open opps", "sales pipeline"],
  },
  time_check: {
    category: "local",
    command: "date '+%I:%M %p %Z'",
    tts_mode: "full",
    examples: ["what time is it", "time", "what's the time", "current time"],
  },
  date_check: {
    category: "local",
    command: "date '+%A, %B %d, %Y'",
    tts_mode: "full",
    examples: ["what's the date", "what day is it", "today's date"],
  },
  greeting: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["hello", "hey", "hi", "good morning", "good afternoon"],
  },
  help: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["what can you do", "help", "what do you do", "what are you", "who are you", "what is cicero", "what's cicero"],
  },
  disk_space: {
    category: "local",
    command: "df -h / | tail -1 | awk '{print $4\" available out of \"$2}'",
    tts_mode: "full",
    examples: ["disk space", "how much space", "storage"],
  },
  battery: {
    category: "local",
    command: "pmset -g batt | grep -o '[0-9]*%'",
    tts_mode: "full",
    examples: ["battery", "battery level", "how much battery"],
  },
  uptime: {
    category: "local",
    command: "uptime | sed 's/.*up /Up /' | sed 's/,.*//'",
    tts_mode: "full",
    examples: ["uptime", "how long has this been running"],
  },
  text_inject: {
    category: "brain",
    command: "",
    tts_mode: "summary",
    examples: ["type {payload}", "type in {payload}", "enter {payload}", "type {payload} into the prompt", "send {payload} to the brain", "tell the brain {payload}", "tell claude {payload}", "ask claude to {payload}", "write {payload} in the terminal"],
  },
  runtime_mute: {
    category: "local",
    command: "",
    tts_mode: "silent",
    examples: ["mute", "turn off tts", "tts off", "stop talking", "be quiet", "silence", "shut up"],
  },
  runtime_unmute: {
    category: "local",
    command: "",
    tts_mode: "silent",
    examples: ["unmute", "turn on tts", "tts on", "start talking", "speak again"],
  },
  runtime_restart_brain: {
    category: "local",
    command: "",
    tts_mode: "full",
    examples: ["restart brain", "restart claude", "reboot the brain", "reset the brain"],
  },
  tab_command: {
    category: "terminal",
    command: "",
    tts_mode: "full",
    examples: ["switch to {tab}", "go to {tab} tab", "use {tab} tab", "switch brain to {tab}", "in {tab} tab run {command}", "on {tab} tab do {command}", "switch to {tab} and {command}"],
  },
};

// Default phonetic aliases
const defaultAliases = {
  tabs: ["tubs", "hubs", "taps", "tops"],
  tab: ["tub", "hub", "tap", "top", "time", "tam", "type"],
  switch: ["swish", "stitch"],
  list: ["least", "last"],
};

describe("FallbackRouter — exact example matching (Phase 1)", () => {
  const router = new FallbackRouter(mockLLM);

  test("matches tab switch with param extraction", async () => {
    const result = await router.classify("switch to sales", allActions);
    expect(result.intent).toBe("tab_switch");
    expect(result.category).toBe("terminal");
    expect(result.params.tab).toBe("sales");
    expect(result.confidence).toBe(0.9);
  });

  test("matches 'go to working' as tab_switch", async () => {
    const result = await router.classify("go to working", allActions);
    expect(result.intent).toBe("tab_switch");
    expect(result.params.tab).toBe("working");
  });

  test("matches 'open PM tools tab' as tab_switch", async () => {
    const result = await router.classify("open PM tools tab", allActions);
    expect(result.intent).toBe("tab_switch");
    expect(result.params.tab).toBe("pm tools");
  });

  test("matches 'show my tabs' as tab_list", async () => {
    const result = await router.classify("show my tabs", allActions);
    expect(result.intent).toBe("tab_list");
    expect(result.category).toBe("terminal");
  });

  test("matches 'list tabs' as tab_list", async () => {
    const result = await router.classify("list tabs", allActions);
    expect(result.intent).toBe("tab_list");
  });

  test("matches 'what tabs are open' as tab_list", async () => {
    const result = await router.classify("what tabs are open", allActions);
    expect(result.intent).toBe("tab_list");
  });

  test("matches 'check slack' as slack_check", async () => {
    const result = await router.classify("check slack", allActions);
    expect(result.intent).toBe("slack_check");
    expect(result.category).toBe("cli");
  });

  test("matches 'any slack messages' as slack_check", async () => {
    const result = await router.classify("any slack messages", allActions);
    expect(result.intent).toBe("slack_check");
  });

  test("matches 'any meetings today' as calendar_today", async () => {
    const result = await router.classify("any meetings today", allActions);
    expect(result.intent).toBe("calendar_today");
    expect(result.category).toBe("cli");
  });

  test("matches 'check my email' as email_check", async () => {
    const result = await router.classify("check my email", allActions);
    expect(result.intent).toBe("email_check");
  });

  test("matches 'what time is it' as time_check", async () => {
    const result = await router.classify("what time is it", allActions);
    expect(result.intent).toBe("time_check");
    expect(result.category).toBe("local");
  });

  test("matches 'hello' as greeting", async () => {
    const result = await router.classify("hello", allActions);
    expect(result.intent).toBe("greeting");
    expect(result.category).toBe("local");
  });

  test("matches 'hey' as greeting", async () => {
    const result = await router.classify("hey", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("matches 'hi' as greeting", async () => {
    const result = await router.classify("hi", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("matches 'good morning' as greeting", async () => {
    const result = await router.classify("good morning", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("matches 'help' as help", async () => {
    const result = await router.classify("help", allActions);
    expect(result.intent).toBe("help");
    expect(result.category).toBe("local");
  });

  test("matches 'what can you do' as help", async () => {
    const result = await router.classify("what can you do", allActions);
    expect(result.intent).toBe("help");
  });

  test("matches 'battery' as battery", async () => {
    const result = await router.classify("battery", allActions);
    expect(result.intent).toBe("battery");
    expect(result.category).toBe("local");
  });

  test("matches 'morning checkin' as morning_checkin", async () => {
    const result = await router.classify("morning checkin", allActions);
    expect(result.intent).toBe("morning_checkin");
    expect(result.category).toBe("brain");
  });

  test("matches 'sales pipeline' as sales_pipeline", async () => {
    const result = await router.classify("sales pipeline", allActions);
    expect(result.intent).toBe("sales_pipeline");
    expect(result.category).toBe("brain");
  });
});

describe("FallbackRouter — fuzzy keyword matching (Phase 2)", () => {
  const router = new FallbackRouter(mockLLM);

  test("fuzzy matches 'what about slack' to slack_check", async () => {
    const result = await router.classify("what about slack messages", allActions);
    expect(result.intent).toBe("slack_check");
    expect(result.confidence).toBe(0.6);
  });

  test("fuzzy matches 'do I have meetings' to calendar_today", async () => {
    const result = await router.classify("do I have meetings today", allActions);
    expect(result.intent).toBe("calendar_today");
  });

  test("fuzzy matches 'sales pipeline update' to sales_pipeline", async () => {
    const result = await router.classify("sales pipeline update", allActions);
    expect(result.intent).toBe("sales_pipeline");
  });
});

describe("FallbackRouter — simple question detection", () => {
  const router = new FallbackRouter(mockLLM);

  test("'what is the capital of France' → simple_question", async () => {
    const result = await router.classify("what is the capital of France", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("'tell me a joke' → simple_question", async () => {
    const result = await router.classify("tell me a joke", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("'how are you' → simple_question", async () => {
    const result = await router.classify("how are you", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("'what is quantum computing' → simple_question", async () => {
    const result = await router.classify("what is quantum computing", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("'explain photosynthesis' → simple_question", async () => {
    const result = await router.classify("explain photosynthesis", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("'who was the first president' → simple_question", async () => {
    const result = await router.classify("who was the first president", allActions);
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });
});

describe("FallbackRouter — complex question detection", () => {
  const router = new FallbackRouter(mockLLM);

  test("'fix the bug in auth.ts' → complex/brain", async () => {
    const result = await router.classify("fix the bug in auth.ts", allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });

  test("'refactor the authentication code' → complex/brain", async () => {
    const result = await router.classify("refactor the authentication code and fix the login bug", allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });

  test("'create a new React component for the dashboard' → complex/brain", async () => {
    const result = await router.classify("create a new React component for the dashboard", allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });

  test("'debug the memory leak in the server' → complex/brain", async () => {
    const result = await router.classify("debug the memory leak in the server", allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });

  test("'deploy the app to production' → complex/brain", async () => {
    const result = await router.classify("deploy the app to production and run the migration scripts for the database then verify all endpoints work correctly", allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });
});

describe("FallbackRouter — greeting detection", () => {
  const router = new FallbackRouter(mockLLM);

  test("'hello' routes to greeting/local", async () => {
    const result = await router.classify("hello", allActions);
    expect(result.intent).toBe("greeting");
    expect(result.category).toBe("local");
    expect(result.confidence).toBe(0.9);
  });

  test("'hi' routes to greeting/local", async () => {
    const result = await router.classify("hi", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("'hey' routes to greeting/local", async () => {
    const result = await router.classify("hey", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("'good morning' routes to greeting/local", async () => {
    const result = await router.classify("good morning", allActions);
    expect(result.intent).toBe("greeting");
  });

  test("'good afternoon' routes to greeting/local", async () => {
    const result = await router.classify("good afternoon", allActions);
    expect(result.intent).toBe("greeting");
  });
});

describe("FallbackRouter — edge cases", () => {
  const router = new FallbackRouter(mockLLM);

  test("empty string falls through to simple_question (short text)", async () => {
    const result = await router.classify("", allActions);
    // Empty string is <= 8 words, no complex indicators → simple_question
    expect(result.intent).toBe("simple_question");
    expect(result.category).toBe("local-llm");
  });

  test("very long string with complex words → complex/brain", async () => {
    const longText = "I need you to refactor the entire authentication system, implement OAuth2 with PKCE flow, add unit tests for all the new code, update the documentation, and deploy to staging for review";
    const result = await router.classify(longText, allActions);
    expect(result.intent).toBe("complex");
    expect(result.category).toBe("brain");
  });

  test("special characters in text don't crash", async () => {
    const result = await router.classify("what's the $PATH variable?", allActions);
    expect(result).toBeDefined();
    expect(result.intent).toBeDefined();
  });

  test("unicode text doesn't crash", async () => {
    const result = await router.classify("what does こんにちは mean", allActions);
    expect(result).toBeDefined();
  });

  test("fallback router always reports healthy", async () => {
    expect(await router.health()).toBe(true);
  });
});

test("FallbackRouter classifies without a redundant health preflight", async () => {
  let healthCalls = 0;
  let classifyCalls = 0;
  const primary = {
    async health() { healthCalls++; return true; },
    async classify() {
      classifyCalls++;
      return { intent: "simple_question", category: "local-llm", params: {}, confidence: 0.9 };
    },
  };

  const router = new FallbackRouter(primary);
  const result = await router.classify("what is the capital of France", allActions);

  expect(result.intent).toBe("simple_question");
  expect(classifyCalls).toBe(1);
  expect(healthCalls).toBe(0);
});

describe("Phonetic alias expansion", () => {
  // Replicate the expandAliases logic from FallbackRouter for direct testing
  const expandAliases = (text: string, aliases: Record<string, string[]>): string => {
    let result = text.toLowerCase();
    for (const [canonical, alts] of Object.entries(aliases)) {
      for (const alt of alts) {
        const regex = new RegExp(`\\b${alt}\\b`, "gi");
        result = result.replace(regex, canonical);
      }
    }
    return result;
  };

  test("tubs → tabs", () => {
    expect(expandAliases("show my tubs", defaultAliases)).toBe("show my tabs");
  });

  test("hubs → tabs", () => {
    expect(expandAliases("how many hubs do i have", defaultAliases)).toBe("how many tabs do i have");
  });

  test("taps → tabs", () => {
    expect(expandAliases("list my taps", defaultAliases)).toBe("list my tabs");
  });

  test("tops → tabs", () => {
    expect(expandAliases("show my tops", defaultAliases)).toBe("show my tabs");
  });

  test("tub → tab", () => {
    expect(expandAliases("open sales tub", defaultAliases)).toBe("open sales tab");
  });

  test("hub → tab", () => {
    expect(expandAliases("switch to sales hub", defaultAliases)).toBe("switch to sales tab");
  });

  test("stitch → switch", () => {
    expect(expandAliases("stitch to sales tub", defaultAliases)).toBe("switch to sales tab");
  });

  test("swish → switch", () => {
    expect(expandAliases("swish to working", defaultAliases)).toBe("switch to working");
  });

  test("least → list", () => {
    expect(expandAliases("least my tubs", defaultAliases)).toBe("list my tabs");
  });

  test("multiple aliases in one phrase", () => {
    expect(expandAliases("stitch to sales tub", defaultAliases)).toBe("switch to sales tab");
  });

  test("no expansion needed — unchanged text", () => {
    expect(expandAliases("check my email", defaultAliases)).toBe("check my email");
  });

  test("word boundaries respected — 'tube' is not 'tab + e'", () => {
    // "tub" is an alias for "tab", but "tube" should NOT match
    expect(expandAliases("youtube is great", defaultAliases)).toBe("youtube is great");
  });
});

describe("LLMRouter — prompt structure", () => {
  test("system prompt contains few-shot examples", () => {
    // Access private method via any cast for testing
    const router = new LLMRouter(new MlxLmProvider({ port: 9999, model: "mock-model" })) as unknown;
    const prompt = router.buildSystemPrompt(allActions);
    expect(prompt).toContain("Examples:");
    expect(prompt).toContain('"intent"');
    expect(prompt).toContain('"confidence"');
  });

  test("system prompt starts with /no_think", () => {
    const router = new LLMRouter(new MlxLmProvider({ port: 9999, model: "mock-model" })) as unknown;
    const prompt = router.buildSystemPrompt(allActions);
    expect(prompt.startsWith("/no_think")).toBe(true);
  });

  test("system prompt limits examples per action to 2", () => {
    const router = new LLMRouter(new MlxLmProvider({ port: 9999, model: "mock-model" })) as unknown;
    const prompt = router.buildSystemPrompt(allActions);
    // Extract only the Actions section (between "Actions:" and "Special intents:")
    const actionsSection = prompt.split("Special intents:")[0];
    const lines = actionsSection.split("\n").filter((l: string) => l.startsWith("- "));
    expect(lines.length).toBeGreaterThan(0);
    // Each action should have at most ~2 examples shown
    for (const line of lines) {
      const commaCount = (line.match(/,/g) || []).length;
      // At most 1 comma = 2 examples (some actions have 1 example)
      expect(commaCount).toBeLessThanOrEqual(2);
    }
  });
});

describe("FallbackRouter with aliases — combined routing", () => {
  const aliasRouter = new FallbackRouter(mockLLM, defaultAliases);

  test("'show my tubs' → tab_list via alias expansion", async () => {
    const result = await aliasRouter.classify("show my tubs", allActions);
    expect(result.intent).toBe("tab_list");
    expect(result.category).toBe("terminal");
  });

  test("'stitch to sales tub' → tab_switch via alias expansion", async () => {
    const result = await aliasRouter.classify("stitch to sales tub", allActions);
    expect(result.intent).toBe("tab_switch");
    expect(result.params.tab).toBeDefined();
  });

  test("'least tubs' → tab_list via double alias expansion", async () => {
    const result = await aliasRouter.classify("least tubs", allActions);
    // "least tubs" → "list tabs" → matches "list tabs" example
    expect(result.intent).toBe("tab_list");
  });

  test("'swish to working tub' → tab_switch", async () => {
    const result = await aliasRouter.classify("swish to working tub", allActions);
    expect(result.intent).toBe("tab_switch");
  });

  test("aliases don't interfere with non-alias commands", async () => {
    const result = await aliasRouter.classify("check slack", allActions);
    expect(result.intent).toBe("slack_check");
  });

  test("aliases containing regex punctuation are matched literally", async () => {
    try {
      const router = new FallbackRouter(mockLLM, {
        "c-plus-plus": ["c++"],
        "$&-literal": ["cash"],
      });
      const custom: Record<string, ActionConfig> = {
        language: { category: "local", command: "", tts_mode: "full", examples: ["use c-plus-plus"] },
        money: { category: "local", command: "", tts_mode: "full", examples: ["show $&-literal"] },
      };

      expect((await router.classify("use c++", custom)).intent).toBe("language");
      expect((await router.classify("show cash", custom)).intent).toBe("money");
    } catch (error) {
      throw new Error(`literal alias routing failed: ${(error as Error).message}`, { cause: error });
    }
  });

  test("action example punctuation is literal while named slots still capture", async () => {
    try {
      const router = new FallbackRouter(mockLLM);
      const custom: Record<string, ActionConfig> = {
        docs: { category: "terminal", command: "", tts_mode: "full", examples: ["open [docs] in {tab}"] },
      };

      const exact = await router.classify("open [docs] in working", custom);
      expect(exact.intent).toBe("docs");
      expect(exact.params.tab).toBe("working");
      expect((await router.classify("open d in working", custom)).intent).not.toBe("docs");
    } catch (error) {
      throw new Error(`literal action template routing failed: ${(error as Error).message}`, { cause: error });
    }
  });
});

describe("FallbackRouter — intent inheritance", () => {
  const router = new FallbackRouter(mockLLM);

  test("'now type cd' with text_inject context → text_inject", async () => {
    const context = 'User: "type ls" → text_inject (brain)';
    const result = await router.classify("now type cd", allActions, context);
    // Should recognize continuation and match text_inject
    expect(result.intent).toBe("text_inject");
    expect(result.params.payload).toBeDefined();
  });

  test("'also check my email' with no context → normal routing", async () => {
    const result = await router.classify("also check my email", allActions);
    // "check" + "email" fuzzy matches email_check
    expect(result.intent).toBe("email_check");
  });
});

describe("FallbackRouter — new intent types", () => {
  const router = new FallbackRouter(mockLLM);

  test("'type ls' → text_inject with payload=ls", async () => {
    const result = await router.classify("type ls", allActions);
    expect(result.intent).toBe("text_inject");
    expect(result.params.payload).toBe("ls");
  });

  test("'type in git status' → text_inject", async () => {
    const result = await router.classify("type in git status", allActions);
    expect(result.intent).toBe("text_inject");
    // "type {payload}" matches first, capturing "in git status"
    expect(result.params.payload).toBeDefined();
  });

  test("'tell the brain fix the CSS' → text_inject", async () => {
    const result = await router.classify("tell the brain fix the css", allActions);
    expect(result.intent).toBe("text_inject");
    expect(result.params.payload).toBe("fix the css");
  });

  test("'mute' → runtime_mute", async () => {
    const result = await router.classify("mute", allActions);
    expect(result.intent).toBe("runtime_mute");
    expect(result.category).toBe("local");
  });

  test("'stop talking' → runtime_mute", async () => {
    const result = await router.classify("stop talking", allActions);
    expect(result.intent).toBe("runtime_mute");
  });

  test("'unmute' → runtime_unmute", async () => {
    const result = await router.classify("unmute", allActions);
    expect(result.intent).toBe("runtime_unmute");
  });

  test("'restart brain' → runtime_restart_brain", async () => {
    const result = await router.classify("restart brain", allActions);
    expect(result.intent).toBe("runtime_restart_brain");
  });

  test("'switch to sales' → terminal category with tab=sales", async () => {
    // tab_switch and tab_command both match — tab_switch comes first in iteration order
    const result = await router.classify("switch to sales", allActions);
    expect(result.category).toBe("terminal");
    expect(result.params.tab).toBe("sales");
  });
});
