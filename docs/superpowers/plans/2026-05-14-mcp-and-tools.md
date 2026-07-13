# MCP and Tools Implementation Plan

> **Historical plan:** this records a proposed implementation and is not an operator configuration reference. Its snippets may contain fields rejected by the current strict runtime schema.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ⚠️ **Scope decision required before execution.** Modern brain CLIs (Claude Code, Codex, and Gemini CLI as of May 2026) speak MCP natively. If Cicero dispatches a turn to one of those brains, tool calling is already handled — duplicating it at the cockpit layer adds maintenance burden for limited benefit.
>
> Before executing this plan, decide one of three paths:
> - **(a) Defer entirely.** Let each brain handle its own MCPs. Cicero stays narrow as a voice dispatcher.
> - **(b) Rescope to system-control MCPs only.** Wire MCPs that the *cockpit* needs to act on the host machine — Home Assistant (room control), volume/brightness/notification system actions, calendar lookups. Do NOT wire general agent-tool MCPs (filesystem, GitHub, Slack tool execution) — those belong with the brain.
> - **(c) Keep as-is.** Justify why the cockpit owning a general tool layer is worth the duplication.
>
> Recommended default: **(b)** — the cockpit gets a small system-control surface for hands-free environment commands ("turn off the lights", "set volume to 30"), while general agentic tool calling stays with the brain.

**Goal:** Add MCP (Model Context Protocol) client support to Cicero's executor so external MCP servers (Home Assistant, GitHub, Slack, filesystem, browser control, etc.) become callable actions without per-tool wiring. Add a web search fallback chain (DDG → Brave → Wikipedia) as a built-in action. Align Cicero's action format with the `agentskills.io` spec for future skill catalog compatibility.

**Architecture:** Cicero's existing `ActionExecutor` dispatches on `category` (terminal | cli | brain | local | local-llm). Add a new `mcp` category. An `MCPManager` runs alongside `ActionExecutor`, manages persistent connections to configured MCP servers, and exposes their tools as Cicero actions auto-registered into the action registry at startup. Each MCP tool becomes a dynamically-named action with category `mcp`. The router and embedding filter from Plan 3 see them as regular actions.

**Tech Stack:** Bun ≥1.1, TypeScript 5.9, `@modelcontextprotocol/sdk` (TS, MIT licensed). New optional deps for web search: none beyond fetch. Built-in actions use the embedding filter from Plan 3 to stay searchable.

