import { expect, test } from "bun:test";
import { parseTermManifest, termHits, renderTable } from "../../bench/stt-bench";

test("term manifest and identifier hit rate are offline, phrase-aware and bounded", () => {
  const manifest = parseTermManifest(JSON.stringify({ clips: { sample: ["TypeGPU", "Cicero CLI"] } }));
  expect(manifest.sample).toEqual(["TypeGPU", "Cicero CLI"]);
  expect(termHits(manifest.sample!, "Use typegpu in the CICERO CLI")).toEqual({ hits: 2, total: 2 });
  expect(termHits(manifest.sample!, "typegpu and Cicero's CLI")).toEqual({ hits: 1, total: 2 });
  expect(termHits(["cat"], "concatenate")).toEqual({ hits: 0, total: 1 });
  expect(() => parseTermManifest(JSON.stringify({ clips: { sample: ["x".repeat(65)] } }))).toThrow();
  expect(() => parseTermManifest("x".repeat(65537))).toThrow();
  const table = renderTable([{ name: "test", kind: "batch", available: true, meanWerPct: 10, warmMs: 1, coldMs: 1, rtf: 1, errors: 0, clips: 1, termHits: 1, termTotal: 2 }], true);
  expect(table).toContain("term hit %");
  expect(table).toContain("50.0");
});
