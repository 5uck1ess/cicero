import { test, expect } from "bun:test";
import { parseAgentStep, agentStepSchema } from "../../src/compute/actions";

test("parses a bare JSON object", () => {
  const step = parseAgentStep('{"thought":"look","action":{"tool":"list_dir","args":{"path":"."}}}');
  expect(step.thought).toBe("look");
  expect(step.action.tool).toBe("list_dir");
  expect(step.action.args).toEqual({ path: "." });
});

test("parses JSON wrapped in a ```json fence", () => {
  const text = "Sure!\n```json\n{\"thought\":\"go\",\"action\":{\"tool\":\"finish\",\"args\":{\"summary\":\"done\"}}}\n```";
  const step = parseAgentStep(text);
  expect(step.action.tool).toBe("finish");
});

test("defaults missing args to an empty object", () => {
  const step = parseAgentStep('{"thought":"t","action":{"tool":"finish"}}');
  expect(step.action.args).toEqual({});
});

test("handles braces inside string values without truncating", () => {
  const step = parseAgentStep('{"thought":"use the } and { braces","action":{"tool":"finish","args":{"summary":"a {nested} note"}}}');
  expect(step.thought).toBe("use the } and { braces");
  expect(step.action.args).toEqual({ summary: "a {nested} note" });
});

test("handles escaped quotes inside string values", () => {
  const step = parseAgentStep('{"thought":"say \\"hi\\" }","action":{"tool":"finish","args":{}}}');
  expect(step.thought).toBe('say "hi" }');
  expect(step.action.tool).toBe("finish");
});

test("throws on text with no JSON object", () => {
  expect(() => parseAgentStep("I cannot help with that.")).toThrow("no JSON");
});

test("throws when action.tool is missing", () => {
  expect(() => parseAgentStep('{"thought":"t","action":{}}')).toThrow("tool");
});

test("agentStepSchema constrains tool to the given names", () => {
  const schema = agentStepSchema(["list_dir", "finish"]);
  const toolEnum = (((schema.properties as any).action.properties.tool) as any).enum;
  expect(toolEnum).toEqual(["list_dir", "finish"]);
});
