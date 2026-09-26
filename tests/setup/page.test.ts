import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brandLogo, brandMark } from "../../src/brand";
import { detectRouter, LAYA_LANES_REQUIRED } from "../../src/setup/pickers";
import { createDraft } from "../../src/setup/draft";
import type { StepContext } from "../../src/setup/steps";
import { setupPage } from "../../src/setup/page";
import { ICON_SVG } from "../../src/web-voice/pwa";

test("setup page and PWA icon share the brand assets", () => {
  const page = setupPage();
  const light = readFileSync(new URL("../../assets/logo-light.svg", import.meta.url), "utf8");
  expect(brandLogo("light")).toBe(light);
  expect(page).toContain(light);
  expect(page).toContain(brandLogo("dark")!);
  expect(page).toContain('rel="icon" href="data:image/svg+xml,');
  const iconPaths = readFileSync(new URL("../../assets/icon.svg", import.meta.url), "utf8").match(/<path d="[^"]+"\/>/g)!;
  for (const path of iconPaths) {
    expect(brandMark("x", "y")).toContain(path);
    expect(ICON_SVG).toContain(path);
  }
});

test("a failed choice probe keeps the operator on that step", () => {
  const page = setupPage();
  const source = page.match(/function blockedByProbe\(s\) \{[^\n]+\}/)![0];
  const blockedByProbe = new Function(`${source}; return blockedByProbe;`)() as (s: unknown) => string | null;
  expect(blockedByProbe({ detected: { probe: { ok: false, message: "Board probe failed; check CLI setup and retry" } } })).toBe("Board probe failed; check CLI setup and retry");
  expect(blockedByProbe({ detected: { probe: { ok: true, message: "Found 3 tasks" } } })).toBeNull();
  expect(blockedByProbe({ detected: {} })).toBeNull();
  // Continue re-renders the same step instead of navigating on a failed probe.
  expect(page).toMatch(/state = await api\('\/api\/choice', \{ id: id, choice: c \}\);\s+if \(blockedByProbe\(state\)\) \{ render\(\); return; \}\s+await go\(next\(id\)\);/);
});

test("CUDA speech cards distinguish audio.cpp from the Python sidecar and explain model provisioning", () => {
  const page = setupPage();
  expect(page).toContain("Nemotron (audio.cpp)");
  expect(page).toContain("Pocket TTS (audio.cpp)");
  expect(page).toContain("Pocket TTS (Python)");
  expect(page).toContain("Fast, accurate English ASR with Nemotron’s streaming model on an NVIDIA GPU; needs the audio.cpp build.");
  expect(page).toContain("Model weights are installed manually.");
  expect(page).toContain("scripts/provision-audiocpp.sh");
});

test("setup page lists the router after provider with checkpoint guidance and the documented start command", () => {
  const page = setupPage();
  const definitions = page.slice(page.indexOf("var ORDER ="), page.indexOf("function h("));
  const { ORDER, STEP, NAMES, NOTES, GUIDES } = new Function(`${definitions}; return { ORDER, STEP, NAMES, NOTES, GUIDES };`)();
  expect(ORDER[ORDER.indexOf("provider") + 1]).toBe("router");
  expect(STEP.router).toMatchObject({ short: "Route", title: "How should Cicero route requests?", sub: "Intent router" });
  expect(STEP.router.lede.length).toBeGreaterThan(0);
  expect(NAMES.llm).toBe("LLM prompt (default)");
  expect(NAMES.laya).toBe("Laya sidecar (checkpoint required)");
  for (const text of [NOTES.laya, GUIDES.laya[0][0]]) {
    for (const phrase of ["does not route zero-shot", "fine-tuned switchboard checkpoint", "bring-your-own", "synthetic data only", "fine-tuning recipe", "planned follow-up"]) expect(text).toContain(phrase);
  }
  expect(GUIDES.laya[0][1]).toEndWith("/sidecars/laya-switchboard/README.md");
  const readme = readFileSync(new URL("../../sidecars/laya-switchboard/README.md", import.meta.url), "utf8");
  expect(readme.replace(/\\\n\s+/g, "")).toContain(GUIDES.laya[1][1]);
  expect(page).toContain("field('Laya sidecar URL', fields.url)");
  // Both responsive overview layouts must contain a navigable router node.
  expect(page.match(/router: \[\d+, \d+\]/g)).toHaveLength(2);
  // Parse the full generated browser script, including the new picker branch.
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Function(script)).not.toThrow();
});

test("router cards disable Laya without lanes and show the office guidance", async () => {
  const page = setupPage();
  const draw = page.slice(page.indexOf("  function draw() {"), page.indexOf("  var fields = {};"));
  const definitions = page.slice(page.indexOf("var ORDER ="), page.indexOf("function h("));
  const render = new Function("f", `
    ${definitions}
    var id = 'router', picked = 'llm', extra = null, options = f.options;
    var cards = [];
    var group = { querySelectorAll: () => [], append: card => cards.push(card) };
    var document = { createTextNode: text => ({ text }) };
    function h(tag, attrs, children) { return { tag, ...attrs, children }; }
    function stateLabel() { return null; }
    function optionName(id, o) { return NAMES[o]; }
    ${draw}
    draw();
    return cards;
  `);
  const draft = createDraft("local-cpu");
  for (const hasLanes of [false, true]) {
    draft.brain.lanes = hasLanes ? { coder: {} } : {};
    const detected = await detectRouter({ draft } as StepContext);
    const cards = render(detected);
    const laya = cards.find((card: any) => card.children[0].value === "laya");
    expect(laya.children[0].disabled).toBe(!hasLanes);
    expect(laya.children[2].text).toBe("Laya sidecar (checkpoint required)");
    expect(laya.children[3].text.includes(LAYA_LANES_REQUIRED)).toBe(!hasLanes);
    expect(cards[0].children[0].disabled).toBe(false);
    expect(cards[0].children[0].checked).toBe(true);
  }
});
