import { writable, get } from "svelte/store";

export type ThemeMode = "light" | "dark" | "system";

/** "system" is the startup mode; switching picks an explicit light or dark
 *  mode. It isn't persisted, so a restart follows the OS again. */
export const themeMode = writable<ThemeMode>("system");

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getEffectiveTheme(): "light" | "dark" {
  const mode = get(themeMode);
  if (mode === "system") return getSystemTheme();
  return mode;
}

export function applyCurrentTheme(): void {
  const html = globalThis.document?.documentElement;
  if (!html) return;

  if (getEffectiveTheme() === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

/**
 * Flip between light and dark. The decision uses the *effective* theme, so the
 * very first click is visible even while the mode is still "system": the old
 * cycle went system -> light, which looks like nothing happened on a light OS.
 * The DOM is updated here too, so a click still works if the listener in
 * +layout.svelte never registered (older WebViews may lack
 * MediaQueryList.addEventListener, which used to abort that function early).
 */
export function toggleTheme(): ThemeMode {
  const next: ThemeMode = getEffectiveTheme() === "dark" ? "light" : "dark";
  themeMode.set(next);
  applyCurrentTheme();
  return next;
}

export function initThemeListener(): void {
  // Subscribe before touching matchMedia. If the media query API is missing or
  // throws, the theme must still follow the store when the button is clicked.
  themeMode.subscribe(() => {
    applyCurrentTheme();
  });

  try {
    const mq = typeof window === "undefined"
      ? null
      : window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => applyCurrentTheme();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(onChange);
    }
  } catch {
    // OS theme changes just won't be followed; manual toggling still works.
  }
}
