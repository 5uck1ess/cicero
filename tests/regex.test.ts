import { expect, test } from "bun:test";
import { compileLiteralTemplate } from "../src/regex";

test("literal templates preserve the router's historical greedy slot allocation", () => {
  const { regex, paramNames } = compileLiteralTemplate("in {tab} tab run {command}");
  const match = "in sales tab run echo tab run deploy".match(regex);

  expect(paramNames).toEqual(["tab", "command"]);
  expect(match?.slice(1)).toEqual(["sales tab run echo", "deploy"]);
});

test("compiled action templates are reused across classifications", () => {
  const first = compileLiteralTemplate("open [docs] in {tab}");
  const second = compileLiteralTemplate("open [docs] in {tab}");

  expect(second).toBe(first);
  expect("open [docs] in working".match(second.regex)?.[1]).toBe("working");
});
