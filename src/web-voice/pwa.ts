/**
 * PWA assets for the web-voice client: install Cicero to a phone's home screen
 * and it opens fullscreen like a native app. Served unauthenticated (they leak
 * nothing); the public `/app` shell reads the token persisted in localStorage
 * by the first tokened visit. The shell grants no access by itself — `/ws` and
 * every API stay bearer-token protected.
 */

// The brand mark from assets/icon.svg (waveform → wire → speech), composited
// onto the app plate with explicit colors — the source uses currentColor,
// which a home-screen icon would render as black-on-transparent.
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#090d12"/>
<g transform="translate(51.2 51.2) scale(6.4) translate(7.48 10.18) scale(0.8727)">
  <g fill="none" stroke="#F5F4F0" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M2 25 H6 L8 15.6 L10 34.4 L12 11 L14 39 L16 18 L18 32 L20 25 H24"/><path d="M24 25 H52"/><path d="M32 25 C36 25 36 13.3 40 13.3 H44 C48 13.3 48 25 52 25"/>
  </g>
  <circle cx="24" cy="25" r="2.6" fill="#F5F4F0"/>
  <circle cx="42" cy="13.3" r="2.6" fill="#F5F4F0"/>
  <circle cx="52" cy="25" r="3.6" fill="#BC8446"/>
</g>
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
