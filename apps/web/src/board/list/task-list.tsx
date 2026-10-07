import type { Calendar, RowId } from "@ganttlines/engine";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GripVertical, LocateFixed, IndentDecrease, IndentIncrease, MessageSquare, PanelRightOpen, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { commentCounts } from "../../api/queries";
import { Avatar } from "../../ui/avatar";
import { IconButton } from "../../ui/button";
import { AssigneePicker } from "../assignee-picker";
import { useBoard, useRun } from "../board-context";
import { setCollapsed } from "../collapse";
import { formatDays } from "../chart/bars";
import type { BoardRow } from "../model";
import { useSelection } from "../selection";
import { addAtEnd, addRowBelow, addSubtask, deleteRow, dropMove, parseDays, setActualDays, setWorkingDays, type DropZone } from "./list-actions";
import { AUTO_SCROLL_STEP, AUTO_SCROLL_TICK_MS, edgePush, HEADER_HEIGHT } from "../auto-scroll";
import { useCapabilities } from "../../workspace";

/**
 * Column template shared by the header and the rows: # · title · assignee · WD · AWD · row actions (show the bar, open details, delete).
 * (Predecessors are set in the details panel, or by linking bars on the chart.)
 * Fixed columns + the title's minimum + padding = LIST_WIDTH.min, so no column is ever cut off.
 */
const COLUMNS = "grid grid-cols-[40px_minmax(96px,1fr)_120px_40px_40px_76px] items-center";
const INDENT = 16;

export function ListHeader({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { canEdit, sync, state } = useBoard();
  const run = useRun();
  const selectedId = useSelection((selection) => selection.selectedId);
  // Collapse every row that has children; expand everything (including rows inside collapsed ones).
  const setAll = (collapsed: boolean) => {
    const rows = Object.values(state.rows);
    const ids = collapsed ? new Set(rows.flatMap((row) => (row.parentId ? [row.parentId] : []))) : rows.map((row) => row.id);
    setCollapsed(sync.projectId, ids, collapsed);
  };
  return (
    <div className="flex h-full flex-col border-b border-border">
      <div className="flex h-6 items-center gap-1 px-1">
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-xs text-muted focus-within:bg-bg">
          <Search aria-hidden size={12} className="shrink-0" />
          <input
            type="search"
            aria-label="Search tasks"
            placeholder="Search tasks"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && onQuery("")}
            className="min-w-0 flex-1 bg-transparent py-0.5 text-text outline-none placeholder:text-muted"
          />
        </label>
        {canEdit ? (
          <>
            <IconButton label="Outdent (Alt+Shift+←)" className="h-5 w-5" disabled={!selectedId} onClick={() => selectedId && run({ type: "outdent", id: selectedId })}>
              <IndentDecrease size={13} />
            </IconButton>
            <IconButton label="Indent (Alt+Shift+→)" className="h-5 w-5" disabled={!selectedId} onClick={() => selectedId && run({ type: "indent", id: selectedId })}>
              <IndentIncrease size={13} />
            </IconButton>
          </>
        ) : null}
        <IconButton label="Expand all" className="h-5 w-5" onClick={() => setAll(false)}>
          <ChevronsUpDown size={13} />
        </IconButton>
        <IconButton label="Collapse all" className="h-5 w-5" onClick={() => setAll(true)}>
          <ChevronsDownUp size={13} />
        </IconButton>
      </div>
      {/* Visual column headings; assistive tech gets ListColumnHeaders inside the grid instead. */}
      <div aria-hidden className={`${COLUMNS} h-6 px-1 text-xs font-semibold text-muted`}>
        <span className="pr-2 text-right">#</span>
        <span>Task</span>
        <span>Assignee</span>
        <span title="Working days" className="px-1 text-right">
          WD
        </span>
        <span title="Actual work days" className="px-1 text-right">
          AWD
        </span>
        <span />
      </div>
    </div>
  );
}

