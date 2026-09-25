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
