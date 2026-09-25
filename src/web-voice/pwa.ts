/**
 * PWA assets for the web-voice client: install Cicero to a phone's home screen
 * and it opens fullscreen like a native app. Served unauthenticated (they leak
 * nothing); the public `/app` shell reads the token persisted in localStorage
 * by the first tokened visit. The shell grants no access by itself — `/ws` and
 * every API stay bearer-token protected.
 */
import { BRAND_PAPER, brandMark } from "../brand";

// The shared brand mark (src/brand.ts), composited onto the app plate with
// explicit colors — the source uses currentColor, which a home-screen icon
// would render as black-on-transparent.
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#090d12"/>
<g transform="translate(51.2 51.2) scale(6.4)">${brandMark(BRAND_PAPER, "#BC8446")}</g>
</svg>`;

export const MANIFEST = JSON.stringify({
  name: "Cicero — Local Voice Agent",
  short_name: "Cicero",
  description: "Talk to your machine. Local voice in, pull requests out.",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  background_color: "#090d12",
  theme_color: "#090d12",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
});
