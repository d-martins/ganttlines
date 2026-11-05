import { weekday, type DayNum } from "@ganttlines/engine";
import type { HighlightDto } from "@ganttlines/protocol";
import { dateParts, formatDay } from "../format";
import { useHoveredMilestone, type AimedMilestone } from "./milestone-lines";
import type { Timeline, Zoom } from "./timeline";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Segment {
  key: string;
  left: number;
  right: number;
  label: string;
}

/** Consecutive visible days with the same key, as one labelled cell. */
function segments(timeline: Timeline, days: readonly DayNum[], keyOf: (day: DayNum) => string, labelOf: (day: DayNum) => string): Segment[] {
  const result: Segment[] = [];
  for (const day of days) {
    const key = keyOf(day);
    const last = result.at(-1);
    if (last?.key === key) last.right = timeline.xEnd(day);
    else result.push({ key, left: timeline.x(day), right: timeline.xEnd(day), label: labelOf(day) });
  }
  return result;
}

/** Sunday first, as `weekday` counts. */
const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const monday = (day: DayNum) => day - ((weekday(day) + 6) % 7);
const monthKey = (day: DayNum) => {
  const { year, month } = dateParts(day);
  return `${year}-${month}`;
};

/** Two header rows: months over days (day zoom), months over weeks (week), years over months (month). */
export function ChartHeader({
  timeline,
  zoom,
  days,
  highlights,
  holidays,
  todayDay,
  milestones = [],
  stickyLeft,
}: {
  timeline: Timeline;
  zoom: Zoom;
  /** the visible days in the viewport (plus overscan) */
  days: readonly DayNum[];
  highlights: readonly { day: DayNum; highlight: HighlightDto }[];
  /** holiday names by day */
  holidays: ReadonlyMap<DayNum, readonly string[]>;
  todayDay: DayNum;
  /** the milestones being aimed at, flagged where their line starts */
  milestones?: readonly AimedMilestone[];
  /** where the chart starts on screen: long labels stay readable there while their cell scrolls */
  stickyLeft: number;
}) {
  const hovered = useHoveredMilestone((state) => state.id);
  const top =
    zoom === "month"
      ? segments(timeline, days, (day) => String(dateParts(day).year), (day) => String(dateParts(day).year))
      : segments(timeline, days, monthKey, (day) => {
          const { year, month } = dateParts(day);
          return `${MONTHS[month]} ${year}`;
        });
  const bottom =
    zoom === "day"
      ? segments(timeline, days, String, (day) => String(dateParts(day).date))
      : zoom === "week"
        ? segments(timeline, days, (day) => String(monday(day)), (day) => formatDay(monday(day)))
        : segments(timeline, days, monthKey, (day) => MONTHS[dateParts(day).month]!);

  return (
    <div className="relative h-full shrink-0 bg-surface text-xs" style={{ width: timeline.width }}>
      {top.map((cell) => (
        <div
          key={cell.key}
          className="absolute top-0 h-6 overflow-clip border-b border-l border-border leading-6 font-semibold whitespace-nowrap"
          style={{ left: cell.left, width: cell.right - cell.left }}
        >
          <span className="sticky px-1.5" style={{ left: stickyLeft }}>
            {cell.label}
          </span>
        </div>
      ))}
      {milestones.map((milestone) => (
        <div
          key={milestone.id}
          data-testid="milestone-flag"
          data-hovered={hovered === milestone.id || undefined}
          title={milestone.title}
          className={`absolute top-1 z-10 max-w-[12ch] -translate-x-1/2 truncate rounded bg-[var(--target-line)] px-1 text-[10px] leading-4 font-semibold text-[var(--target-ink)] ${hovered === milestone.id ? "ring-2 ring-[var(--target-line)]" : ""}`}
          style={{ left: timeline.x(milestone.day) + timeline.dayWidth / 2 }}
        >
          {milestone.title}
        </div>
      ))}
      {bottom.map((cell) => {
        const isToday = zoom === "day" && cell.key === String(todayDay);
        const day = zoom === "day" ? Number(cell.key) : null;
        // A narrow week (zoomed out, weekends hidden) shows just its Monday's date: the month is in the row above.
        const weekLabel = zoom === "week" && cell.right - cell.left < 44 ? String(dateParts(monday(Number(cell.key))).date) : cell.label;
        return (
          <div
            key={cell.key}
            className={`absolute top-6 h-6 truncate border-b border-l border-border text-center ${day === null ? "leading-6" : "flex flex-col items-center justify-center leading-none"} ${isToday ? "font-bold text-[var(--today)]" : "text-muted"}`}
            style={{ left: cell.left, width: cell.right - cell.left }}
          >
            {day === null ? (
              zoom === "week" ? <span data-week>{weekLabel}</span> : cell.label
            ) : (
              <>
                <span data-weekday data-day={formatDay(day)} aria-hidden className="text-[9px] opacity-70">
                  {WEEKDAY_LETTERS[weekday(day)]}
                </span>
                <span>{cell.label}</span>
              </>
            )}
          </div>
        );
      })}
      {days.flatMap((day) => {
        const names = holidays.get(day);
        if (!names) return [];
        const label = names.join(", ");
        return [
          <div
            key={`holiday-${day}`}
            title={label}
            aria-label={`Holiday ${formatDay(day)}: ${label}`}
            className="absolute top-6 h-1 bg-[var(--holiday-stripe)]"
            style={{ left: timeline.x(day), width: timeline.xEnd(day) - timeline.x(day) }}
          />,
        ];
      })}
      {highlights.map(({ day, highlight }) => (
        <div
          key={highlight.id}
          title={highlight.label || undefined}
          aria-label={`Highlight ${formatDay(day)}${highlight.label ? `: ${highlight.label}` : ""}`}
          className="absolute bottom-0 h-1"
          style={{ left: timeline.x(day), width: timeline.xEnd(day) - timeline.x(day), background: highlight.color }}
        />
      ))}
    </div>
  );
}
