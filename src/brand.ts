/**
 * The Cicero brand, shared by every served page. The mark geometry mirrors
 * assets/icon.svg (waveform → wire → speech); the full logo with wordmark is
 * read from assets/logo-{light,dark}.svg so there is one source of truth.
 */
import { readFileSync } from "node:fs";

export const BRAND_PAPER = "#F5F4F0";

/** Mark body on the 64-unit icon grid; strokes use `ink`, the speech dot uses `accent`. */
export function brandMark(ink: string, accent: string): string {
  return `<g transform="translate(7.48 10.18) scale(0.8727)">
  <g fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 25 H6 L8 15.6 L10 34.4 L12 11 L14 39 L16 18 L18 32 L20 25 H24"/><path d="M24 25 H52"/><path d="M32 25 C36 25 36 13.3 40 13.3 H44 C48 13.3 48 25 52 25"/>
  </g>
  <circle cx="24" cy="25" r="2.6" fill="${ink}"/>
  <circle cx="42" cy="13.3" r="2.6" fill="${ink}"/>
  <circle cx="52" cy="25" r="3.6" fill="${accent}"/>
</g>`;
}

/** The full logo for a theme, or null when the checkout's assets are missing. */
export function brandLogo(theme: "light" | "dark"): string | null {
  try {
    return readFileSync(new URL(`../assets/logo-${theme}.svg`, import.meta.url), "utf8");
  } catch {
    return null; // callers fall back to the mark plus a text wordmark
  }
}
