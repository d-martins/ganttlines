import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../theme";
import { IconButton } from "../ui/button";

/** Matching the system → the look you don't have, so the click always shows → the other → back. */
export function nextTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemePreference {
  const [first, second]: ThemePreference[] = systemPrefersDark ? ["light", "dark"] : ["dark", "light"];
  return preference === "system" ? first! : preference === first ? second! : "system";
}

const NAMES: Record<ThemePreference, string> = { system: "matching your system", light: "light", dark: "dark" };
const ICONS: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** One click through the themes. Shows the current one; says what a click picks. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = ICONS[preference];
  const next = nextTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
  return (
    <IconButton label={`Theme: ${NAMES[preference]}. Switch to ${NAMES[next]}`} onClick={() => setPreference(next)}>
      <Icon size={16} />
    </IconButton>
  );
}
