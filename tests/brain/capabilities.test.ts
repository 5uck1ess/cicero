import { expect, test } from "bun:test";
import { FallbackBrain } from "../../src/brain/fallback";
import { QuickIntentsBrain } from "../../src/brain/quick-intents";
import { RoutingBrain } from "../../src/brain/routing";
import { SwitchboardBrain } from "../../src/brain/switchboard";
import type { Brain } from "../../src/types";

class CapableBrain implements Brain {
  readonly calls: string[] = [];
  readonly confirmationNonce = crypto.randomUUID();
  pending = true;
  target = "home";

  constructor(readonly name: string) {}

  start(): Promise<void> { this.calls.push("start"); return Promise.resolve(); }
  stop(): Promise<void> { this.calls.push("stop"); return Promise.resolve(); }
  restart(): Promise<void> { this.calls.push("restart"); return Promise.resolve(); }
  health(): Promise<boolean> { this.calls.push("health"); return Promise.resolve(true); }
  injectContext(context: string): void { this.calls.push(`context:${context}`); }
  send(message: string): Promise<string> {
    this.calls.push(`send:${message}`);
    return Promise.resolve(`${this.name}:${message}`);
  }
  streamProgress(message: string): AsyncIterable<string> {
    this.calls.push(`progress:${message}`);
    const reply = `${this.name}:progress:${message}`;
    return (async function* (): AsyncIterable<string> { yield reply; })();
  }
  sendToTab(message: string, tabName: string): Promise<string> {
    this.calls.push(`sendToTab:${message}:${tabName}`);
    return Promise.resolve(`${this.name}:${tabName}:${message}`);
  }
  switchTab(tabName: string): void { this.calls.push(`switchTab:${tabName}`); this.target = tabName; }
  getTargetTab(): string { this.calls.push("getTargetTab"); return `${this.name}:${this.target}`; }
  activeLane(): string | null { this.calls.push("activeLane"); return this.name; }
  transferTo(ref: string, brief?: (lane: string) => Promise<string | null>): Promise<string | null> {
    this.calls.push(`transferTo:${ref}:${brief ? "brief" : "plain"}`);
    return Promise.resolve(`${this.name}:${ref}`);
  }
  activeLaneVoice(): string | undefined { this.calls.push("activeLaneVoice"); return `${this.name}-voice`; }
  wasControlTurn(): boolean { this.calls.push("wasControlTurn"); return true; }
  hasPendingConfirmation(): boolean { this.calls.push("hasPendingConfirmation"); return this.pending; }
  pendingConfirmations(): readonly [{ nonce: string; summary: string }] | [] {
    return this.pending ? [{ nonce: this.confirmationNonce, summary: `${this.name} gate` }] : [];
  }
  resolvePendingConfirmation(approved: boolean, nonce: string): boolean {
    this.calls.push(`resolvePendingConfirmation:${approved}:${nonce}`);
    if (!this.pending || nonce !== this.confirmationNonce) return false;
    this.pending = false;
    return true;
  }
}

function bareBrain(name: string, send?: (message: string) => Promise<string>): Brain {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    health: () => Promise.resolve(true),
    injectContext: () => {},
    send: send ?? ((message) => Promise.resolve(`${name}:${message}`)),
  };
}

async function drain(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
    return chunks;
  } catch (error) {
    throw error;
  }
}

