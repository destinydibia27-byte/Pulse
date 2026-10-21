import type { Config } from "tailwindcss";

// Volo brand tokens. Cyan is deliberately used only for focus rings and small accents:
// it fails contrast as text on white.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#05163D",
        brand: { DEFAULT: "#016BE5", dark: "#0155B8", soft: "#E8F1FD" },
        electric: "#10E1FF",
        surface: "#F2F2F2",
        line: "#DCE5F2",
        muted: "#64748B",
        success: { DEFAULT: "#16A34A", soft: "#E7F6EC" },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(5,22,61,0.04), 0 4px 16px rgba(5,22,61,0.05)",
      },
    },
  },
  plugins: [],
};
export default config;