/** Planned working days (a task's own; parents and sections: working days across their dates) and actual work days. */
export function durations(entry: BoardRow, calendar: Calendar): { working: string; actual: string } {
  const { row, span } = entry;
  const actual = entry.actualDays === null ? "" : formatDays(entry.actualDays);
  if (row.kind === "task" && !entry.isParent && !entry.fromBaseline) return { working: formatDays(row.duration), actual };
  if (!span) return { working: "–", actual };
  if (entry.kind === "milestone") return { working: "0", actual };
  // Across its dates: the baseline's for a task (its person's days, in halves), team days for the rest.
  const resourceId = row.kind === "task" && !entry.isParent ? row.resourceId : null;
  let working = 0;
  for (let day = span.start; day <= span.end; day++) if (calendar.isWorkingDay(day, resourceId)) working++;
  if (row.kind === "task" && !entry.isParent) working -= (span.startsAfternoon ? 0.5 : 0) + (span.endsMidday ? 0.5 : 0);
  return { working: row.kind === "task" && !entry.isParent ? formatDays(working) : String(working), actual };
}

/** Actual work days against the plan: red when over, green when under (single tasks). */
const ACTUAL_TINT = { over: "text-[var(--awd-over)]", under: "text-[var(--awd-under)]", even: "" } as const;

/** A text box that commits once: on Enter or when it loses focus; Escape cancels. */
function InlineInput({
  initial,
  label,
  className = "",
  onCommit,
  onCancel,
  onKey,
  inputMode,
  cell,
}: {
  initial: string;
  label: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /**
   * Extra keys (Enter, Alt+Shift+arrows…); return true when the key finished the editing (nothing
   * more is saved from this input). Tab is left alone: it moves focus, which saves.
   */
  onKey?: (event: KeyboardEvent<HTMLInputElement>, value: string) => boolean;
  inputMode?: "numeric" | "decimal" | "text";
  /** `data-cell` of the control to focus again when editing ends from the keyboard (Enter / Escape) */
  cell: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean, byKey = false) => {
    if (done.current) return;
    done.current = true;
    // Keyboard users carry on from the same cell (or the list, if the row is gone); clicks elsewhere keep their focus.
    const list = byKey ? (document.activeElement?.closest('[role="treegrid"]') as HTMLElement | null) : null;
    if (commit) onCommit(value);
    else onCancel();
    if (byKey) {
      // After React has re-rendered the cell (a timeout, not an animation frame: those pause while the page isn't painted).
      setTimeout(() => {
        const target = document.querySelector<HTMLElement>(`[data-cell="${CSS.escape(cell)}"]`) ?? list;
        target?.focus();
      });
    }
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      inputMode={inputMode}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (onKey?.(event, value)) {
          done.current = true;
          return;
        }
        if (event.key === "Enter") finish(true, true);
        else if (event.key === "Escape") finish(false, true);
      }}
      className={`min-w-0 rounded-sm border border-accent bg-bg px-1 text-sm outline-none ${className}`}
    />
  );
}

type Column = "wd" | "awd";

interface DragState {
  id: RowId;
  target: { index: number; zone: DropZone } | null;
}

/** The list's column headers for assistive tech (the visible headings sit outside the grid, in the sticky header). */
export function ListColumnHeaders() {
  return (
    <div role="row" aria-rowindex={1} className="sr-only">
      {["Row number", "Task", "Assignee", "Working days", "Actual work days", "Actions"].map((name) => (
        <span key={name} role="columnheader">
          {name}
        </span>
      ))}
    </div>
  );
}

