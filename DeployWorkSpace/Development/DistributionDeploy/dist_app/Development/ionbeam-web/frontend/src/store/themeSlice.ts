/**
 * Theme selection. Persisted to localStorage and applied to the
 * <html> element via the `data-theme` attribute, which the CSS
 * variables in theme.css key off.
 *
 * Keeping this in Redux (rather than local state in Header) means
 * any component can read the active theme — useful for the canvas
 * painter if we later want theme-aware rendering tweaks (e.g. light
 * theme overlays would need different "no data" tints).
 */
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ThemeName = "navy" | "black" | "light";

const THEMES: ReadonlyArray<ThemeName> = ["navy", "black", "light"];
const STORAGE_KEY = "ionbeam.theme";

interface ThemeState {
  theme: ThemeName;
}

function loadInitial(): ThemeName {
  if (typeof window === "undefined") return "navy";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && (THEMES as readonly string[]).includes(v)) return v as ThemeName;
  } catch {
    /* localStorage may be disabled (e.g. file:// or private mode) */
  }
  return "navy";
}

const initialState: ThemeState = { theme: loadInitial() };

const slice = createSlice({
  name: "theme",
  initialState,
  reducers: {
    setTheme(state, a: PayloadAction<ThemeName>) {
      state.theme = a.payload;
    },
  },
});

export const { setTheme } = slice.actions;
export default slice.reducer;

/* -------- side-effect helpers ----------------------------------------- */

/**
 * Apply the active theme to <html> and persist it. Called once at boot
 * (with the hydrated initial value) and again on every change. Kept as a
 * function rather than middleware so it's trivially callable from a
 * useEffect; that also avoids ordering pitfalls with redux-toolkit's
 * listener middleware.
 */
export function applyThemeToDocument(theme: ThemeName): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
  } catch {
    /* see loadInitial */
  }
}

export const ALL_THEMES = THEMES;
