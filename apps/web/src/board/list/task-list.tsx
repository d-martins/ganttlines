import type { Calendar, RowId } from "@ganttlines/engine";
import type { ResourceDto } from "@ganttlines/protocol";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Avatar } from "../../ui/avatar";
import type { BoardRow } from "../model";

/** Column template shared by the header and the rows: # · title · assignee · WD · CD · predecessor. */
const COLUMNS = "grid grid-cols-[40px_minmax(120px,1fr)_120px_40px_40px_56px] items-center";

export function ListHeader() {
  return (
    // Visual column headings; each row's cells carry their own meaning for assistive tech (3c adds grid navigation).
    <div aria-hidden className={`${COLUMNS} h-full border-b border-border px-1 text-xs font-semibold text-muted`}>
      <span className="text-right pr-2">
        #
      </span>
      <span >Task</span>
      <span >Assignee</span>
      <span title="Working days" className="text-right">
        WD
      </span>
      <span title="Calendar days" className="text-right">
        CD
      </span>
      <span title="Predecessor (row # and offset)" className="text-right">
        Pred.
      </span>
    </div>
  );
}

/** Working days and calendar days a row spans ("–" when it has no dates). */
export function durations(entry: BoardRow, calendar: Calendar): { working: string; days: string } {
  const { row, span } = entry;
  if (!span) return { working: "–", days: "–" };
  const days = String(span.end - span.start + 1);
  if (row.kind === "task" && !entry.isParent) return { working: String(row.duration), days };
  let working = 0;
  for (let day = span.start; day <= span.end; day++) if (calendar.isWorkingDay(day, null)) working++;
  return { working: String(working), days };
}

/** "#3", "#3 +2", "#3 −1" */
export function predecessorText(entry: BoardRow, numbers: ReadonlyMap<RowId, number>): string {
  const { row } = entry;
  if (row.kind !== "task" || !row.predecessorId) return "";
  const number = numbers.get(row.predecessorId);
  if (number === undefined) return "";
  return row.offset === 0 ? `#${number}` : `#${number} ${row.offset > 0 ? "+" : "−"}${Math.abs(row.offset)}`;
}

export function ListRows({
  rows,
  firstRow,
  rowHeight,
  numbers,
  calendar,
  resources,
}: {
  rows: readonly BoardRow[];
  firstRow: number;
  rowHeight: number;
  numbers: ReadonlyMap<RowId, number>;
  calendar: Calendar;
  resources: ReadonlyMap<string, ResourceDto>;
}) {
  return (
    <>
      {rows.map((entry, index) => {
        const { row } = entry;
        const assignee = row.kind === "task" && row.resourceId ? resources.get(row.resourceId) : undefined;
        const { working, days } = durations(entry, calendar);
        const predecessor = predecessorText(entry, numbers);
        const weight = row.kind === "section" ? "font-bold" : entry.isParent ? "font-semibold" : "";
        return (
          <div
            key={row.id}
            role="row"
            aria-level={entry.depth + 1}
            aria-expanded={entry.hasChildren ? !row.collapsed : undefined}
            className={`${COLUMNS} absolute right-0 left-0 px-1 text-sm`}
            style={{ top: (firstRow + index) * rowHeight, height: rowHeight }}
          >
            <span role="gridcell" aria-label={`Row ${entry.number}`} className="pr-2 text-right text-xs text-muted tabular-nums">
              {entry.number}
            </span>
            <span role="gridcell" className={`flex min-w-0 items-center gap-1 ${weight}`} style={{ paddingLeft: entry.depth * 16 }}>
              {entry.hasChildren ? (
                row.collapsed ? (
                  <ChevronRight aria-hidden size={14} className="shrink-0 text-muted" />
                ) : (
                  <ChevronDown aria-hidden size={14} className="shrink-0 text-muted" />
                )
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              <span className={`truncate ${row.title ? "" : "text-muted italic"}`}>{row.title || "Untitled"}</span>
            </span>
            <span role="gridcell" aria-label={assignee ? `Assignee ${assignee.name}` : "Unassigned"} className="flex min-w-0 items-center gap-1.5 text-xs">
              {assignee ? (
                <>
                  <Avatar name={assignee.name} color={assignee.avatarColor} size={18} />
                  <span className="truncate">{assignee.name}</span>
                </>
              ) : null}
            </span>
            <span role="gridcell" aria-label={`${working} working days`} className="text-right text-xs tabular-nums">
              {working}
            </span>
            <span role="gridcell" aria-label={`${days} calendar days`} className="text-right text-xs tabular-nums">
              {days}
            </span>
            <span role="gridcell" aria-label={predecessor ? `After ${predecessor}` : "No predecessor"} className="truncate text-right text-xs tabular-nums">
              {predecessor}
            </span>
          </div>
        );
      })}
    </>
  );
}
