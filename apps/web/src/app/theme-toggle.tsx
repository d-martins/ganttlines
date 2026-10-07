import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemePreference } from "../theme";
import { IconButton } from "../ui/button";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const NAMES: Record<ThemePreference, string> = { system: "matching your system", light: "light", dark: "dark" };
const ICONS: Record<ThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

/** One click through the themes: match my system → light → dark. Shows the current one; says what a click picks. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = ICONS[preference];
  const next = NEXT[preference];
  return (
    <IconButton label={`Theme: ${NAMES[preference]}. Switch to ${NAMES[next]}`} onClick={() => setPreference(next)}>
      <Icon size={16} />
    </IconButton>
  );
}
