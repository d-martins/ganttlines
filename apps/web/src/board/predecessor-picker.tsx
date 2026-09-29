import type { ProjectState, RowId, Schedule, TaskRow } from "@ganttlines/engine";
import { useState, type ReactNode } from "react";
import { SearchSelect, type SearchOption } from "../ui/search-select";
import { useBoard, useRun } from "./board-context";
import { formatDay } from "./format";
import { setPredecessor } from "./list/list-actions";

/** "Oct 5" or "Oct 5 – Oct 9", for telling tasks apart in the list. */
function datesOf(schedule: Schedule | null, id: RowId): string | undefined {
  const span = schedule?.get(id)?.span;
  if (!span) return undefined;
  return span.start === span.end ? formatDay(span.start) : `${formatDay(span.start)} – ${formatDay(span.end)}`;
}

/**
 * Pick a task's predecessor (a task has at most one): search by row number (“3”, “#3”) or title,
 * the current one is checked. Optionally shows an offset field under the list.
 */
export function PredecessorPicker({
  task,
  state,
  schedule,
  numbers,
  trigger,
  open,
  onOpenChange,
  withOffset = false,
}: {
  task: TaskRow;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  withOffset?: boolean;
}) {
  const board = useBoard();
  const run = useRun();
  const numberOf = (id: RowId) => numbers.get(id) ?? 0;
  const pick = (id: RowId | null) => {
    if (id === task.predecessorId) return;
    // Same rules as typing it: the earlier-starting task becomes the predecessor (explained if reversed).
    setPredecessor(board, state, task, id ? `#${numberOf(id)}` : "", numbers);
  };
  const options = (query: string): SearchOption[] => {
    const needle = query.replace(/^#/, "").toLocaleLowerCase();
    const tasks = Object.values(state.rows)
      .filter((row): row is TaskRow => row.kind === "task" && row.id !== task.id)
      .filter((row) => !needle || String(numberOf(row.id)).startsWith(needle) || row.title.toLocaleLowerCase().includes(needle))
      .sort((a, b) => numberOf(a.id) - numberOf(b.id));
    return [
      ...(needle ? [] : [{ key: "none", label: "No predecessor", current: task.predecessorId === null, onChoose: () => pick(null) }]),
      ...tasks.map((row) => ({
        key: row.id,
        label: `#${numberOf(row.id)} ${row.title || "Untitled"}`,
        ...(datesOf(schedule, row.id) ? { detail: datesOf(schedule, row.id)! } : {}),
        current: row.id === task.predecessorId,
        onChoose: () => pick(row.id),
      })),
    ];
  };
  const footer =
    withOffset && task.predecessorId ? (
      <OffsetField value={task.offset} disabled={!board.canEdit} onCommit={(offset) => offset !== task.offset && run({ type: "setOffset", id: task.id, offset })} />
    ) : undefined;
  return (
    <SearchSelect
      trigger={trigger}
      options={options}
      searchLabel="Find a predecessor"
      placeholder="Row number or title…"
      empty="No task matches."
      footer={footer}
      {...(open !== undefined ? { open, onOpenChange: onOpenChange ?? (() => undefined) } : {})}
      align="end"
    />
  );
}

function OffsetField({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (offset: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const offset = Number(draft);
    if (Number.isInteger(offset)) onCommit(offset);
    else setDraft(String(value));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-muted">
      Offset (working days; negative overlaps)
      <input
        type="number"
        aria-label="Offset from the predecessor"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.stopPropagation();
          commit();
        }}
        className="w-16 rounded border border-border-strong bg-bg px-1.5 py-0.5 text-right text-sm text-text"
      />
    </label>
  );
}
