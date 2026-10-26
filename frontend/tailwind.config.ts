import type { Config } from "tailwindcss";

// Volo brand tokens. Every colour below is a CSS variable (see app/globals.css) so the same class
// names work in light and dark mode. Cyan is deliberately used only for focus rings and small
// accents: it fails contrast as text on white.
//
// Naming note: "navy" is the main TEXT colour (light text in dark mode), "card" is the raised
// surface (white in light mode), "surface" is the page background.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: v("navy"),
        brand: { DEFAULT: v("brand"), dark: v("brand-dark"), soft: v("brand-soft"), ink: v("brand-ink") },
        link: v("link"),
        electric: v("electric"),
        surface: v("surface"),
        card: v("card"),
        line: v("line"),
        muted: v("muted"),
        success: { DEFAULT: v("success"), soft: v("success-soft") },
        // Only the shades the UI actually uses. Their light values equal Tailwind's defaults.
        slate: { 100: v("slate-100"), 200: v("slate-200"), 400: v("slate-400"), 500: v("slate-500"), 600: v("slate-600"), 700: v("slate-700") },
        red: { 50: v("red-50"), 200: v("red-200"), 300: v("red-300"), 400: v("red-400"), 500: v("red-500"), 600: v("red-600"), 700: v("red-700"), 800: v("red-800"), 900: v("red-900") },
        amber: { 50: v("amber-50"), 300: v("amber-300"), 500: v("amber-500"), 700: v("amber-700"), 900: v("amber-900") },
        green: { 700: v("green-700"), 800: v("green-800"), 900: v("green-900") },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "Roboto", "sans-serif"],
      },
      boxShadow: {
        card: "var(--shadow-card)",
      },
    },
  },
  plugins: [],
};
export default config;
