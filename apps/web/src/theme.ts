import { create } from "zustand";
import { readPref, writePref } from "./storage";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const isPreference = (value: unknown): value is ThemePreference => value === "system" || value === "light" || value === "dark";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

function apply(preference: ThemePreference): void {
  document.documentElement.dataset["theme"] = resolveTheme(preference, darkQuery().matches);
}

interface ThemeState {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

/** Theme preference (per browser). "system" follows the OS setting, live. */
export const useTheme = create<ThemeState>((set) => ({
  preference: readPref("theme", "system", isPreference),
  setPreference: (preference) => {
    writePref("theme", preference);
    apply(preference);
    set({ preference });
  },
}));

/** Applies the stored theme now and keeps following the OS while the preference is "system". */
export function startTheme(): void {
  apply(useTheme.getState().preference);
  darkQuery().addEventListener("change", () => apply(useTheme.getState().preference));
}
