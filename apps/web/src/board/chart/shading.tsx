import { weekday, type Calendar, type DayNum } from "@ganttlines/engine";
import type { CalendarDto, HighlightDto } from "@ganttlines/protocol";
import type { BoardRow } from "../model";
import type { Timeline } from "./timeline";

const HOLIDAY = "repeating-linear-gradient(135deg, var(--holiday) 0 5px, var(--holiday-stripe) 5px 10px)";
const TIME_OFF = "repeating-linear-gradient(135deg, transparent 0 4px, var(--time-off-stripe) 4px 8px)";

interface Run {
  first: DayNum;
  last: DayNum;
}

/** Groups days (in order) into runs of consecutive visible days that match. */
function runs(timeline: Timeline, days: readonly DayNum[], matches: (day: DayNum) => boolean): Run[] {
  const result: Run[] = [];
  let previous: DayNum | null = null;
  for (const day of days) {
    if (matches(day)) {
      const last = result.at(-1);
      // Adjacent on screen (hidden days in between take no space) extends the run.
      if (last && previous === last.last) last.last = day;
      else result.push({ first: day, last: day });
    }
    previous = day;
  }
  return result;
}

/**
 * Column and row backgrounds: non-working weekdays, all-team holidays (striped), highlights,
 * markers where hidden weekends were skipped, and per-person time off / targeted holidays (hatched
 * in that person's rows only).
 */
export function Shading({
  timeline,
  calendar,
  calendarDto,
  days,
  rows,
  rowHeight,
  firstRow,
  height,
  highlights,
}: {
  timeline: Timeline;
  calendar: Calendar;
  calendarDto: CalendarDto;
  days: readonly DayNum[];
  rows: readonly BoardRow[];
  rowHeight: number;
  firstRow: number;
  height: number;
  highlights: readonly { day: DayNum; highlight: HighlightDto }[];
}) {
  const workingWeekdays = new Set(calendarDto.workingWeekdays);
  const weekend = runs(timeline, days, (day) => !workingWeekdays.has(weekday(day)));
  const holidays = runs(timeline, days, (day) => workingWeekdays.has(weekday(day)) && !calendar.isWorkingDay(day, null));
  const skipped = days.filter((day, index) => index > 0 && day - days[index - 1]! > 1);
  const column = (run: Run) => ({ left: timeline.x(run.first), width: timeline.xEnd(run.last) - timeline.x(run.first), height });

  // Time off is the same for every row of a person: work it out once per person.
  const personal = new Map<string, Run[]>();
  const personalRuns = (resourceId: string) => {
    let found = personal.get(resourceId);
    if (!found) {
      found = runs(timeline, days, (day) => calendar.isWorkingDay(day, null) && !calendar.isWorkingDay(day, resourceId));
      personal.set(resourceId, found);
    }
    return found;
  };

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {weekend.map((run) => (
        <div key={`w${run.first}`} className="absolute top-0" style={{ ...column(run), background: "var(--weekend)" }} />
      ))}
      {holidays.map((run) => (
        <div key={`h${run.first}`} className="absolute top-0" style={{ ...column(run), background: HOLIDAY }} />
      ))}
      {highlights.map(({ day, highlight }) => (
        <div
          key={highlight.id}
          className="absolute top-0 opacity-15"
          style={{ ...column({ first: day, last: day }), background: highlight.color }}
        />
      ))}
      {skipped.map((day) => (
        <div key={`s${day}`} className="absolute top-0 border-l border-dashed border-[var(--skipped)]" style={{ left: timeline.x(day), height }} />
      ))}
      {rows.map((entry, index) => {
        const { row } = entry;
        if (row.kind !== "task" || entry.isParent || !row.resourceId) return null;
        const top = (firstRow + index) * rowHeight;
        return personalRuns(row.resourceId).map((run) => (
          <div
            key={`${row.id}-${run.first}`}
            className="absolute"
            style={{ top, height: rowHeight, left: timeline.x(run.first), width: timeline.xEnd(run.last) - timeline.x(run.first), background: TIME_OFF }}
          />
        ));
      })}
    </div>
  );
}
