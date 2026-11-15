import type { Config } from "tailwindcss";

/** Design tokens live in src/styles/index.css as `--bs-<name>` RGB channels (light in :root, dark under .dark). */
const token = (name: string) => `rgb(var(--bs-${name}) / <alpha-value>)`;

const colors = [
  "bg",
  "surface",
  "surface-2",
  "border",
  "border-strong",
  "text",
  "text-2",
  "text-3",
  "accent",
  "accent-text",
  "accent-soft",
  "good",
  "good-soft",
  "warn",
  "warn-soft",
  "bad",
  "bad-soft",
] as const;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      screens: {
        // AppShell wraps (drawer stacks below content) under 900 px.
        shell: "900px",
      },
      colors: Object.fromEntries(colors.map((c) => [c, token(c)])),
      borderColor: { DEFAULT: token("border") },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        display: ["30px", { lineHeight: "38px", fontWeight: "600" }],
        "title-1": ["22px", { lineHeight: "28px", fontWeight: "600" }],
        "title-2": ["16px", { lineHeight: "24px", fontWeight: "600" }],
        section: ["14px", { lineHeight: "20px", fontWeight: "600" }],
        body: ["14px", { lineHeight: "20px" }],
        label: ["13px", { lineHeight: "18px", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "16px" }],
        mono: ["12px", { lineHeight: "18px" }],
        "mono-xs": ["11px", { lineHeight: "16px" }],
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "8px",
        xl: "10px",
        "2xl": "12px",
      },
      keyframes: {
        flash: {
          "0%, 70%": { backgroundColor: "rgb(var(--bs-accent-soft))" },
          "100%": { backgroundColor: "transparent" },
        },
        "sheet-in": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
      },
      animation: {
        flash: "flash 2.6s ease-out",
        "sheet-in": "sheet-in 180ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
