import { expect, test } from "bun:test";
import { isLocal, parsePrivacy, privacyOf, withAllowance } from "../../src/setup/privacy";
import { SETUP_STEPS } from "../../src/setup/steps";
import { SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";

test("parsePrivacy defaults allow to [] and rejects unknowns", () => {
  expect(parsePrivacy({ mode: "local" })).toEqual({ mode: "local", allow: [] });
  expect(parsePrivacy({ mode: "cloud", allow: ["board", "board"] })).toEqual({ mode: "cloud", allow: ["board"] });
  expect(() => parsePrivacy({ mode: "public" })).toThrow();
  expect(() => parsePrivacy({ mode: "cloud", allow: ["email"] })).toThrow();
  expect(() => parsePrivacy("local")).toThrow();
});

test("withAllowance unions without duplicates and needs an answered Privacy step", () => {
  const draft = { privacy: { mode: "local", allow: ["board"] } } as never;
  expect(withAllowance({ draft }, "agent")).toEqual({ privacy: { mode: "local", allow: ["board", "agent"] } });
  expect(withAllowance({ draft }, "board")).toEqual({ privacy: { mode: "local", allow: ["board"] } });
  expect(withAllowance({ draft: {} as never }, "agent")).toEqual({});
});

test("unanswered Privacy is treated as local", () => {
  expect(isLocal({ draft: {} as never })).toBe(true);
  expect(isLocal({ draft: { privacy: { mode: "cloud" } } as never })).toBe(false);
  expect(privacyOf({ draft: { privacy: { mode: "cloud" } } as never })).toEqual({ mode: "cloud", allow: [] });
});

test("Privacy is the first step and writes only the mode when nothing is allowed", async () => {
  expect(SETUP_STEPS[0]!.id).toBe("privacy");
  const session = new SetupSession(fixtureSystem("cuda24"));
  await session.choose("privacy", { mode: "local" }, { probe: false });
  expect(session.draft.privacy).toEqual({ mode: "local" });
  await session.choose("privacy", { mode: "cloud", allow: ["telegram"] }, { probe: false });
  expect(session.draft.privacy).toEqual({ mode: "cloud", allow: ["telegram"] });
});
