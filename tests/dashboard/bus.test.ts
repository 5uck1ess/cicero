import { test, expect } from "bun:test";
import { dashBus } from "../../src/dashboard/bus";

test("boot 'listener ready' message does not flip the pill to listening", () => {
  dashBus.setState("speaking"); // start from a non-idle state to prove it resets
  dashBus.log("✓", "Conversational listener ready (say 'stop listening' or 'goodbye' to deactivate)");
  expect(dashBus.state).toBe("idle");
});

test("actual activation message flips the pill to listening", () => {
  dashBus.setState("idle");
  dashBus.log("✓", "Conversational mode activated — listening...");
  expect(dashBus.state).toBe("listening");
});

test("deactivation returns the pill to idle", () => {
  dashBus.setState("listening");
  dashBus.log("✓", "Conversational mode deactivated");
  expect(dashBus.state).toBe("idle");
});

test("activation/deactivation logs drive voiceActive for the toggle button", () => {
  dashBus.setVoiceActive(false);
  dashBus.log("✓", "Conversational mode activated — listening...");
  expect(dashBus.voiceActive).toBe(true);
  dashBus.log("✓", "Conversational mode deactivated");
  expect(dashBus.voiceActive).toBe(false);
});

test("setVoiceActive emits a voice event only on change and is in the snapshot", () => {
  dashBus.setVoiceActive(false);
  const events: string[] = [];
  const unsub = dashBus.subscribe((e) => { if (e.type === "voice") events.push(String(e.voiceActive)); });
  dashBus.setVoiceActive(true);
  dashBus.setVoiceActive(true); // no-op, must not emit again
  dashBus.setVoiceActive(false);
  unsub();
  expect(events).toEqual(["true", "false"]);
  dashBus.setVoiceActive(true);
  expect(dashBus.snapshot().voiceActive).toBe(true);
});
