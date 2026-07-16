import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrivateJsonTooLargeError,
  readPrivateJson,
  writePrivateJson,
} from "../../src/platform/private-json";

const roots: string[] = [];

function freshFile(): string {
  const root = mkdtempSync(join(tmpdir(), "cicero-private-json-"));
  roots.push(root);
  return join(root, "state.json");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a durable atomic write publishes a present, parseable file", async () => {
  const file = freshFile();
  await writePrivateJson(file, { day: "2026-07-15", claimed: true });

  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-07-15", claimed: true });
  expect(await readPrivateJson(file)).toEqual({ day: "2026-07-15", claimed: true });
});

test("reads reject an oversized private JSON file before retaining its contents", async () => {
  const file = freshFile();
  writeFileSync(file, `"${"x".repeat(64)}"`, { mode: 0o600 });

  await expect(readPrivateJson(file, 32)).rejects.toBeInstanceOf(PrivateJsonTooLargeError);
});
