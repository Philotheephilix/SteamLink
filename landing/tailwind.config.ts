import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui"],
        body: ["var(--font-body)", "ui-sans-serif", "system-ui"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Warm paper neutrals (never #fff / #000).
        // The ` / <alpha-value>` channel lets Tailwind opacity modifiers work.
        paper: "oklch(0.967 0.014 85 / <alpha-value>)",
        "paper-deep": "oklch(0.935 0.024 82 / <alpha-value>)",
        "paper-dark": "oklch(0.9 0.03 80 / <alpha-value>)",
        ink: "oklch(0.245 0.03 55 / <alpha-value>)",
        "ink-soft": "oklch(0.43 0.032 55 / <alpha-value>)",
        "ink-faint": "oklch(0.6 0.03 60 / <alpha-value>)",
        // Game-piece candy palette
        coral: "oklch(0.66 0.2 30 / <alpha-value>)",
        "coral-deep": "oklch(0.55 0.19 29 / <alpha-value>)",
        grape: "oklch(0.56 0.17 300 / <alpha-value>)",
        sky: "oklch(0.64 0.15 245 / <alpha-value>)",
        grass: "oklch(0.71 0.15 150 / <alpha-value>)",
        amber: "oklch(0.82 0.15 78 / <alpha-value>)",
        berry: "oklch(0.62 0.2 8 / <alpha-value>)",
        // merged game palettes
        felt: "#0d2818",
        uno: { red: "#e4002b", green: "#3aa935", blue: "#0073cf", yellow: "#ffcc00" },
      },
      boxShadow: {
        sticker: "4px 4px 0 0 oklch(0.245 0.03 55)",
        "sticker-sm": "3px 3px 0 0 oklch(0.245 0.03 55)",
        "sticker-lg": "7px 7px 0 0 oklch(0.245 0.03 55)",
        "sticker-coral": "5px 5px 0 0 oklch(0.55 0.19 29)",
      },
      borderRadius: {
        chunk: "1.25rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
