import { expect, test } from "bun:test";
import { GEMMA_MODELS, fitWarnings, modelBudget, planFit, speechKind, speechReservationGb } from "../../src/setup/fit";
import { SetupSession } from "../../src/setup/session";
import { fixtureSystem } from "./fixtures";

const byId = (id: string) => GEMMA_MODELS.find((m) => m.id === id)!;

test.each([
  ["cuda24", "audiocpp", 19, "e4b", "26b-a4b", false],
  ["cuda16", "audiocpp", 11, "e4b", "e4b", true],
  ["mac32", "mlx", 17.2, "e4b", "12b", false],
  ["mac64", "mlx", 36.4, "e4b", "31b", false],
] as const)("%s worked example", (kind, speech, budget, helper, front, reuse) => {
  const b = modelBudget(fixtureSystem(kind), speech)!;
  expect(b.budgetGb).toBeCloseTo(budget, 5);
  const plan = planFit(b.budgetGb, "local");
  expect(plan.helper?.id).toBe(helper);
  expect(plan.frontDesk?.id).toBe(front);
  expect(plan.frontDeskReusesHelper).toBe(reuse);
});

test("footprints measured on CUDA are labeled estimates on a Mac", () => {
  expect(planFit(19, "local", "cuda").helper?.basis).toBe("measured");
  const mac = planFit(36.4, "local", "mlx");
  expect([mac.helper?.basis, mac.frontDesk?.basis]).toEqual(["estimate", "estimate"]);
  expect(byId("e4b").basis).toBe("measured");
});

test("front desk fits exactly at the boundary (15 of 15 GB left)", () => {
  expect(planFit(19, "local").frontDesk?.id).toBe("26b-a4b");
  expect(planFit(18.99, "local").frontDesk?.id).toBe("12b");
});

test("E2B fallback when E4B does not fit; the front desk must be larger than the helper", () => {
  const plan = planFit(3.9, "local");
  expect(plan.helper?.id).toBe("e2b");
  expect(plan.frontDesk?.id).toBe("e2b");
  expect(plan.frontDeskReusesHelper).toBe(true);
});

test("below E2B: local mode cannot run a helper; cloud mode runs without one", () => {
  expect(planFit(2.4, "local")).toMatchObject({ helper: null, frontDesk: null, localHelperImpossible: true });
  expect(planFit(2.4, "cloud")).toMatchObject({ helper: null, frontDesk: null, localHelperImpossible: false });
});

test("speech reservations: audio.cpp measured, Python and Mac estimates", () => {
  expect(speechReservationGb("audiocpp")).toEqual({ gb: 3.5, basis: "measured" });
  expect(speechReservationGb("python")).toEqual({ gb: 2, basis: "estimate" });
  expect(speechReservationGb("mlx")).toEqual({ gb: 2, basis: "estimate" });
  expect(speechKind("local-cuda", "audiocpp", "audiocpp")).toBe("audiocpp");
  expect(speechKind("local-cuda", "audiocpp", "kokoro")).toBe("python");
  expect(speechKind("local-mlx", "mlx-whisper", "mlx-audio")).toBe("mlx");
});

test("other GPU use is reported beside the budget, never subtracted", () => {
  const system = fixtureSystem("cuda24");
  if (system.gpu.status !== "ok") throw new Error("fixture");
  system.gpu.freeMiB = 20480;
  const b = modelBudget(system, "audiocpp")!;
  expect(b.budgetGb).toBeCloseTo(19, 5);
  expect(b.inUseByOthersGb).toBeCloseTo(4, 5);
});

test("CPU and Windows get no budget (out of scope)", () => {
  expect(modelBudget(fixtureSystem("cpu"), "python")).toBeNull();
  const windows = { ...fixtureSystem("cuda24"), platform: "win32" };
  expect(modelBudget(windows, "python")).toBeNull();
});

test("switching to a heavier speech stack surfaces a fit warning (Review Focus 1)", () => {
  const light = modelBudget(fixtureSystem("cuda24"), "python")!;
  expect(light.budgetGb).toBeCloseTo(20.5, 5);
  expect(fitWarnings(light, byId("e4b"), byId("26b-a4b"), false)).toEqual([]);
  const tight = { ...modelBudget(fixtureSystem("cuda24"), "audiocpp")!, budgetGb: 18 };
  expect(fitWarnings(tight, byId("e4b"), byId("26b-a4b"), false)[0]).toMatch(/no longer fit/);
  expect(fitWarnings(tight, byId("e4b"), byId("e4b"), true)).toEqual([]);
});

test("the Machine step reports the budget for the recommended speech stack, then the chosen one", async () => {
  const deps = { exists: () => false, probePort: async () => false, fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch };
  const session = new SetupSession(fixtureSystem("cuda24"));
  const before = await session.detect("system", deps) as { budget: { budgetGb: number; speech: { kind: string } }; fit: { frontDesk: { id: string } } };
  expect(before.budget.speech.kind).toBe("python");
  expect(before.budget.budgetGb).toBeCloseTo(20.5, 5);
  expect(before.fit.frontDesk.id).toBe("26b-a4b");
  await session.choose("stt", { id: "audiocpp" }, { probe: false });
  await session.choose("tts", { id: "audiocpp" }, { probe: false });
  const after = await session.detect("system", deps) as { budget: { budgetGb: number; speech: { kind: string; basis: string } } };
  expect(after.budget.speech).toMatchObject({ kind: "audiocpp", basis: "measured" });
  expect(after.budget.budgetGb).toBeCloseTo(19, 5);
});

test("pinned artifacts and verified runtime tags", () => {
  expect(GEMMA_MODELS.map((m) => m.id)).toEqual(["e2b", "e4b", "12b", "26b-a4b", "31b"]);
  expect(byId("e4b")).toMatchObject({ footprintGb: 4, basis: "measured", hfRepo: "google/gemma-4-E4B-it-qat-q4_0-gguf", ollamaTag: "gemma4:e4b-it-qat", lmStudioId: "lmstudio-community/gemma-4-E4B-it-QAT-GGUF" });
  expect(byId("26b-a4b")).toMatchObject({ footprintGb: 15, basis: "measured", ollamaTag: "gemma4:26b-a4b-it-qat" });
});
