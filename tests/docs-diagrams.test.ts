import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8");
const mermaid = (text: string) => [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "superpowers" || name === "vendor") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

test.each(["README.md", "docs/architecture.md", "docs/setup.md", "docs/concepts.md"])("%s carries a Mermaid diagram", (path) => {
  expect(mermaid(read(path)).length).toBeGreaterThan(0);
});

test("the retired setup screenshot is not referenced", () => {
  for (const path of [...markdownFiles("docs"), "README.md"]) expect(read(path)).not.toContain("setup-overview.png");
});

test("architecture drops the ASCII pipeline", () => {
  expect(read("docs/architecture.md")).not.toMatch(/[┌└│▼]/);
});

test("no diagram presents faster-whisper or Laya as the default path", () => {
  for (const path of ["README.md", "docs/architecture.md", "docs/setup.md", "docs/concepts.md"]) {
    for (const diagram of mermaid(read(path))) {
      expect(diagram).not.toContain("faster-whisper");
      expect(diagram).not.toContain("Laya");
    }
  }
});

test("the turn diagram shows escalation and the helper", () => {
  const turn = mermaid(read("README.md"))[0]!;
  expect(turn).toContain("Front desk");
  expect(turn).toContain("escalat");
  expect(turn).toContain("Helper");
});