**Source inspiration:**
- [`isair/jarvis`](https://github.com/isair/jarvis) — MCP integration patterns (non-commercial license: read-only)
- [`open-jarvis/OpenJarvis`](https://github.com/open-jarvis/OpenJarvis) — MCP protocol implementation reference and `agentskills.io` action format (Apache 2.0)

Read both for patterns; reimplement clean in TS.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/mcp/manager.ts` | NEW | Connects to MCP servers, registers their tools as actions |
| `src/mcp/transport-stdio.ts` | NEW | Spawn-an-MCP-server-and-talk-over-stdio transport |
| `src/mcp/transport-sse.ts` | NEW | HTTP+SSE transport for remote MCP servers |
| `src/mcp/types.ts` | NEW | MCP-specific type defs (server config, tool descriptor) |
| `src/executor/index.ts` | MODIFY | Add `case "mcp":` to category dispatch |
| `src/executor/web-search.ts` | NEW | DDG → Brave → Wikipedia fallback chain |
| `src/types.ts` | MODIFY | Extend `ActionConfig.category` with `"mcp"`; add `MCPConfig` |
| `src/config.ts` | MODIFY | Wire MCP server configs from YAML |
| `src/daemon.ts` | MODIFY | Start MCPManager on boot, inject MCP-derived actions into registry |
| `tests/mcp-manager.test.ts` | NEW | Manager start/stop, tool registration |
| `tests/mcp-transport-stdio.test.ts` | NEW | Transport mock tests |
| `tests/executor-web-search.test.ts` | NEW | Web search fallback chain |
| `tests/executor-mcp.test.ts` | NEW | Executor handles mcp category |

---

## Task 1: Add MCP SDK dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dep**

```bash
bun add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Verify installation**

```bash
bun pm ls | grep modelcontextprotocol
```

Expected: `@modelcontextprotocol/sdk` listed.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(mcp): add @modelcontextprotocol/sdk dependency"
```

---

## Task 2: MCP types and category extension

**Files:**
- Create: `src/mcp/types.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import type { MCPServerConfig } from "../src/mcp/types";
import type { ActionConfig, CiceroConfig } from "../src/types";

test("MCPServerConfig has stdio and sse transport variants", () => {
  const a: MCPServerConfig = { transport: "stdio", command: ["fs-mcp"], env: {} };
  const b: MCPServerConfig = { transport: "sse", url: "http://localhost:9000/sse" };
  expect(a.transport).toBe("stdio");
  expect(b.transport).toBe("sse");
});

test("ActionConfig.category accepts 'mcp'", () => {
  const a: ActionConfig = { category: "mcp", command: "", tts_mode: "summary", examples: ["x"] };
  expect(a.category).toBe("mcp");
});

test("CiceroConfig has optional mcp servers map", () => {
  const c: Partial<CiceroConfig> = {
    mcp_servers: { homeassistant: { transport: "stdio", command: ["mcp-proxy", "http://localhost:8123"] } },
  };
  expect(c.mcp_servers).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp-types.test.ts`
Expected: FAIL — modules / fields don't exist.

- [ ] **Step 3: Add MCP types**

Create `src/mcp/types.ts`:

```ts
export type MCPTransport = "stdio" | "sse";

export interface StdioMCPConfig {
  transport: "stdio";
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SSEMCPConfig {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type MCPServerConfig = StdioMCPConfig | SSEMCPConfig;

export interface MCPToolDescriptor {
  server: string;          // which MCP server it came from
  name: string;            // tool name as the server reports it
  description: string;
  inputSchema?: Record<string, unknown>;  // JSON Schema for arguments
}
```

In `src/types.ts`, extend ActionConfig and CiceroConfig:

```ts
export interface ActionConfig {
  category: "terminal" | "cli" | "brain" | "local" | "local-llm" | "mcp";
  command: string;
  tts_mode: "full" | "summary" | "silent";
  examples: string[];
  // MCP-specific
  mcp_server?: string;   // which MCP server provides this tool
  mcp_tool?: string;     // tool name as the server knows it
}

export interface CiceroConfig {
  // ... existing fields ...
  mcp_servers?: Record<string, import("./mcp/types").MCPServerConfig>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp-types.test.ts`
Expected: PASS for all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/types.ts src/types.ts tests/mcp-types.test.ts
git commit -m "feat(mcp): add MCP types and 'mcp' action category"
```

---

## Task 3: MCPManager — connect, list tools, register as actions

**Files:**
- Create: `src/mcp/manager.ts`
- Test: `tests/mcp-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock } from "bun:test";
import { MCPManager } from "../src/mcp/manager";

test("MCPManager.start connects all configured servers and registers their tools", async () => {
  // Mock the underlying SDK client behavior via a fake transport.
  const fakeTools = [
    { name: "ha_lights_on", description: "Turn lights on" },
    { name: "ha_lights_off", description: "Turn lights off" },
  ];

  const mgr = new MCPManager({
    homeassistant: { transport: "stdio", command: ["fake-server"] },
  });
  // Inject a fake connect implementation
  (mgr as any).connectStdio = async () => ({
    listTools: async () => fakeTools,
    callTool: async (name: string) => `result of ${name}`,
    close: async () => {},
  });

  await mgr.start();
  const actions = mgr.getActions();
  expect(actions).toHaveProperty("mcp_homeassistant_ha_lights_on");
  expect(actions).toHaveProperty("mcp_homeassistant_ha_lights_off");
  expect(actions.mcp_homeassistant_ha_lights_on.category).toBe("mcp");
});

test("MCPManager.invoke calls the right server's tool", async () => {
  const mgr = new MCPManager({});
  let calledWith: { name: string; args: any } | null = null;
  (mgr as any).clients = {
    fs: {
      callTool: async (name: string, args: any) => {
        calledWith = { name, args };
        return "file contents";
      },
    },
  };

  const result = await mgr.invoke("fs", "read_file", { path: "/tmp/x" });
  expect(calledWith).toEqual({ name: "read_file", args: { path: "/tmp/x" } });
  expect(result).toBe("file contents");
});

test("MCPManager.stop closes all clients", async () => {
  const closed: string[] = [];
  const mgr = new MCPManager({});
  (mgr as any).clients = {
    a: { close: async () => { closed.push("a"); } },
    b: { close: async () => { closed.push("b"); } },
  };
  await mgr.stop();
  expect(closed.sort()).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mcp-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/mcp/manager.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServerConfig } from "./types";
import type { ActionConfig } from "../types";
import { log } from "../logger";

interface MCPClient {
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export class MCPManager {
  private servers: Record<string, MCPServerConfig>;
  private clients: Record<string, MCPClient> = {};
  private actions: Record<string, ActionConfig> = {};

  constructor(servers: Record<string, MCPServerConfig> = {}) {
    this.servers = servers;
  }

  async start(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.servers)) {
      try {
        const client = cfg.transport === "stdio"
          ? await this.connectStdio(cfg)
          : await this.connectSSE(cfg);
        this.clients[name] = client;
        const tools = await client.listTools();
        for (const tool of tools) {
          const actionName = `mcp_${name}_${tool.name}`;
          this.actions[actionName] = {
            category: "mcp",
            command: "",
            tts_mode: "summary",
            examples: tool.description ? [tool.description] : [tool.name],
            mcp_server: name,
            mcp_tool: tool.name,
          };
        }
        log("ok", `MCP server '${name}' connected: ${tools.length} tools`);
      } catch (err) {
        log("warn", `MCP server '${name}' failed: ${(err as Error).message}`);
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(Object.values(this.clients).map(c => c.close().catch(() => {})));
    this.clients = {};
  }

  getActions(): Record<string, ActionConfig> {
    return { ...this.actions };
  }

  async invoke(server: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients[server];
    if (!client) throw new Error(`MCP server '${server}' not connected`);
    return await client.callTool(tool, args);
  }

  private async connectStdio(cfg: Extract<MCPServerConfig, { transport: "stdio" }>): Promise<MCPClient> {
    const transport = new StdioClientTransport({
      command: cfg.command[0],
      args: cfg.command.slice(1),
      env: cfg.env,
      cwd: cfg.cwd,
    });
    const client = new Client({ name: "cicero", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    return this.wrap(client);
  }

  private async connectSSE(cfg: Extract<MCPServerConfig, { transport: "sse" }>): Promise<MCPClient> {
    const transport = new SSEClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } });
    const client = new Client({ name: "cicero", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    return this.wrap(client);
  }

  private wrap(client: Client): MCPClient {
    return {
      async listTools() {
        const res = await client.listTools();
        return res.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      },
      async callTool(name: string, args: Record<string, unknown>) {
        const res = await client.callTool({ name, arguments: args });
        // Flatten content array to a single string
        if (Array.isArray(res.content)) {
          return res.content.map(c => (c as any).text ?? JSON.stringify(c)).join("\n");
        }
        return String(res.content);
      },
      async close() {
        await client.close();
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mcp-manager.test.ts`
Expected: PASS for all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/manager.ts tests/mcp-manager.test.ts
git commit -m "feat(mcp): MCPManager connects servers, registers tools as actions"
```

---

## Task 4: Executor MCP dispatch

**Files:**
- Modify: `src/executor/index.ts`
- Test: `tests/executor-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { ActionExecutor } from "../src/executor";
import { RuntimeConfig } from "../src/config";

test("ActionExecutor dispatches mcp category to MCPManager.invoke", async () => {
  let invoked: any = null;
  const fakeMgr = {
    invoke: async (server: string, tool: string, args: any) => {
      invoked = { server, tool, args };
      return "lights on";
    },
  };

  const cfg = new RuntimeConfig({
    /* minimal valid config */
    tts_enabled: false,
    wake_word_enabled: false,
    hotkey: "x", wispr_hotkey: "x", terminal: "kitty", voice: "default",
    brain: { backend: "ollama", mode: "subprocess", session_timeout: "1h", max_context_commands: 1 },
    servers: { router: { port: 1, model: "x" }, tts: { port: 2, model: "y" }, stt: { port: 3, model: "z" } },
    actions: {
      mcp_ha_lights_on: {
        category: "mcp",
        command: "",
        tts_mode: "summary",
        examples: ["turn on lights"],
        mcp_server: "ha",
        mcp_tool: "lights_on",
      },
    },
  });

  const exec = new ActionExecutor(
    cfg,
    {} as any,  // terminal — unused for mcp
    {} as any,  // brain — unused
    { speak: async () => {}, stop: async () => {}, health: async () => true },
    {} as any,
  );
  exec.setMCPManager(fakeMgr as any);

  const result = await exec.execute({
    intent: "mcp_ha_lights_on",
    category: "mcp",
    params: { brightness: "80" },
    confidence: 0.95,
  }, "turn on lights");

  expect(invoked).toEqual({ server: "ha", tool: "lights_on", args: { brightness: "80" } });
  expect(result.success).toBe(true);
  expect(result.output).toBe("lights on");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/executor-mcp.test.ts`
Expected: FAIL — `setMCPManager` and `mcp` case don't exist.

- [ ] **Step 3: Modify ActionExecutor**

In `src/executor/index.ts`:

```ts
import type { MCPManager } from "../mcp/manager";

// Add member:
private mcpManager: MCPManager | null = null;

setMCPManager(mgr: MCPManager): void {
  this.mcpManager = mgr;
}

// Add to the category dispatch switch:
case "mcp":
  return await this.executeMCP(route);

// New method:
private async executeMCP(route: RouterResult): Promise<ExecutionResult> {
  const start = Date.now();
  const action = this.config.actions[route.intent];
  if (!action || action.category !== "mcp" || !action.mcp_server || !action.mcp_tool) {
    return { success: false, output: "", error: `Invalid MCP action: ${route.intent}`, duration_ms: 0 };
  }
  if (!this.mcpManager) {
    return { success: false, output: "", error: "MCPManager not initialized", duration_ms: 0 };
  }
  try {
    const result = await this.mcpManager.invoke(action.mcp_server, action.mcp_tool, route.params);
    return { success: true, output: result, duration_ms: Date.now() - start };
  } catch (err) {
    return { success: false, output: "", error: (err as Error).message, duration_ms: Date.now() - start };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/executor-mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/executor/index.ts tests/executor-mcp.test.ts
git commit -m "feat(executor): dispatch mcp category to MCPManager"
```

---

## Task 5: Boot MCPManager from daemon and merge actions

**Files:**
- Modify: `src/daemon.ts`
- Modify: `src/config.ts` (to surface mcp_servers via RuntimeConfig)

- [ ] **Step 1: Add RuntimeConfig accessor**

In `src/config.ts`, `RuntimeConfig` class:

```ts
get mcpServers(): Record<string, import("./mcp/types").MCPServerConfig> {
  return this.config.mcp_servers ?? {};
}
```

- [ ] **Step 2: Boot the manager in daemon**

In `src/daemon.ts`, locate the existing startup sequence (likely after `createBrain` / `createExecutor`). Add:

```ts
import { MCPManager } from "../src/mcp/manager";

// In startup:
const mcpManager = new MCPManager(config.mcpServers);
await mcpManager.start();
// Merge MCP-derived actions into the config
const mcpActions = mcpManager.getActions();
for (const [name, action] of Object.entries(mcpActions)) {
  config.raw.actions[name] = action;
}
executor.setMCPManager(mcpManager);

// If embedding filter from Plan 3 exists, re-index after MCP actions are added:
if (embeddingFilter) {
  await embeddingFilter.index(config.actions);
}

// On shutdown:
await mcpManager.stop();
```

- [ ] **Step 3: Smoke test with a real MCP server**

Install the filesystem MCP server:

```bash
npx -y @modelcontextprotocol/server-filesystem /tmp
```

Add to `~/.cicero/config.yaml`:

```yaml
mcp_servers:
  fs:
    transport: stdio
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Start Cicero, then voice: "list files in /tmp". Expected: routes to `mcp_fs_list_directory` (or similar; depends on server tool naming) and returns file list.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/daemon.ts
git commit -m "feat(daemon): boot MCPManager, merge MCP tools into action registry"
```

---

## Task 6: Web search fallback chain action

**Files:**
- Create: `src/executor/web-search.ts`
- Modify: `src/executor/index.ts` to wire it in
- Test: `tests/executor-web-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect, mock, beforeEach } from "bun:test";
import { searchWeb } from "../src/executor/web-search";

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });

test("searchWeb tries DDG first", async () => {
  let urls: string[] = [];
  globalThis.fetch = mock(async (url: string) => {
    urls.push(url);
    if (url.includes("duckduckgo")) return new Response(JSON.stringify({ Abstract: "DDG answer" }));
    return new Response("", { status: 500 });
  }) as any;

  const result = await searchWeb("what is the capital of France");
  expect(result.source).toBe("duckduckgo");
  expect(result.text).toContain("DDG answer");
});

test("searchWeb falls back to Brave when DDG empty", async () => {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("duckduckgo")) return new Response(JSON.stringify({}));
    if (url.includes("brave")) return new Response(JSON.stringify({ web: { results: [{ description: "Brave answer" }] } }));
    return new Response("", { status: 500 });
  }) as any;

  const result = await searchWeb("test query", { braveApiKey: "fake" });
  expect(result.source).toBe("brave");
  expect(result.text).toContain("Brave answer");
});

test("searchWeb falls back to Wikipedia when both fail", async () => {
  globalThis.fetch = mock(async (url: string) => {
    if (url.includes("duckduckgo")) return new Response(JSON.stringify({}));
    if (url.includes("brave")) return new Response("", { status: 500 });
    if (url.includes("wikipedia")) return new Response(JSON.stringify({ extract: "Wiki answer" }));
    return new Response("", { status: 500 });
  }) as any;

  const result = await searchWeb("Paris");
  expect(result.source).toBe("wikipedia");
  expect(result.text).toContain("Wiki answer");
});

test("searchWeb returns null source when all fail", async () => {
  globalThis.fetch = mock(async () => new Response("", { status: 500 })) as any;
  const result = await searchWeb("anything");
  expect(result.source).toBe(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/executor-web-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// src/executor/web-search.ts

export interface WebSearchOptions {
  braveApiKey?: string;
  language?: string;
}

export interface WebSearchResult {
  source: "duckduckgo" | "brave" | "wikipedia" | null;
  text: string;
}

export async function searchWeb(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult> {
  // 1. DDG Instant Answer
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
    if (r.ok) {
      const data = await r.json() as any;
      if (data.Abstract) return { source: "duckduckgo", text: data.Abstract };
      if (data.AbstractText) return { source: "duckduckgo", text: data.AbstractText };
    }
  } catch {}

  // 2. Brave (requires API key)
  if (opts.braveApiKey) {
    try {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=1`,
        { headers: { "X-Subscription-Token": opts.braveApiKey } },
      );
      if (r.ok) {
        const data = await r.json() as any;
        const top = data.web?.results?.[0];
        if (top?.description) return { source: "brave", text: top.description };
      }
    } catch {}
  }

  // 3. Wikipedia summary
  try {
    const lang = opts.language ?? "en";
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
    if (r.ok) {
      const data = await r.json() as any;
      if (data.extract) return { source: "wikipedia", text: data.extract };
    }
  } catch {}

  return { source: null, text: "" };
}
```

- [ ] **Step 4: Register as a built-in action**

In `src/config.ts` DEFAULT_ACTIONS:

```ts
web_search: {
  category: "local-llm",  // routed result goes back through brain for natural phrasing
  command: "",            // handled in executor via searchWeb()
  tts_mode: "summary",
  examples: [
    "search the web for {query}",
    "look up {query}",
    "google {query}",
    "what is {query}",
    "tell me about {query}",
  ],
},
```

In `src/executor/index.ts:executeLocal`, add a special case BEFORE the general command path:

```ts
import { searchWeb } from "./web-search";

// At top of executeLocal:
if (route.intent === "web_search") {
  const query = route.params.query || originalText;
  const braveApiKey = process.env.BRAVE_API_KEY;
  const result = await searchWeb(query, { braveApiKey });
  if (result.source) {
    return {
      success: true,
      output: `According to ${result.source}: ${result.text}`,
      duration_ms: Date.now() - start,
    };
  }
  return {
    success: false,
    output: "I couldn't find anything on that.",
    duration_ms: Date.now() - start,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/executor-web-search.test.ts`
Expected: PASS for all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/executor/web-search.ts src/executor/index.ts src/config.ts tests/executor-web-search.test.ts
git commit -m "feat(executor): web search fallback chain (DDG → Brave → Wikipedia)"
```

---

## Task 7: Align action format with agentskills.io

**Files:**
- Modify: `src/types.ts` (extend ActionConfig with optional spec fields)
- Modify: `src/config.ts` (validate the new fields when loading)

The goal: Cicero's actions become a strict superset of `agentskills.io` Skill schema, so external skill catalogs can be ingested without conversion.

agentskills.io spec (as of May 2026): a Skill has `name`, `description`, `tags`, `examples`, `inputs` (JSON Schema), `tool` (name of underlying tool/MCP server), `version`.

- [ ] **Step 1: Add optional spec fields to ActionConfig**

In `src/types.ts`:

```ts
export interface ActionConfig {
  category: "terminal" | "cli" | "brain" | "local" | "local-llm" | "mcp";
  command: string;
  tts_mode: "full" | "summary" | "silent";
  examples: string[];
  // MCP-specific
  mcp_server?: string;
  mcp_tool?: string;
  // agentskills.io spec compatibility
  description?: string;
  tags?: string[];
  inputs?: Record<string, unknown>;  // JSON Schema
  version?: string;
}
```

- [ ] **Step 2: Add an importer**

Create `src/mcp/import-agentskills.ts`:

```ts
import type { ActionConfig } from "../types";
import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";

interface AgentSkill {
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputs?: Record<string, unknown>;
  tool?: string;
  version?: string;
}

export function importAgentSkillsCatalog(path: string): Record<string, ActionConfig> {
  const raw = readFileSync(path, "utf-8");
  const data = parseYaml(raw) as { skills: AgentSkill[] };
  const actions: Record<string, ActionConfig> = {};

  for (const skill of data.skills) {
    actions[skill.name] = {
      category: skill.tool ? "mcp" : "local",  // assume MCP if a tool is specified
      command: "",
      tts_mode: "summary",
      examples: skill.examples ?? [skill.description],
      description: skill.description,
      tags: skill.tags,
      inputs: skill.inputs,
      version: skill.version,
      mcp_tool: skill.tool,
    };
  }
  return actions;
}
```

- [ ] **Step 3: Document the format**

In README, add:

```markdown
### Importing agentskills.io catalogs

Cicero's action format is a strict superset of the agentskills.io Skill schema. To import a community catalog:

```yaml
# ~/.cicero/actions.yaml
import_catalogs:
  - /path/to/community-skills.yaml
```

Cicero merges imported skills into the action registry at startup. Imported skills inherit `tts_mode: summary` and `category: mcp` if they specify a `tool`, `local` otherwise.
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/mcp/import-agentskills.ts README.md
git commit -m "feat(mcp): agentskills.io schema compatibility + catalog importer"
```

---

## Self-review notes

- MCP tool naming: `mcp_<server>_<tool>` prevents collisions across servers. The router sees them as ordinary intents.
- MCP server failure is non-fatal: if one server fails to connect, others still load. Cicero logs a warning.
- The embedding filter from Plan 3 must be re-indexed after MCP actions are added. The daemon does this once at startup. Hot-add MCP servers isn't covered (out of scope).
- Web search has three tiers; brave requires `BRAVE_API_KEY`. If not set, the chain becomes DDG → Wikipedia.
- agentskills.io schema fields (`description`, `tags`, `inputs`, `version`) are optional. Existing Cicero actions still validate without them.
- Output formatting: MCP tool results are returned as text; the executor passes them through TTS as-is. If a result is JSON, the brain or local-llm path can be called to phrase it.
