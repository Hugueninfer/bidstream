import { useCallback, useEffect, useState } from "react";
import { readStorage, writeStorage } from "./storage";

export type Theme = "light" | "dark";
const KEY = "bs-theme";
const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Dark mode via the `.dark` class: OS preference by default, user choice remembered once toggled. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    const m = mql();
    const onChange = () => {
      if (readStorage(KEY)) return; // explicit choice wins
      const t: Theme = m.matches ? "dark" : "light";
      apply(t);
      setTheme(t);
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      apply(next);
      writeStorage(KEY, next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