test("QuickIntentsBrain preserves and binds every optional inner capability", async () => {
  const inner = new CapableBrain("inner");
  inner.pending = false;
  const brain = new QuickIntentsBrain(inner, [{ phrases: ["local status"], reply: "All local." }]);
  const brief = (_lane: string): Promise<string | null> => Promise.resolve("context");

  expect(await drain(brain.streamProgress!("local status"))).toEqual(["All local."]);
  expect(inner.calls).not.toContain("progress:local status");
  expect(brain.wasControlTurn()).toBe(true);
  expect(await drain(brain.streamProgress!("work"))).toEqual(["inner:progress:work"]);
  expect(await brain.sendToTab!("status", "ops")).toBe("inner:ops:status");
  brain.switchTab!("build");
  expect(brain.getTargetTab!()).toBe("inner:build");
  expect(brain.activeLane!()).toBe("inner");
  expect(await brain.transferTo!("coder", brief)).toBe("inner:coder");
  expect(brain.activeLaneVoice!()).toBe("inner-voice");
  inner.pending = true;
  expect(brain.hasPendingConfirmation!()).toBe(true);
  expect(brain.resolvePendingConfirmation!(true, inner.confirmationNonce)).toBe(true);
  expect(inner.calls).toContain(`resolvePendingConfirmation:true:${inner.confirmationNonce}`);
});

test("QuickIntentsBrain leaves unsupported optional capabilities absent", () => {
  const brain = new QuickIntentsBrain(bareBrain("bare"), []);

  expect(brain.streamProgress).toBeUndefined();
  expect(brain.sendToTab).toBeUndefined();
  expect(brain.switchTab).toBeUndefined();
  expect(brain.getTargetTab).toBeUndefined();
  expect(brain.activeLane).toBeUndefined();
  expect(brain.transferTo).toBeUndefined();
  expect(brain.activeLaneVoice).toBeUndefined();
  expect(brain.hasPendingConfirmation).toBeUndefined();
  expect(brain.pendingConfirmations).toBeUndefined();
  expect(brain.resolvePendingConfirmation).toBeUndefined();
});

test("RoutingBrain delegates capabilities to the lane selected for the turn", async () => {
  const primary = new CapableBrain("primary");
  const escalation = new CapableBrain("think");
  const brain = new RoutingBrain(primary, escalation);
  await brain.start();

  expect(await drain(brain.streamProgress!("ordinary work"))).toEqual(["primary:progress:ordinary work"]);
  brain.injectContext("deep context");
  expect(await drain(brain.streamProgress!("think hard about this"))).toEqual(["think:progress:think hard about this"]);
  expect(escalation.calls.indexOf("context:deep context")).toBeLessThan(escalation.calls.indexOf("progress:think hard about this"));
  expect(await brain.sendToTab!("status", "ops")).toBe("think:ops:status");
  brain.switchTab!("analysis");
  expect(brain.getTargetTab!()).toBe("think:analysis");
  expect(await brain.transferTo!("reviewer")).toBe("think:reviewer");
  expect(brain.hasPendingConfirmation!()).toBe(true);
  expect(brain.resolvePendingConfirmation!(false, escalation.confirmationNonce)).toBe(true);
  expect(escalation.calls).toContain(`resolvePendingConfirmation:false:${escalation.confirmationNonce}`);
  expect(primary.calls).not.toContain(`resolvePendingConfirmation:false:${escalation.confirmationNonce}`);
});

test("RoutingBrain does not advertise a capability missing from a selectable lane", async () => {
  const primary = new CapableBrain("primary");
  const brain = new RoutingBrain(primary, bareBrain("think"));
  await brain.start();

  expect(brain.streamProgress).toBeUndefined();
  expect(typeof brain.switchTab).toBe("function");
  await brain.send("think hard about this");
  expect(brain.switchTab).toBeUndefined();
  // Approval capabilities are global to the wrapper: changing lanes must not
  // orphan a gate that the primary lane armed earlier.
  expect(typeof brain.hasPendingConfirmation).toBe("function");
  expect(brain.pendingConfirmations!()[0]!.nonce).toBe(primary.confirmationNonce);
});

