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
