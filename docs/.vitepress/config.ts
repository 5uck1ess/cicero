import { defineConfig } from "vitepress";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/5uck1ess/cicero";
const assets = fileURLToPath(new URL("../../assets/", import.meta.url));

export default defineConfig({
  title: "Cicero",
  description: "Self-hosted voice layer for coding agents",
  base: "/cicero/",
  srcDir: "..",
  srcExclude: [
    "AGENTS.md",
    "CLAUDE.md",
    "bench/**",
    "requirements/**",
    "sidecars/**",
    "docs/superpowers/**",
  ],
  rewrites(id) {
    if (id === "README.md") return "index.md";
    if (id === "docs/README.md") return "documentation.md";
    if (id.startsWith("docs/")) return id.slice("docs/".length);
    return id;
  },
  vite: {
    resolve: {
      alias: [{ find: /^assets\//, replacement: assets }],
    },
  },
  markdown: {
    config(md) {
      const homepageLinks = new Map([
        [
          "sidecars/telegram-call/README.md",
          `${repository}/blob/main/sidecars/telegram-call/README.md`,
        ],
        ["LICENSE", `${repository}/blob/main/LICENSE`],
      ]);

      md.core.ruler.after("inline", "cicero-homepage-links", (state) => {
        for (const token of state.tokens) {
          if (token.type !== "inline" || !token.children) continue;
          for (const child of token.children) {
            if (child.type !== "link_open") continue;
            const href = child.attrGet("href");
            if (!href) continue;
            const replacement = homepageLinks.get(href);
            if (replacement) {
              child.attrSet("href", replacement);
              continue;
            }
            if (!href.startsWith("docs/")) continue;
            const [path, hash] = href.split("#", 2);
            const route =
              path === "docs/README.md"
                ? "/documentation"
                : `/${path.slice("docs/".length, -".md".length)}`;
            child.attrSet("href", hash ? `${route}#${hash}` : route);
          }
        }
      });
    },
  },
  themeConfig: {
    search: {
      provider: "local",
    },
    nav: [
      { text: "Documentation", link: "/documentation" },
      { text: "GitHub", link: repository },
    ],
    sidebar: [
      {
        text: "Understand it",
        items: [
          { text: "Project README", link: "/" },
          { text: "Architecture", link: "/architecture" },
          { text: "Why not full-duplex", link: "/duplex" },
          { text: "The office", link: "/office" },
        ],
      },
      {
        text: "Have your first conversation",
        items: [
          { text: "Setup", link: "/setup" },
          { text: "Choosing a brain", link: "/brains" },
          { text: "Configuration", link: "/configuration" },
        ],
      },
      {
        text: "Operate it",
        items: [
          { text: "Web voice", link: "/web-voice" },
          { text: "Daemon mode & local mic", link: "/daemon-mode" },
          { text: "Voice activation", link: "/voice-activation" },
          { text: "Turn detection", link: "/turn-detection" },
          { text: "Voice cloning", link: "/voice-cloning" },
          { text: "Notifications", link: "/notifications" },
          {
            text: "Telegram calls",
            link: `${repository}/blob/main/sidecars/telegram-call/README.md`,
          },
          { text: "Security", link: "/security" },
          { text: "What leaves the box", link: "/data-flows" },
        ],
      },
      {
        text: "Extend it",
        items: [
          {
            text: "Choosing a brain → custom drivers",
            link: "/brains",
          },
          {
            text: "Configuration → quick intents",
            link: "/configuration#quick-intents--your-own-zero-latency-phrases",
          },
          {
            text: "Python model servers",
            link: `${repository}/blob/main/requirements/README.md`,
          },
        ],
      },
      {
        text: "History",
        items: [
          { text: "Lessons learned", link: "/lessons-learned" },
          {
            text: "Performance & portability evaluation",
            link: "/performance-portability-evaluation",
          },
          {
            text: "Evaluation follow-up",
            link: "/evaluation-follow-up-2026-07",
          },
        ],
      },
    ],
  },
});
