import { useEffect } from "react";
import { useThemeStore } from "../stores/themeStore";
import { applyTheme } from "../lib/themeEngine";

export function useTheme() {
  const theme = useThemeStore((s) => s.currentTheme);
  const bgAlpha = useThemeStore((s) => s.bgAlpha);

  useEffect(() => {
    applyTheme(theme, bgAlpha);
  }, [theme, bgAlpha]);

  return theme;
}
