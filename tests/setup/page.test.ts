import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brandLogo, brandMark } from "../../src/brand";
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

test("every step in ORDER has a seat in both overview layouts and a STEP entry", () => {
  const page = setupPage();
  const definitions = page.slice(page.indexOf("var ORDER ="), page.indexOf("function h("));
  const { ORDER, STEP } = new Function(`${definitions}; return { ORDER, STEP };`)();
  const seats = page.slice(page.indexOf("var seats = wide ? {"), page.indexOf("} : null;"));
  for (const id of ORDER) {
    expect(STEP[id]).toBeDefined();
    expect(STEP[id].short.length).toBeGreaterThan(0);
    expect(seats).toContain(`${id}: [`);
  }
  expect(ORDER[0]).toBe("privacy");
  // Parse the full generated browser script.
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Function(script)).not.toThrow();
});

test("the Privacy screen states it is a declared policy, not a firewall", () => {
  const page = setupPage();
  expect(page).toContain("function renderPrivacy(step)");
  expect(page).toContain("This is a declared policy, not a firewall.");
  expect(page).toContain("if (view === 'privacy') renderPrivacy(step);");
});

test("the Front desk screen offers model or agent, never MLX, and a no-key cloud list", () => {
  const page = setupPage();
  expect(page).toContain("if (view === 'frontdesk') renderFrontDesk(step);");
  expect(page).toContain("A model");
  expect(page).toContain("An agent");
  expect(page).toContain("Not sized for this machine");
  expect(page).toContain("api('/api/provider-models', { choice: { id: fields.preset.value } })");
  expect(page).not.toContain("id === 'provider'");
});
