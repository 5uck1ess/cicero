import type { Brain, BrainTurnOptions, TerminalAdapter, Tab } from "../types";
import { basename } from "path";
import { log } from "../logger";
import { BrainTurnContext } from "./turn-context";

export interface TabInjectTimingOptions {
  responseInitialDelayMs: number;
  responsePollIntervalMs: number;
  responseMaxWaitMs: number;
  responseAssumeStartedAfterMs: number;
  responseStableChecks: number;
  terminalOperationTimeoutMs: number;
  interruptSendTimeoutMs: number;
  interruptSettleTimeoutMs: number;
  interruptPollIntervalMs: number;
  interruptStableChecks: number;
}

const DEFAULT_TIMINGS: TabInjectTimingOptions = {
  responseInitialDelayMs: 1_500,
  responsePollIntervalMs: 1_000,
  responseMaxWaitMs: 120_000,
  responseAssumeStartedAfterMs: 5_000,
  responseStableChecks: 3,
  terminalOperationTimeoutMs: 5_000,
  interruptSendTimeoutMs: 1_500,
  interruptSettleTimeoutMs: 5_000,
  interruptPollIntervalMs: 100,
  interruptStableChecks: 2,
};

/**
 * TabInjectBrain - Spawns a dedicated Claude Code tab and injects commands into
 * it. Claude's classifier-backed auto permission mode is the safe default;
 * permissions are only bypassed when auto-approval is explicitly enabled.
 */
export class TabInjectBrain implements Brain {
  private terminal: TerminalAdapter;
  private targetTab: string;
  private turnContext = new BrainTurnContext();
  private previousTab: Tab | null = null;
  private autoApproveTools: boolean;
  private ownedTabId: string | null = null; // tab we spawned
  private turnLock: Promise<void> = Promise.resolve();
  private sessionUnsafeReason: string | null = null;
  private lifecycleAbort = new AbortController();
  private acceptingTurns = true;
  private stopPromise: Promise<void> | null = null;
  private readonly timings: TabInjectTimingOptions;

  constructor(
    terminal: TerminalAdapter,
    targetTab: string,
    autoApproveTools = false,
    timings: Partial<TabInjectTimingOptions> = {},
  ) {
    this.terminal = terminal;
    this.targetTab = targetTab;
    this.autoApproveTools = autoApproveTools;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    this.lifecycleAbort = new AbortController();
    this.acceptingTurns = true;
    try {
      const tabs = await this.terminal.listTabs();

      // 1. Check if configured target tab already exists
      const existing = tabs.find(t =>
        t.title.toLowerCase().includes(this.targetTab.toLowerCase())
      );

      if (existing) {
        log("info", `Brain (tab-inject) found existing tab: "${existing.title}" (id:${existing.id})`);
        return;
      }

      // 2. No configured tab found — let user pick any existing tab
      if (tabs.length > 0) {
        const chosen = await this.promptTabSelection(tabs);
        if (chosen) {
          this.targetTab = chosen.title;
          log("ok", `Brain will use existing tab: "${chosen.title}" (id:${chosen.id})`);
          return;
        }
      }

      // 3. No suitable tabs or user chose "new" — spawn a dedicated tab
      await this.spawnBrainTab();
    } catch (err: unknown) {
      this.acceptingTurns = false;
      this.lifecycleAbort.abort(new Error("Tab-inject brain failed to start"));
      throw err;
    }
  }

  /**
   * Find tabs that appear to be running Claude Code.
   */
  private async findClaudeTabs(tabs: Tab[]): Promise<Tab[]> {
    const candidates: Tab[] = [];
    for (const tab of tabs) {
      try {
        const text = await this.terminal.getText(tab.id);
        // Look for Claude Code indicators: ❯ prompt, "Claude" in title, etc.
        const hasClaudePrompt = /^❯\s*$/m.test(text);
        const hasClaudeTitle = /claude/i.test(tab.title);
        if (hasClaudePrompt || hasClaudeTitle) {
          candidates.push(tab);
        }
      } catch {}
    }
    return candidates;
  }

