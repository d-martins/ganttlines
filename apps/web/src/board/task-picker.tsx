import type { ProjectState, Row, RowId, Schedule, TaskRow } from "@ganttlines/engine";
import type { ReactNode } from "react";
import { SearchSelect, type SearchOption } from "../ui/search-select";
import { formatDay } from "./format";

/** "Oct 5" or "Oct 5 – Oct 9", for telling tasks apart in the list. */
function datesOf(schedule: Schedule | null, id: RowId): string | undefined {
  const span = schedule?.get(id)?.span;
  if (!span) return undefined;
  return span.start === span.end ? formatDay(span.start) : `${formatDay(span.start)} – ${formatDay(span.end)}`;
}

/** Pick a task: search by row number (“3”, “#3”) or title; rows `exclude` accepts are left out. */
export function TaskPicker({
  exclude,
  onPick,
  state,
  schedule,
  numbers,
  trigger,
  searchLabel,
  open,
  onOpenChange,
  footer,
  noteOf,
}: {
  /** said next to a task, such as what choosing it would replace */
  noteOf?: (row: TaskRow) => string | undefined;
  exclude: (row: Row) => boolean;
  onPick: (id: RowId) => void;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  trigger: ReactNode;
  searchLabel: string;
  /** with `onOpenChange`: open when the owner says (the trigger still opens it too) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** extra controls under the list */
  footer?: ReactNode;
}) {
  const numberOf = (id: RowId) => numbers.get(id) ?? 0;
  const options = (query: string): SearchOption[] => {
    const needle = query.replace(/^#/, "").toLocaleLowerCase();
    return Object.values(state.rows)
      .filter((row): row is TaskRow => row.kind === "task" && !exclude(row))
      .filter((row) => !needle || String(numberOf(row.id)).startsWith(needle) || row.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => numberOf(a.id) - numberOf(b.id))
      .map((row) => ({
        key: row.id,
        label: `#${numberOf(row.id)} ${row.title || "Untitled"}`,
        ...(datesOf(schedule, row.id) || noteOf?.(row) ? { detail: [noteOf?.(row), datesOf(schedule, row.id)].filter(Boolean).join(" · ") } : {}),
        onChoose: () => onPick(row.id),
      }));
  };
  return (
    <SearchSelect
      trigger={trigger}
      options={options}
      searchLabel={searchLabel}
      placeholder="Row number or title…"
      empty="No task matches."
      align="end"
      {...(open !== undefined && onOpenChange ? { open, onOpenChange, triggerOpens: true } : {})}
      {...(footer ? { footer } : {})}
    />
  );
}
