import { test, expect } from "bun:test";
import { matchCallMe } from "../src/call-intent";

test("dial-back phrasings match, with and without a name", () => {
  expect(matchCallMe("call me")).toEqual({});
  expect(matchCallMe("ring me please")).toEqual({});
  expect(matchCallMe("call me back")).toEqual({});
  expect(matchCallMe("hey jarvis call me")).toEqual({});
  expect(matchCallMe("have sage call me")).toEqual({ who: "sage" });
  expect(matchCallMe("ask remy to call me")).toEqual({ who: "remy" });
  expect(matchCallMe("get ada to ring me")).toEqual({ who: "ada" });
});

test("anyone-words ring without routing; ordinary sentences never match", () => {
  expect(matchCallMe("have someone call me")).toEqual({});
  expect(matchCallMe("cicero call me")).toEqual({});
  expect(matchCallMe("call me when it's done")).toBeNull();
  expect(matchCallMe("call me tomorrow")).toBeNull();
  expect(matchCallMe("they never call me anymore")).toBeNull();
  expect(matchCallMe("what do you call me")).toBeNull();
});

test("questions about calls are answered, not dialed — the 2026-07-13 live incident", () => {
  // Spoken "Did you call me?" arrived from STT without the "?" and captured
  // "did you" as an employee name, hijacking every rephrase into a dial-back.
  expect(matchCallMe("did you call me")).toBeNull();
  expect(matchCallMe("Did you call me?")).toBeNull();
  expect(matchCallMe("why did you call me")).toBeNull();
  expect(matchCallMe("did someone call me")).toBeNull();
  expect(matchCallMe("have you called me")).toBeNull();
  expect(matchCallMe("is it going to call me")).toBeNull();
  // Modal requests are rejected too — deliberately conservative:
  expect(matchCallMe("would you call me")).toBeNull();
  expect(matchCallMe("can you call me")).toBeNull();
  // The canonical commands still ring:
  expect(matchCallMe("call me")).toEqual({});
  expect(matchCallMe("hey cicero, call me")).toEqual({});
  expect(matchCallMe("have ada call me")).toEqual({ who: "ada" });
  expect(matchCallMe("onyx, ring me")).toEqual({ who: "onyx" });
});
