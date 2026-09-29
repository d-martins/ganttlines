import { toDay, type DayNum, type TaskColor } from "@ganttlines/engine";

const MS_PER_DAY = 86_400_000;
const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** "Oct 5" */
export const formatDay = (day: DayNum) => short.format(new Date(day * MS_PER_DAY));

/** Parts of a day number (UTC, like the engine). */
export function dateParts(day: DayNum): { year: number; month: number; date: number } {
  const value = new Date(day * MS_PER_DAY);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth(), date: value.getUTCDate() };
}

/** Today in the viewer's own time zone, as the engine's day number. */
export function today(now = new Date()): DayNum {
  const pad = (n: number) => String(n).padStart(2, "0");
  return toDay(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
}

/** Bar fill and title color for a task color (theme tokens in styles.css). */
export function taskColors(color: TaskColor): { fill: string; ink: string } {
  const light = color === "orange" || color === "yellow";
  return { fill: `var(--task-${color})`, ink: light ? "var(--task-ink-light)" : "var(--task-ink)" };
}

/** A stable color for people without a team-member color (visitors, users without a member). */
export function colorFor(id: string): string {
  const palette = ["#4f8cff", "#e0569b", "#2fa86b", "#e5892f", "#8a63d2", "#1f9fa8", "#d2504b", "#6b7a90"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "just now", "5 minutes ago", "yesterday", "3 days ago" … then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  return full.format(new Date(iso));
}

/** The full date and time, for tooltips. */
export const fullTime = (iso: string) => full.format(new Date(iso));
