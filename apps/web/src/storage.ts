/**
 * Per-browser preferences (theme, sidebar, last project…). Storage can be unavailable
 * (private mode, blocked site data), so every access is guarded and falls back to the default.
 */
export function readPref<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(`gp.${key}`);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`gp.${key}`, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; losing one is fine.
  }
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isString = (value: unknown): value is string => typeof value === "string";
