import type { ProjectState, RowId, Schedule, TaskRow } from "@ganttlines/engine";
import type { ReactNode } from "react";
import { SearchSelect, type SearchOption } from "../ui/search-select";
import { formatDay } from "./format";

/** "Oct 5" or "Oct 5 – Oct 9", for telling tasks apart in the list. */
function datesOf(schedule: Schedule | null, id: RowId): string | undefined {
  const span = schedule?.get(id)?.span;
  if (!span) return undefined;
  return span.start === span.end ? formatDay(span.start) : `${formatDay(span.start)} – ${formatDay(span.end)}`;
}

/**
 * Pick a task's predecessor (a task has at most one): search by row number (“3”, “#3”) or title,
 * the current one is checked.
 */
export function PredecessorPicker({
  task,
  current,
  onPick,
  state,
  schedule,
  numbers,
  trigger,
  open,
  onOpenChange,
}: {
  task: TaskRow;
  /** the predecessor shown as chosen */
  current: RowId | null;
  onPick: (id: RowId | null) => void;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const numberOf = (id: RowId) => numbers.get(id) ?? 0;
  const options = (query: string): SearchOption[] => {
    const needle = query.replace(/^#/, "").toLocaleLowerCase();
    const tasks = Object.values(state.rows)
      .filter((row): row is TaskRow => row.kind === "task" && row.id !== task.id)
      .filter((row) => !needle || String(numberOf(row.id)).startsWith(needle) || row.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => numberOf(a.id) - numberOf(b.id));
    return [
      ...(needle ? [] : [{ key: "none", label: "No predecessor", current: current === null, onChoose: () => onPick(null) }]),
      ...tasks.map((row) => ({
        key: row.id,
        label: `#${numberOf(row.id)} ${row.title || "Untitled"}`,
        ...(datesOf(schedule, row.id) ? { detail: datesOf(schedule, row.id)! } : {}),
        current: row.id === current,
        onChoose: () => onPick(row.id),
      })),
    ];
  };
  return (
    <SearchSelect
      trigger={trigger}
      options={options}
      searchLabel="Find a predecessor"
      placeholder="Row number or title…"
      empty="No task matches."
      {...(open !== undefined ? { open, onOpenChange: onOpenChange ?? (() => undefined) } : {})}
      align="end"
    />
  );
}