  /**
   * Build a display label for a tab using CWD and title.
   */
  private tabLabel(tab: Tab): string {
    // Use last directory name from CWD for context
    const dir = tab.cwd ? basename(tab.cwd) : null;
    const title = tab.title || "untitled";
    // If title is generic (e.g. "Claude Code"), show CWD to differentiate
    if (dir && dir !== "~" && !title.toLowerCase().includes(dir.toLowerCase())) {
      return `${title}  [${dir}]`;
    }
    return title;
  }

  /**
   * Interactive prompt: ask user which tab to use for brain injection.
   * Returns the chosen tab, or null to spawn a new one.
   */
  private async promptTabSelection(allTabs: Tab[]): Promise<Tab | null> {
    // Filter out the cicero daemon tab itself (the focused one running cicero)
    const choices = allTabs.filter(t => !t.is_focused);

    console.log("\n  Brain Setup — Choose a tab for Cicero to inject into:");
    console.log("  ────────────────────────────────────────────────────");
    choices.forEach((tab, i) => {
      console.log(`  ${i + 1}) ${this.tabLabel(tab)}  (id:${tab.id})`);
    });
    console.log(`  ${choices.length + 1}) Create a new dedicated tab`);
    console.log("");

    // Read from stdin — use raw buffer reads to avoid interfering with
    // the StdinListener's readline instance that starts later
    process.stdout.write("  Choose [1-" + (choices.length + 1) + "]: ");

    const choice = await new Promise<string>((resolve) => {
      let resolved = false;
      const done = (val: string) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      let buffer = "";
      let timer: ReturnType<typeof setTimeout>;
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes("\n")) {
          process.stdin.removeListener("data", onData);
          clearTimeout(timer);
          done(buffer.split("\n")[0].trim());
        }
      };
      process.stdin.on("data", onData);

      // Auto-select "new" after 30s if no input
      timer = setTimeout(() => {
        process.stdin.removeListener("data", onData);
        console.log(`(timeout — creating new tab)`);
        done(String(choices.length + 1));
      }, 30000);
    });

    const idx = parseInt(choice, 10);
    if (idx >= 1 && idx <= choices.length) {
      return choices[idx - 1];
    }
    return null; // spawn new
  }

  /**
   * Spawn a new dedicated Claude Code brain tab.
   */
  private async spawnBrainTab(): Promise<void> {
    log("info", `Brain (tab-inject) spawning dedicated Claude Code tab "${this.targetTab}"...`);
    try {
      // TODO(Plan 1): the brain command is Claude-Code-specific; move it into
      // the brain backend rather than hardcoding it here.
      const tab = await this.terminal.spawnTab({
        title: this.targetTab,
        cwd: process.cwd(),
        command: this.autoApproveTools
          ? "claude --dangerously-skip-permissions"
          : "claude --permission-mode auto",
        env: { CICERO_BRAIN: "1" },
        keepFocus: true,
      });
      this.ownedTabId = tab.id;
      log("info", `Brain tab spawned (id:${tab.id}), waiting for Claude Code to initialize...`);
      await this.waitForBrainReady();
    } catch (err) {
      log("warn", `Could not spawn brain tab: ${(err as Error).message}`);
      log("warn", `Brain will try to find an existing Claude Code tab on first use`);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.acceptingTurns = false;
    this.lifecycleAbort.abort(new Error("Tab-inject brain is stopping"));
    const stopping = this.stopAfterTurns();
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = null;
    }
  }

  private async stopAfterTurns(): Promise<void> {
    const drainTimeoutMs = (
      this.timings.terminalOperationTimeoutMs * 2
      + this.timings.interruptSendTimeoutMs
      + this.timings.interruptSettleTimeoutMs
      + 1_000
    );
    let turnsDrained = false;
    try {
      await this.withDeadline(this.turnLock, drainTimeoutMs, "draining tab-inject turns");
      turnsDrained = true;
    } catch (err: unknown) {
      this.markSessionUnsafe(err instanceof Error ? err.message : String(err));
    }

    const ownedTabId = this.ownedTabId;
    this.ownedTabId = null;
    if (ownedTabId === null) {
      // A completed stop is a lifecycle boundary for a user-owned tab. Drop a
      // prior turn's quarantine only after every serialized turn has drained;
      // if draining itself is uncertain, retain the marker so a later start
      // still fails closed until health()/restart() confirms an idle prompt.
      if (turnsDrained) this.sessionUnsafeReason = null;
      return;
    }

    log("info", `Closing brain tab (id:${ownedTabId})...`);
    try {
      await this.withDeadline(
        this.terminal.closeTab(ownedTabId),
        this.timings.terminalOperationTimeoutMs,
        "closing the brain tab",
      );
      this.sessionUnsafeReason = null;
      log("ok", "Brain tab closed");
    } catch (err: unknown) {
      this.markSessionUnsafe(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Switch the default brain target tab at runtime.
   * Also visually focuses the tab via the terminal adapter.
   */
  switchTab(tabName: string): void {
    this.targetTab = tabName;
    log("ok", `Brain target switched to "${tabName}"`);
    // Focus the tab visually — fire and forget
    this.terminal.focusTab(tabName).catch(() => {});
  }

  getTargetTab(): string {
    return this.targetTab;
  }

  send(message: string, options?: BrainTurnOptions): Promise<string> {
    return this.sendToTab(message, this.targetTab, options);
  }

  /**
   * Send a message to a specific tab by name (one-off, doesn't change default).
   */
  sendToTab(
    message: string,
    tabName: string,
    options: BrainTurnOptions = {},
  ): Promise<string> {
    if (!this.acceptingTurns) {
      return Promise.reject(new Error("Tab-inject brain is not accepting turns"));
    }
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal;
    return this.runSerialized(signal, async () => {
      this.throwIfAborted(signal);
      return await this.sendToTabLocked(message, tabName, signal, options.systemContext);
    }).catch((err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
  }

  private async sendToTabLocked(
    message: string,
    tabName: string,
    signal?: AbortSignal,
    systemContext?: string,
  ): Promise<string> {
    this.assertSessionSafe();
    const tabs = await this.awaitAbortableOperation(
      this.terminal.listTabs(),
      signal,
      "listing brain tabs",
    );
    const target = this.findTargetTab(tabs, tabName);
    if (!target) {
      throw new Error(`Tab not found: "${tabName}". Available: ${tabs.map(t => t.title).join(", ")}`);
    }

    const prompt = this.turnContext.buildTextPrompt(message, false, systemContext);

    this.previousTab = tabs.find(t => t.is_focused) || null;

    // The adapter's opaque id addresses the tab for send/get/focus.
    const winId = target.id;
    let turnState: "untouched" | "sending" | "editing" | "submitted" = "untouched";
    let cancelRequest: Promise<void> | null = null;
    const requestCancel = () => {
      if (turnState === "untouched" || cancelRequest) return;
      cancelRequest = this.withDeadline(
        this.terminal.sendKey(winId, "escape"),
        this.timings.interruptSendTimeoutMs,
        "sending the brain interrupt key",
      );
      void cancelRequest.catch((err: unknown) => {
        log("warn", `Brain interrupt key failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };
    signal?.addEventListener("abort", requestCancel, { once: true });

    try {
      log("info", `Injecting into "${target.title}" (id:${target.id}): ${prompt.substring(0, 80)}${prompt.length > 80 ? "..." : ""}`);
      this.throwIfAborted(signal);
      turnState = "sending";
      await this.withDeadline(
        this.terminal.sendText(winId, prompt),
        this.timings.terminalOperationTimeoutMs,
        "sending the brain prompt",
      );
      turnState = "editing";
      this.throwIfAborted(signal);

      // Mark as submitted before awaiting Enter: a CLI error can occur after the
      // terminal has already received the key, so recovery must be conservative.
      turnState = "submitted";
      await this.withDeadline(
        this.terminal.sendKey(winId, "enter"),
        this.timings.terminalOperationTimeoutMs,
        "submitting the brain prompt",
      );
      this.throwIfAborted(signal);

      const response = await this.waitForResponse(winId, prompt, signal);
      this.throwIfAborted(signal);
      return response;
    } catch (err: unknown) {
      if (turnState !== "untouched") {
        try {
          requestCancel();
          if (!cancelRequest) {
            throw new Error("brain interrupt was not scheduled");
          }
          await cancelRequest;
          await this.waitForIdleAfterInterrupt(winId);
        } catch (settlementErr: unknown) {
          const reason = settlementErr instanceof Error
            ? settlementErr.message
            : String(settlementErr);
          this.markSessionUnsafe(reason);
          throw new Error(`Brain session quarantined after an unconfirmed interrupt: ${reason}`);
        }
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", requestCancel);
      if (this.previousTab && this.previousTab.id !== winId) {
        try {
          await this.withDeadline(
            this.terminal.focusTab(this.previousTab.id),
            this.timings.terminalOperationTimeoutMs,
            "restoring the previous terminal tab",
          );
        } catch (err: unknown) {
          log("warn", `Could not restore the previous tab: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async runSerialized<T>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.turnLock;
    let releaseTurn!: () => void;
    this.turnLock = new Promise<void>((resolve) => { releaseTurn = resolve; });

    try {
      await this.waitForGateOrAbort(predecessor, signal);
    } catch (err: unknown) {
      // The caller must reject promptly, but this ticket cannot release its
      // successor until its predecessor has finished or queue ordering breaks.
      void predecessor.then(releaseTurn).catch((gateErr: unknown) => {
        log("warn", `Brain turn gate failed: ${gateErr instanceof Error ? gateErr.message : String(gateErr)}`);
        releaseTurn();
      });
      throw err;
    }

    try {
      this.throwIfAborted(signal);
      return await work();
    } catch (err: unknown) {
      throw err;
    } finally {
      releaseTurn();
    }
  }

  private waitForGateOrAbort(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return gate;
    try {
      this.throwIfAborted(signal);
    } catch (err: unknown) {
      return Promise.reject(err);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        finish(() => {
          try {
            this.throwIfAborted(signal);
          } catch (err: unknown) {
            reject(err);
          }
        });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      gate.then(
        () => finish(resolve),
        (err: unknown) => finish(() => reject(err)),
      ).catch((err: unknown) => finish(() => reject(err)));
    });
  }

  private async awaitAbortableOperation<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<T> {
    const bounded = this.withDeadline(
      operation,
      this.timings.terminalOperationTimeoutMs,
      label,
    );
    if (!signal) return bounded;
    try {
      this.throwIfAborted(signal);
    } catch (err: unknown) {
      throw err;
    }

    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          finish(() => {
            try {
              this.throwIfAborted(signal);
            } catch (err: unknown) {
              reject(err);
            }
          });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        bounded.then(
          (value) => finish(() => resolve(value)),
          (err: unknown) => finish(() => reject(err)),
        ).catch((err: unknown) => finish(() => reject(err)));
      });
    } catch (err: unknown) {
      throw err;
    }
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } catch (err: unknown) {
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private findTargetTab(tabs: Tab[], tabName = this.targetTab): Tab | undefined {
    const matches = (tab: Tab, name: string) => {
      const lower = name.toLowerCase();
      if (tab.title.toLowerCase().includes(lower)) return true;
      return Boolean(tab.cwd && basename(tab.cwd).toLowerCase().includes(lower));
    };
    return tabs.find((tab) => matches(tab, tabName))
      ?? (tabName !== this.targetTab
        ? tabs.find((tab) => matches(tab, this.targetTab))
        : undefined)
      ?? tabs.find((tab) => tab.title.toLowerCase().includes("claude"));
  }

  private assertSessionSafe(): void {
    if (!this.sessionUnsafeReason) return;
    throw new Error(
      `Brain session is quarantined (${this.sessionUnsafeReason}). Run a health check or restart the brain after Claude is idle.`,
    );
  }

  private markSessionUnsafe(reason: string): void {
    this.sessionUnsafeReason = reason;
    log("error", `Brain session quarantined: ${reason}`);
  }

  injectContext(context: string): void {
    this.turnContext.inject(context);
  }

  async restart(): Promise<void> {
    if (!this.acceptingTurns) throw new Error("Tab-inject brain is not running");
    this.turnContext.clear();
    if (!this.sessionUnsafeReason) {
      log("info", "Brain context buffer cleared (tab session preserved)");
      return;
    }

    try {
      await this.runSerialized(undefined, async () => {
        const tabs = await this.withDeadline(
          this.terminal.listTabs(),
          this.timings.terminalOperationTimeoutMs,
          "listing brain tabs during recovery",
        );
        const target = this.findTargetTab(tabs);
        if (!target) throw new Error(`Tab not found: "${this.targetTab}"`);
        await this.withDeadline(
          this.terminal.sendKey(target.id, "escape"),
          this.timings.interruptSendTimeoutMs,
          "sending the brain recovery key",
        );
        await this.waitForIdleAfterInterrupt(target.id);
        this.sessionUnsafeReason = null;
      });
      log("ok", "Brain session recovered and context buffer cleared");
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      this.markSessionUnsafe(reason);
      throw err;
    }
  }

  async health(): Promise<boolean> {
    if (!this.acceptingTurns) return false;
    try {
      if (!this.sessionUnsafeReason) {
        const tabs = await this.withDeadline(
          this.terminal.listTabs(),
          this.timings.terminalOperationTimeoutMs,
          "listing brain tabs for health",
        );
        return Boolean(this.findTargetTab(tabs));
      }

      return await this.runSerialized(undefined, async () => {
        const tabs = await this.withDeadline(
          this.terminal.listTabs(),
          this.timings.terminalOperationTimeoutMs,
          "listing brain tabs for recovery",
        );
        const target = this.findTargetTab(tabs);
        if (!target) return false;
        await this.waitForIdleAfterInterrupt(target.id);
        this.sessionUnsafeReason = null;
        log("ok", "Brain health check confirmed an idle session; quarantine cleared");
        return true;
      });
    } catch (err: unknown) {
      log("warn", `Brain health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Wait for the spawned brain tab to be ready (Claude Code showing ❯ prompt).
   */
  private async waitForBrainReady(): Promise<void> {
    const maxWaitMs = 30_000;
    const pollIntervalMs = 2000;
    const startTime = Date.now();

    // Give Claude Code a few seconds to start
    await Bun.sleep(3000);

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const tabs = await this.terminal.listTabs();
        const tab = tabs.find(t =>
          t.title.toLowerCase().includes(this.targetTab.toLowerCase())
        ) || tabs.find(t =>
          t.title.toLowerCase().includes("claude")
        );

        if (tab) {
          if (!this.ownedTabId) this.ownedTabId = tab.id;
          const screenText = await this.terminal.getText(tab.id);
          if (this.isClaudeCodeIdle(screenText)) {
            log("ok", `Brain tab ready (${Math.round((Date.now() - startTime) / 1000)}s)`);
            return;
          }
        }
      } catch {}

      await Bun.sleep(pollIntervalMs);
    }

    log("warn", "Brain tab may not be fully ready yet — will proceed anyway");
  }

  /**
   * Wait for Claude Code to finish by detecting the idle prompt (❯).
   *
   * Strategy:
   * 1. Wait for processing to start (screen changes from idle)
   * 2. Poll screen text until we see the ❯ prompt with stable content
   * 3. Handle permission prompts (Allow/Deny) if they appear
   * 4. Extract response between command and final prompt
   */
  private async waitForResponse(
    tabId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const maxWaitMs = this.timings.responseMaxWaitMs;
    const pollIntervalMs = this.timings.responsePollIntervalMs;
    const stableThreshold = this.timings.responseStableChecks;
    const startTime = Date.now();
    let stableCount = 0;
    let lastScreenText = "";
    let processingStarted = false;

    // Brief pause for Claude Code to start processing
    await this.sleepForTurn(this.timings.responseInitialDelayMs, signal);

    while (Date.now() - startTime < maxWaitMs) {
      this.throwIfAborted(signal);
      const screenText = await this.awaitAbortableOperation(
        this.terminal.getText(tabId),
        signal,
        "reading the brain screen",
      );
      this.throwIfAborted(signal);

      // Check for permission prompts and handle them
      const permissionHandled = await this.handlePermissionPrompt(tabId, screenText, signal);
      this.throwIfAborted(signal);
      if (permissionHandled) {
        stableCount = 0;
        lastScreenText = "";
        await this.sleepForTurn(pollIntervalMs, signal);
        continue;
      }

      const isIdle = this.isClaudeCodeIdle(screenText);

      // Detect when processing has started (screen changed from initial idle state)
      if (!processingStarted && !isIdle) {
        processingStarted = true;
        log("info", "Brain: Claude Code started processing");
      }

      // Only count stability after processing has started (or after 5s regardless)
      const canCheck = processingStarted
        || (Date.now() - startTime > this.timings.responseAssumeStartedAfterMs);

      if (canCheck && isIdle && screenText === lastScreenText) {
        stableCount++;
        if (stableCount >= stableThreshold) {
          // Try scrollback for complete response, fall back to screen
          const fullText = await this.awaitAbortableOperation(
            this.terminal.getText(tabId, "all"),
            signal,
            "reading the final brain response",
          );
          this.throwIfAborted(signal);
          const response = this.extractResponse(fullText || screenText, command);
          log("info", `Brain response (${Date.now() - startTime}ms): ${response.substring(0, 100)}${response.length > 100 ? "..." : ""}`);
          return response;
        }
      } else {
        stableCount = 0;
      }

      lastScreenText = screenText;
      await this.sleepForTurn(pollIntervalMs, signal);
    }

    throw new Error(`Brain response timed out after ${maxWaitMs}ms`);
  }

  private async waitForIdleAfterInterrupt(tabId: string): Promise<void> {
    const deadline = Date.now() + this.timings.interruptSettleTimeoutMs;
    let stableCount = 0;
    let previousScreen = "";
    try {
      while (Date.now() < deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const screenText = await this.withDeadline(
          this.terminal.getText(tabId),
          Math.min(this.timings.terminalOperationTimeoutMs, remainingMs),
          "reading the brain screen after interrupt",
        );
        if (this.isClaudeCodeIdle(screenText) && screenText === previousScreen) {
          stableCount++;
          if (stableCount >= this.timings.interruptStableChecks) return;
        } else {
          stableCount = 0;
        }
        previousScreen = screenText;
        const sleepMs = Math.min(
          this.timings.interruptPollIntervalMs,
          Math.max(0, deadline - Date.now()),
        );
        if (sleepMs > 0) await Bun.sleep(sleepMs);
      }
      throw new Error(
        `Brain interrupt did not reach a stable idle prompt within ${this.timings.interruptSettleTimeoutMs}ms`,
      );
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException(
      typeof signal.reason === "string" ? signal.reason : "Brain turn aborted",
      "AbortError",
    );
  }

  private sleepForTurn(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return Bun.sleep(ms);
    try {
      this.throwIfAborted(signal);
    } catch (err: unknown) {
      return Promise.reject(err);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        try {
          this.throwIfAborted(signal);
        } catch (err: unknown) {
          reject(err);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Detect and handle Claude Code permission prompts.
   * Returns true if a prompt was found and handled.
   */
  private async handlePermissionPrompt(
    tabId: string,
    screenText: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Claude Code permission patterns:
    // "Allow once" / "Allow always" / "Deny" buttons
    // "Do you want to allow..." text
    // Tool approval: shows tool name with Allow/Deny options
    const permissionPatterns = [
      /Allow\s+(once|always)/i,
      /\bAllow\b.*\bDeny\b/i,
      /Do you want to (allow|run|execute)/i,
      /Press.*to allow/i,
    ];

    const hasPermissionPrompt = permissionPatterns.some(p => p.test(screenText));

    if (!hasPermissionPrompt) return false;

    if (this.autoApproveTools) {
      log("info", "Brain: auto-approving tool permission");
      // Press 'y' to approve (Claude Code's default accept key)
      this.throwIfAborted(signal);
      await this.withDeadline(
        this.terminal.sendKey(tabId, "y"),
        this.timings.terminalOperationTimeoutMs,
        "approving a brain permission prompt",
      );
      await this.sleepForTurn(500, signal);
      return true;
    }

    // Not auto-approving — log it and let it sit
    log("warn", "Brain: permission prompt detected but auto-approve is off. Waiting for manual approval.");
    return false;
  }

  /**
   * Detect if Claude Code is idle (waiting for input).
   * The idle state shows ❯ prompt near the bottom of the screen.
   */
  private isClaudeCodeIdle(screenText: string): boolean {
    const lines = screenText.split("\n");
    // Look at the last ~10 lines for an idle prompt
    const tail = lines.slice(-10).join("\n");
    // ❯ followed by mostly empty space = idle prompt
    return /^❯\s*$/m.test(tail);
  }

  /**
   * Extract Claude's response from the screen/scrollback text.
   * Uses fuzzy command matching and strips TUI chrome.
   */
  private extractResponse(screenText: string, command: string): string {
    const lines = screenText.split("\n");

    // Find where our command appears — fuzzy match (first 60 chars)
    // The command may be wrapped or truncated on screen
    const cmdPrefix = command.trim().substring(0, 60);
    let commandLineIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cleaned = lines[i].replace(/^❯\s*/, "").trim();
      // Exact match or prefix match (for long commands that wrap)
      if (cleaned === command.trim() || (cmdPrefix.length >= 10 && cleaned.startsWith(cmdPrefix))) {
        commandLineIdx = i;
        break;
      }
    }

    // Find the final idle prompt (❯ with nothing after it)
    let promptLineIdx = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^❯\s*$/.test(lines[i])) {
        promptLineIdx = i;
        break;
      }
    }

    // Extract lines between command and final prompt
    let responseLines: string[];
    if (commandLineIdx >= 0 && commandLineIdx < promptLineIdx) {
      responseLines = lines.slice(commandLineIdx + 1, promptLineIdx);
    } else {
      // Fallback: grab everything above the prompt (last 40 lines max)
      responseLines = lines.slice(Math.max(0, promptLineIdx - 40), promptLineIdx);
    }

    return this.cleanResponse(responseLines.join("\n"));
  }

  private cleanResponse(text: string): string {
    return text
      // Strip ANSI escape codes (comprehensive: CSI, OSC, DCS, etc.)
      .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1B\][^\x07]*\x07/g, "")
      .replace(/\x1B[()][0-9A-B]/g, "")
      .replace(/\x1B\[[\d;]*m/g, "")
      // Strip Claude Code TUI chrome
      .replace(/^─+.*$/gm, "")                                   // horizontal rules
      .replace(/^.*bypass permissions.*$/gim, "")                  // bypass permission hint
      .replace(/^.*shift\+tab to cycle.*$/gim, "")               // tab cycle hint
      .replace(/^.*\b(ctx|opus|sonnet|haiku):\s*\d+%.*$/gim, "") // model/context stats
      .replace(/^.*⏵⏵.*$/gm, "")                                 // fast-forward markers
      .replace(/^.*auto-update.*$/gim, "")                        // auto-update notices
      .replace(/^.*compact.*ctrl\+o.*$/gim, "")                   // compact notices
      // Strip prompt characters
      .replace(/^❯\s*/gm, "")
      // Strip tool use blocks entirely (tool call + indented output)
      .replace(/^⏺\s*(Bash|Read|Write|Edit|Glob|Grep|Agent|Skill|WebSearch|WebFetch)\(.*$/gm, "")
      .replace(/^⏺\s*(Bash|Read|Write|Edit|Glob|Grep|Agent|Skill|WebSearch|WebFetch)\b.*$/gm, "")
      // Strip indented tool output lines (start with spaces after a tool call)
      .replace(/^\s{2,}(import |from |def |class |const |let |var |function |return |if |for |while |try |catch ).*$/gm, "")
      // Strip lines that look like code
      .replace(/^.*[{}\[\]();]=.*$/gm, "")
      // Clean up leading ⏺ markers (Claude's response bullets)
      .replace(/^⏺\s*/gm, "")
      // Clean up ⎿ output markers and their indented content
      .replace(/^\s*⎿\s*$/gm, "")
      .replace(/^\s*⎿\s+/gm, "")
      // Collapse multiple blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
