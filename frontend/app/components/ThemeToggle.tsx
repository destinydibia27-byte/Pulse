"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const KEY = "volo-theme";

/**
 * Light/dark switch. The first visit follows the device setting; clicking stores an explicit
 * choice. The attribute itself is set before the page paints by the inline script in layout.tsx,
 * so there is no flash of the wrong theme.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null); // null until mounted: avoids a server/browser mismatch

  useEffect(() => {
    const read = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    setTheme(read());
    // Follow the device setting live, but only while the person has not made their own choice.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(KEY); } catch {}
      if (stored === "light" || stored === "dark") return;
      const next: Theme = mq.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      setTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch {}
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button type="button" onClick={toggle} className="icon-btn" aria-label={label} title={label} disabled={theme === null}>
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "dark" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}