export function ListRows({
  rows,
  allRows,
  firstRow,
  rowHeight,
  numbers,
  searching,
}: {
  /** the rendered window */
  rows: readonly BoardRow[];
  /** every shown row (for drops and the footer position) */
  allRows: readonly BoardRow[];
  firstRow: number;
  rowHeight: number;
  numbers: ReadonlyMap<RowId, number>;
  searching: boolean;
}) {
  const board = useBoard();
  const capabilities = useCapabilities();
  const comments = useQuery({ ...commentCounts(board.sync.projectId), enabled: capabilities.comments }).data;
  const { state, calendar, resources, resourceMap, canEdit, canCreateResources } = board;
  const run = useRun();
  const { selectedId, editingId, draftId, select, edit, center } = useSelection();
  const [cell, setCell] = useState<{ id: RowId; column: Column } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // A row being edited can vanish (deleted by someone else): stop editing it.
  useEffect(() => {
    if (editingId && !state.rows[editingId]) edit(null);
  }, [editingId, state.rows, edit]);

  const commitTitle = (row: BoardRow["row"], value: string) => {
    const title = value.trim();
    if (!title && draftId === row.id) {
      run({ type: "deleteRows", ids: [row.id] });
      select(null);
    } else if (title !== row.title) {
      run({ type: "updateTitle", id: row.id, title });
    }
  };

  const startDrag = (event: ReactPointerEvent, id: RowId) => {
    if (!canEdit || searching) return;
    event.preventDefault();
    const grid = (event.currentTarget as HTMLElement).closest('[role="treegrid"]') as HTMLElement;
    const scroller = grid.closest('[data-testid="board-scroller"]') as HTMLElement | null;
    let target: DragState["target"] = null;
    let last: PointerEvent | null = null;
    setDrag({ id, target });
    // Near or past the list's top or bottom, keep scrolling that way.
    const autoScroll = setInterval(() => {
      if (!last || !scroller) return;
      const bounds = scroller.getBoundingClientRect();
      const dy = edgePush(last.clientY, bounds.top + HEADER_HEIGHT, bounds.bottom) * AUTO_SCROLL_STEP;
      if (!dy) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += dy;
      if (scroller.scrollTop !== before) move(last);
    }, AUTO_SCROLL_TICK_MS);
    const move = (moveEvent: PointerEvent) => {
      last = moveEvent;
      const y = moveEvent.clientY - grid.getBoundingClientRect().top;
      const index = Math.min(Math.max(Math.floor(y / rowHeight), 0), allRows.length - 1);
      const fraction = y / rowHeight - index;
      target = { index, zone: fraction < 0.3 ? "before" : fraction > 0.7 ? "after" : "inside" };
      setDrag({ id, target });
    };
    const up = () => {
      clearInterval(autoScroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      const entry = target ? allRows[target.index] : undefined;
      const moveTo = entry && target ? dropMove(state, id, entry.row, target.zone) : null;
      if (moveTo) run({ type: "moveRow", id, ...moveTo });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dropTarget = drag?.target ? allRows[drag.target.index] : undefined;
  const dropValid = drag?.target && dropTarget ? dropMove(state, drag.id, dropTarget.row, drag.target.zone) !== null : false;

  return (
    <>
      {rows.map((entry, index) => {
        const { row } = entry;
        const task = row.kind === "task" ? row : null;
        const assignee = task?.resourceId ? resourceMap.get(task.resourceId) : undefined;
        const { working, actual } = durations(entry, calendar);
        const weight = row.kind === "section" ? "font-bold" : entry.isParent ? "font-semibold" : "";
        const selected = selectedId === row.id;
        const editing = editingId === row.id && canEdit;
        const editingCell = canEdit && cell?.id === row.id ? cell.column : null;
        return (
          <div
            key={row.id}
            role="row"
            aria-rowindex={firstRow + index + 2 /* after the header row */}
            aria-level={entry.depth + 1}
            aria-selected={selected}
            aria-expanded={entry.hasChildren ? !entry.collapsed : undefined}
            // A click only selects (highlights) the row; a double-click also brings its bar into view (its
            // start just inside the chart's left edge) and opens the details panel. Not on a cell that edits.
            onClick={() => select(row.id, false)}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("[data-cell], [data-row-action], input")) return;
              center(row.id);
              select(row.id, true);
            }}
            className={`group ${COLUMNS} absolute right-0 left-0 px-1 text-sm ${selected ? "bg-accent-soft" : "hover:bg-surface-2"} ${drag?.id === row.id ? "opacity-50" : ""}`}
            style={{ top: (firstRow + index) * rowHeight, height: rowHeight }}
          >
            <span role="gridcell" aria-label={`Row ${entry.number}`} className="relative pr-2 text-right text-xs text-muted tabular-nums">
              {canEdit && !searching ? (
                <button
                  type="button"
                  aria-label={`Move “${row.title || "Untitled"}”`}
                  tabIndex={-1}
                  onPointerDown={(event) => startDrag(event, row.id)}
                  className="absolute top-1/2 left-0 -translate-y-1/2 cursor-grab touch-none text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                >
                  <GripVertical size={14} />
                </button>
              ) : null}
              {entry.deletedSince ? "" : entry.number}
            </span>
            <span role="gridcell" className={`flex min-w-0 items-center gap-1 ${weight}`} style={{ paddingLeft: entry.depth * INDENT }}>
              {entry.hasChildren ? (
                <button
                  type="button"
                  aria-label={entry.collapsed ? "Expand" : "Collapse"}
                  disabled={searching}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsed(board.sync.projectId, [row.id], !entry.collapsed);
                  }}
                  className="shrink-0 rounded text-muted hover:text-text disabled:cursor-default disabled:hover:text-muted"
                >
                  {entry.collapsed && !searching ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              ) : (
                <span className="w-3.5 shrink-0" />
              )}
              {editing ? (
                <InlineInput
                  initial={row.title}
                  label="Title"
                  cell={`${row.id}:title`}
                  className="flex-1"
                  onCommit={(value) => {
                    commitTitle(row, value);
                    edit(null);
                  }}
                  onCancel={() => {
                    if (draftId === row.id && !row.title) {
                      run({ type: "deleteRows", ids: [row.id] });
                      select(null);
                    }
                    edit(null);
                  }}
                  onKey={(event, value) => {
                    if (event.key === "Enter") {
                      // Enter: keep this title, then type the next row's.
                      event.preventDefault();
                      const title = value.trim();
                      if (!title && draftId === row.id) {
                        commitTitle(row, value);
                        edit(null);
                        return true;
                      }
                      commitTitle(row, value);
                      if (!addRowBelow(board, state, row, entry.collapsed)) edit(null);
                      return true;
                    }
                    if (event.altKey && event.shiftKey && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
                      // Alt+Shift+→ / ←: keep the title and indent / outdent, still typing.
                      event.preventDefault();
                      commitTitle(row, value);
                      run({ type: event.key === "ArrowRight" ? "indent" : "outdent", id: row.id });
                      edit(row.id, draftId === row.id && !value.trim());
                      return false; // still typing: this input must still save on Enter / blur
                    }
                    return false;
                  }}
                />
              ) : (
                <>
                  {canEdit ? (
                    // A button so it can be reached with Tab: a click or Space/Enter edits (the click also selects the row).
                    <button
                      type="button"
                      data-cell={`${row.id}:title`}
                      aria-label={`Title “${row.title || "Untitled"}”`}
                      onFocus={(event) => event.currentTarget.matches(":focus-visible") && select(row.id, false)}
                      onKeyDown={(event) => {
                        if (event.key !== " " && event.key !== "Enter") return;
                        event.preventDefault();
                        event.stopPropagation();
                        edit(row.id);
                      }}
                      onClick={() => edit(row.id)}
                      className={`min-w-0 truncate rounded-sm text-left ${row.title ? "" : "text-muted italic"}`}
                    >
                      {row.title || "Untitled"}
                    </button>
                  ) : (
                    <span className={`truncate ${row.title ? "" : "text-muted italic"}`}>{row.title || "Untitled"}</span>
                  )}
                  {entry.deletedSince ? <span className="shrink-0 rounded bg-surface-2 px-1 text-[10px] text-muted">deleted since</span> : null}
                  {comments?.[row.id] ? (
                    <span aria-label={`${comments[row.id]} ${comments[row.id] === 1 ? "comment" : "comments"}`} className="flex shrink-0 items-center gap-0.5 text-xs font-normal text-muted">
                      <MessageSquare aria-hidden size={11} />
                      {comments[row.id]}
                    </span>
                  ) : null}
                  <span className="ml-auto flex shrink-0">
                    {canEdit ? (
                      <button
                        type="button"
                        aria-label={`Add a subtask to “${row.title || "Untitled"}”`}
                        title="Add subtask"
                        onClick={(event) => {
                          event.stopPropagation();
                          addSubtask(board, state, row);
                        }}
                        className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 pointer-coarse:opacity-100"
                      >
                        <Plus size={14} />
                      </button>
                    ) : null}
                  </span>
                </>
              )}
            </span>
            <span role="gridcell" aria-label={assignee ? `Assignee ${assignee.name}` : "Unassigned"} className="flex min-w-0 items-center text-xs">
              {task && canEdit ? (
                <AssigneePicker
                  value={task.resourceId}
                  resources={resources}
                  canCreate={canCreateResources}
                  onChange={(resourceId) => run({ type: "setAssignee", id: task.id, resourceId })}
                  trigger={
                    <button
                      type="button"
                      aria-label={`Assignee of “${row.title || "Untitled"}”: ${assignee?.name ?? "nobody"}`}
                      onClick={(event) => event.stopPropagation()}
                      className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left hover:bg-surface-2"
                    >
                      {assignee ? (
                        <>
                          <Avatar name={assignee.name} color={assignee.avatarColor} size={18} />
                          <span className="truncate">{assignee.name}</span>
                        </>
                      ) : (
                        <span className="text-muted opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100">Assign…</span>
                      )}
                    </button>
                  }
                />
              ) : assignee ? (
                <span className="flex min-w-0 items-center gap-1.5 px-1">
                  <Avatar name={assignee.name} color={assignee.avatarColor} size={18} />
                  <span className="truncate">{assignee.name}</span>
                </span>
              ) : null}
            </span>
            <span role="gridcell" aria-label={`${working} working days`} className="text-right text-xs tabular-nums">
              {editingCell === "wd" && task ? (
                <InlineInput
                  initial={formatDays(task.duration)}
                  label="Working days"
                  cell={`${row.id}:wd`}
                  inputMode="decimal"
                  className="w-full text-right text-xs"
                  onCommit={(value) => {
                    setCell(null);
                    const days = parseDays(value);
                    if (days !== null && days !== task.duration) setWorkingDays(board, task, days);
                  }}
                  onCancel={() => setCell(null)}
                />
              ) : row.kind === "section" ? null : (
                <CellButton
                  editable={canEdit && !!task && !entry.isParent}
                  hint={canEdit ? (entry.isParent || !task ? "Worked out from the tasks inside" : undefined) : undefined}
                  label={`Working days of “${row.title || "Untitled"}”`}
                  cell={`${row.id}:wd`}
                  onEdit={() => setCell({ id: row.id, column: "wd" })}
                >
                  {working}
                </CellButton>
              )}
            </span>
            <span
              role="gridcell"
              aria-label={actual ? `${actual} actual work days` : "No actual work days"}
              className={`text-right text-xs tabular-nums ${entry.actual ? ACTUAL_TINT[entry.actual.versusPlan] : ""}`}
            >
              {editingCell === "awd" && task ? (
                <InlineInput
                  initial={actual}
                  label="Actual work days"
                  cell={`${row.id}:awd`}
                  inputMode="decimal"
                  className="w-full text-right text-xs"
                  onCommit={(value) => {
                    setCell(null);
                    if (value.trim() !== actual) setActualDays(board, task, parseDays(value));
                  }}
                  onCancel={() => setCell(null)}
                />
              ) : (
                <CellButton
                  editable={canEdit && !!task && !entry.isParent && task.duration > 0}
                  hint={canEdit ? (entry.isParent || !task ? "Added up from the tasks inside" : task.duration === 0 ? "Milestones have no actual work days" : undefined) : undefined}
                  label={`Actual work days of “${row.title || "Untitled"}”`}
                  cell={`${row.id}:awd`}
                  onEdit={() => setCell({ id: row.id, column: "awd" })}
                >
                  {actual}
                </CellButton>
              )}
            </span>
            <span role="gridcell" className={`flex justify-end gap-1 ${selected ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}>
              <RowActions id={row.id} title={row.title} />
            </span>
          </div>
        );
      })}
      {drag?.target && dropTarget ? <DropIndicator target={drag.target} depth={dropTarget.depth} rowHeight={rowHeight} valid={dropValid} /> : null}
      {canEdit && !searching ? (
        <div className="absolute left-0 flex gap-1 px-2 text-xs" style={{ top: allRows.length * rowHeight + 4 }}>
          <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-text" onClick={() => addAtEnd(board, state, "task")}>
            <Plus size={13} /> Add task
          </button>
          <button type="button" className="flex items-center gap-1 rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-text" onClick={() => addAtEnd(board, state, "section")}>
            <Plus size={13} /> Add section
          </button>
        </div>
      ) : null}
    </>
  );
}

/** A value that opens its editor on a click or Space / Enter (if editable); the click also selects the row. */
function CellButton({
  editable,
  label,
  cell,
  onEdit,
  children,
  hint,
  ...anchor
}: {
  editable: boolean;
  label: string;
  cell: string;
  onEdit: () => void;
  children: string;
  /** why a read-only value can't be edited (shown on hover) */
  hint?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
} & HTMLAttributes<HTMLButtonElement>) {
  // Same box as the button, so editable and read-only values line up.
  if (!editable) {
    return (
      <span title={hint} className={`block h-6 truncate px-1 leading-6 ${hint ? "cursor-help" : ""}`}>
        {children}
      </span>
    );
  }
  return (
    <button
      {...anchor}
      type="button"
      data-cell={cell}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        onEdit();
      }}
      onClick={onEdit}
      className="block h-6 w-full truncate rounded px-1 text-right hover:bg-surface-2"
    >
      {children || <span className="text-muted opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100">–</span>}
    </button>
  );
}

/** The row's quick actions: bring its bar into view, then open its details (again: close them). */
function RowActions({ id, title }: { id: RowId; title: string }) {
  const board = useBoard();
  const { select, center, closePanel } = useSelection();
  const showing = useSelection((selection) => selection.panelOpen && selection.selectedId === id);
  const name = title || "Untitled";
  return (
    <>
      <IconButton
        data-row-action
        label={`Show “${name}” on the chart`}
        className="h-6 w-auto!"
        onClick={(event) => {
          event.stopPropagation();
          select(id, false);
          center(id);
        }}
      >
        <LocateFixed size={14} />
      </IconButton>
      <IconButton
        data-row-action
        label={`Open details of “${name}”`}
        aria-pressed={showing}
        className={`h-6 w-auto! ${showing ? "bg-accent-soft text-text" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          // A toggle for this row's details; on another row it just moves the panel there.
          if (showing) closePanel();
          else select(id, true);
        }}
      >
        <PanelRightOpen size={14} />
      </IconButton>
      {board.canEdit ? (
        <IconButton
          data-row-action
          label={`Delete “${name}”`}
          className="h-6 w-auto! hover:text-danger"
          onClick={(event) => {
            event.stopPropagation();
            const row = board.state.rows[id];
            if (row) deleteRow(board, row);
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      ) : null}
    </>
  );
}

function DropIndicator({ target, depth, rowHeight, valid }: { target: NonNullable<DragState["target"]>; depth: number; rowHeight: number; valid: boolean }) {
  const top = target.index * rowHeight;
  const color = valid ? "var(--accent)" : "var(--danger)";
  if (target.zone === "inside") {
    return <div aria-hidden className="pointer-events-none absolute right-1 left-1 rounded border-2" style={{ top, height: rowHeight, borderColor: color }} />;
  }
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-1 h-0.5"
      style={{ top: target.zone === "before" ? top - 1 : top + rowHeight - 1, left: 40 + depth * INDENT, background: color }}
    />
  );
}

/**
 * Keys on the task list (when not typing): ↑/↓ select (an open details panel follows), Enter/F2 edit the title, Delete removes,
 * Alt+Shift+→ / ← indent / outdent, Escape clears the selection. Tab is never taken: it moves focus.
 */
export function useListKeys(allRows: readonly BoardRow[]) {
  const board = useBoard();
  const run = useRun();
  const { selectedId, select, edit } = useSelection();
  return (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    // Enter / Space on a focused cell belong to that cell (it opens its own editor).
    if ((event.key === "Enter" || event.key === " ") && target.closest("button")) return;
    const index = allRows.findIndex((entry) => entry.row.id === selectedId);
    const current = allRows[index];
    const move = (to: number) => {
      const next = allRows[Math.min(Math.max(to, 0), allRows.length - 1)];
      if (next) select(next.row.id, false);
    };
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft":
        if (!(event.altKey && event.shiftKey) || !current || !board.canEdit) return;
        run({ type: event.key === "ArrowRight" ? "indent" : "outdent", id: current.row.id });
        break;
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index < 0 ? allRows.length - 1 : index - 1);
        break;
      case "Escape":
        select(null);
        break;
      case "Enter":
      case "F2":
        if (!current || !board.canEdit) return;
        edit(current.row.id);
        break;
      case "Delete":
      case "Backspace":
        if (!current || !board.canEdit) return;
        deleteRow(board, current.row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };
}