test("FallbackBrain preserves progress fallback and follows the active tier's capabilities", async () => {
  const primary = new CapableBrain("primary");
  primary.streamProgress = (_message: string): AsyncIterable<string> => (async function* () {
    throw new Error("primary unavailable");
  })();
  const backup = new CapableBrain("backup");
  const brain = new FallbackBrain([primary, backup], "qa");

  expect(await drain(brain.streamProgress!("work"))).toEqual([
    "On the backup line. ",
    "backup:progress:work",
  ]);
  expect(brain.getTargetTab!()).toBe("backup:home");
  expect(await brain.transferTo!("reviewer")).toBe("backup:reviewer");
  expect(brain.hasPendingConfirmation!()).toBe(true);
  expect(brain.resolvePendingConfirmation!(true, backup.confirmationNonce)).toBe(true);
  expect(backup.calls).toContain(`resolvePendingConfirmation:true:${backup.confirmationNonce}`);
});

test("FallbackBrain capability discovery tracks heterogeneous tier selection", async () => {
  const primary = new CapableBrain("primary");
  primary.send = (_message: string): Promise<string> => Promise.reject(new Error("primary unavailable"));
  const brain = new FallbackBrain([primary, bareBrain("backup")], "qa");

  expect(brain.streamProgress).toBeUndefined();
  expect(typeof brain.transferTo).toBe("function");
  expect(typeof brain.hasPendingConfirmation).toBe("function");
  expect(await brain.send("hello")).toBe("On the backup line. backup:hello");
  expect(brain.transferTo).toBeUndefined();
  expect(typeof brain.hasPendingConfirmation).toBe("function");
  expect(brain.pendingConfirmations!()[0]!.nonce).toBe(primary.confirmationNonce);
});

test("FallbackBrain restores the previously served tier after a full-ladder failure", async () => {
  const primary = new CapableBrain("primary");
  primary.send = (_message: string): Promise<string> => Promise.reject(new Error("primary unavailable"));
  const backup = new CapableBrain("backup");
  const reserve = new CapableBrain("reserve");
  const brain = new FallbackBrain([primary, backup, reserve], "qa");

  expect(await brain.send("first")).toBe("On the backup line. backup:first");
  expect(brain.getTargetTab!()).toBe("backup:home");

  backup.send = (_message: string): Promise<string> => Promise.reject(new Error("backup unavailable"));
  reserve.send = (_message: string): Promise<string> => Promise.reject(new Error("reserve unavailable"));
  await expect(brain.send("second")).rejects.toThrow("reserve unavailable");

  expect(brain.getTargetTab!()).toBe("backup:home");
});

test("SwitchboardBrain preserves its control plane while forwarding active-line capabilities", async () => {
  const front = new CapableBrain("front");
  const coder = new CapableBrain("coder");
  const brain = new SwitchboardBrain(front, { coder: { brain: coder } });
  await brain.start();

  expect(await drain(brain.streamProgress!("talk to coder"))).toEqual(["Coder here."]);
  expect(brain.activeLane()).toBe("coder");
  expect(front.calls).not.toContain("progress:talk to coder");

  brain.injectContext("ship context");
  expect(await drain(brain.streamProgress!("build it"))).toEqual(["coder:progress:build it"]);
  expect(coder.calls.indexOf("context:ship context")).toBeLessThan(coder.calls.indexOf("progress:build it"));
  expect(await brain.sendToTab!("status", "ops")).toBe("coder:ops:status");
  brain.switchTab!("analysis");
  expect(brain.getTargetTab!()).toBe("coder:analysis");
});

test("SwitchboardBrain leaves active-line capabilities absent when unsupported", async () => {
  const brain = new SwitchboardBrain(new CapableBrain("front"), {
    helper: { brain: bareBrain("helper") },
  });
  await brain.start();

  expect(typeof brain.streamProgress).toBe("function");
  expect(await drain(brain.streamProgress!("talk to helper"))).toEqual(["Helper here."]);
  expect(brain.streamProgress).toBeUndefined();
  expect(brain.sendToTab).toBeUndefined();
  expect(brain.switchTab).toBeUndefined();
  expect(brain.getTargetTab).toBeUndefined();
});
