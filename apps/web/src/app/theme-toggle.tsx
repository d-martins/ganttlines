import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { resolveTheme, useTheme } from "../theme";
import { IconButton } from "../ui/button";

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");
const subscribe = (onChange: () => void) => {
  const query = darkQuery();
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * One click between light and dark (the account menu still offers "System"). Shows what a click
 * switches to; follows the OS while the preference is "system".
 */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const systemDark = useSyncExternalStore(subscribe, () => darkQuery().matches);
  const dark = resolveTheme(preference, systemDark) === "dark";
  return (
    <IconButton label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setPreference(dark ? "light" : "dark")}>
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </IconButton>
  );
}
