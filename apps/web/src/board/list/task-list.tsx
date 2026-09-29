import { TASK_COLORS, type Calendar, type RowId, type TaskColor, type TaskRow } from "@ganttlines/engine";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GripVertical, IndentDecrease, IndentIncrease, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Avatar } from "../../ui/avatar";
import { useFocusReturnOnKeyboardClose } from "../../ui/popover-focus";
import { IconButton } from "../../ui/button";
import { AssigneePicker } from "../assignee-picker";
import { useBoard, useRun } from "../board-context";
import { setCollapsed } from "../collapse";
import { taskColors } from "../format";
import type { BoardRow } from "../model";
import { useSelection } from "../selection";
import { addAtEnd, addRowBelow, addSubtask, deleteRow, dropMove, setPredecessor, setWorkingDays, type DropZone } from "./list-actions";

/**
 * Column template shared by the header and the rows: # · title · assignee · WD · CD · predecessor · color.
 * Fixed columns + the title's minimum + padding = LIST_WIDTH.min, so no column is ever cut off.
 */
const COLUMNS = "grid grid-cols-[40px_minmax(96px,1fr)_120px_40px_40px_56px_28px] items-center";
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
      {/* Visual column headings; each row's cells carry their own labels for assistive tech. */}
      <div aria-hidden className={`${COLUMNS} h-6 px-1 text-xs font-semibold text-muted`}>
        <span className="pr-2 text-right">#</span>
        <span>Task</span>
        <span>Assignee</span>
        <span title="Working days" className="text-right">
          WD
        </span>
        <span title="Calendar days" className="text-right">
          CD
        </span>
        <span title="Predecessor (row # and offset)" className="text-right">
          Pred.
        </span>
        <span />
      </div>
    </div>
  );
}

/** Working days and calendar days a row spans ("–" when it has no dates). */
export function durations(entry: BoardRow, calendar: Calendar): { working: string; days: string } {
  const { row, span } = entry;
  if (!span) return { working: row.kind === "task" && !entry.isParent ? String(row.duration) : "–", days: "–" };
  const days = String(span.end - span.start + 1);
  if (row.kind === "task" && !entry.isParent) return { working: String(row.duration), days };
  let working = 0;
  for (let day = span.start; day <= span.end; day++) if (calendar.isWorkingDay(day, null)) working++;
  return { working: String(working), days };
}

/** "#3", "#3 +2", "#3 −1" */
export function predecessorText(entry: Pick<BoardRow, "row">, numbers: ReadonlyMap<RowId, number>): string {
  const { row } = entry;
  if (row.kind !== "task" || !row.predecessorId) return "";
  const number = numbers.get(row.predecessorId);
  if (number === undefined) return "";
  return row.offset === 0 ? `#${number}` : `#${number} ${row.offset > 0 ? "+" : "−"}${Math.abs(row.offset)}`;
}

/** A text box that commits once: on Enter or when it loses focus; Escape cancels. */
function InlineInput({
  initial,
  label,
  className = "",
  onCommit,
  onCancel,
  onKey,
  inputMode,
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
  inputMode?: "numeric" | "text";
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
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
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
      className={`min-w-0 rounded-sm border border-accent bg-bg px-1 text-sm outline-none ${className}`}
    />
  );
}

type Column = "wd" | "pred";
interface DragState {
  id: RowId;
  target: { index: number; zone: DropZone } | null;
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
  const { state, calendar, resources, resourceMap, canEdit, canCreateResources } = board;
  const run = useRun();
  const { selectedId, editingId, draftId, select, edit } = useSelection();
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
    let target: DragState["target"] = null;
    setDrag({ id, target });
    const move = (moveEvent: PointerEvent) => {
      const y = moveEvent.clientY - grid.getBoundingClientRect().top;
      const index = Math.min(Math.max(Math.floor(y / rowHeight), 0), allRows.length - 1);
      const fraction = y / rowHeight - index;
      target = { index, zone: fraction < 0.3 ? "before" : fraction > 0.7 ? "after" : "inside" };
      setDrag({ id, target });
    };
    const up = () => {
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
        const { working, days } = durations(entry, calendar);
        const predecessor = predecessorText(entry, numbers);
        const weight = row.kind === "section" ? "font-bold" : entry.isParent ? "font-semibold" : "";
        const selected = selectedId === row.id;
        const editing = editingId === row.id && canEdit;
        const editingCell = canEdit && cell?.id === row.id ? cell.column : null;
        return (
          <div
            key={row.id}
            role="row"
            aria-level={entry.depth + 1}
            aria-selected={selected}
            aria-expanded={entry.hasChildren ? !entry.collapsed : undefined}
            onClick={() => select(row.id)}
            onDoubleClick={() => canEdit && edit(row.id)}
            className={`group ${COLUMNS} absolute right-0 left-0 px-1 text-sm ${selected ? "bg-accent-soft" : "hover:bg-surface"} ${drag?.id === row.id ? "opacity-50" : ""}`}
            style={{ top: (firstRow + index) * rowHeight, height: rowHeight }}
          >
            <span role="gridcell" aria-label={`Row ${entry.number}`} className="relative pr-2 text-right text-xs text-muted tabular-nums">
              {canEdit && !searching ? (
                <button
                  type="button"
                  aria-label={`Move “${row.title || "Untitled"}”`}
                  onPointerDown={(event) => startDrag(event, row.id)}
                  className="absolute top-1/2 left-0 -translate-y-1/2 cursor-grab touch-none text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <GripVertical size={14} />
                </button>
              ) : null}
              {entry.number}
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
                  <span
                    className={`truncate ${row.title ? "" : "text-muted italic"}`}
                    onClick={(event) => {
                      if (selected && canEdit) {
                        event.stopPropagation();
                        edit(row.id);
                      }
                    }}
                  >
                    {row.title || "Untitled"}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label={`Add a subtask to “${row.title || "Untitled"}”`}
                      title="Add subtask"
                      onClick={(event) => {
                        event.stopPropagation();
                        addSubtask(board, state, row);
                      }}
                      className="ml-auto shrink-0 rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-text focus-visible:opacity-100"
                    >
                      <Plus size={14} />
                    </button>
                  ) : null}
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
                        <span className="text-muted opacity-0 group-hover:opacity-100">Assign…</span>
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
                  initial={String(task.duration)}
                  label="Working days"
                  inputMode="numeric"
                  className="w-full text-right text-xs"
                  onCommit={(value) => {
                    setCell(null);
                    if (value.trim() !== String(task.duration)) setWorkingDays(board, task, Number(value.trim()));
                  }}
                  onCancel={() => setCell(null)}
                />
              ) : (
                <CellButton
                  editable={canEdit && !!task && !entry.isParent}
                  label={`Working days of “${row.title || "Untitled"}”`}
                  onEdit={() => setCell({ id: row.id, column: "wd" })}
                >
                  {working}
                </CellButton>
              )}
            </span>
            <span role="gridcell" aria-label={`${days} calendar days`} className="text-right text-xs tabular-nums">
              {days}
            </span>
            <span role="gridcell" aria-label={predecessor ? `After ${predecessor}` : "No predecessor"} className="text-right text-xs tabular-nums">
              {editingCell === "pred" && task ? (
                <InlineInput
                  initial={predecessor.replace("−", "-")}
                  label="Predecessor"
                  className="w-full text-right text-xs"
                  onCommit={(value) => {
                    setCell(null);
                    if (value.trim() !== predecessor.replace("−", "-")) setPredecessor(board, state, task, value, numbers);
                  }}
                  onCancel={() => setCell(null)}
                />
              ) : (
                <CellButton editable={canEdit && !!task} label={`Predecessor of “${row.title || "Untitled"}”`} onEdit={() => setCell({ id: row.id, column: "pred" })}>
                  {predecessor}
                </CellButton>
              )}
            </span>
            <span role="gridcell" className="flex justify-center">
              {task ? <ColorSwatch task={task} editable={canEdit} onChange={(color) => run({ type: "setColor", id: task.id, color })} /> : null}
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

/** A read-only value that turns into a text box when clicked (if editable). */
function CellButton({ editable, label, onEdit, children }: { editable: boolean; label: string; onEdit: () => void; children: string }) {
  if (!editable) return <span className="block truncate">{children}</span>;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onEdit();
      }}
      className="block h-6 w-full truncate rounded px-1 text-right hover:bg-surface-2"
    >
      {children || <span className="text-muted opacity-0 group-hover:opacity-100">–</span>}
    </button>
  );
}

function ColorSwatch({ task, editable, onChange }: { task: TaskRow; editable: boolean; onChange: (color: TaskColor) => void }) {
  const focusReturn = useFocusReturnOnKeyboardClose();
  const swatch = <span className="block h-3.5 w-3.5 rounded-sm" style={{ background: taskColors(task.color).fill }} />;
  if (!editable) return <span aria-label={`Color ${task.color}`}>{swatch}</span>;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`Color of “${task.title || "Untitled"}”: ${task.color}`} onClick={(event) => event.stopPropagation()} className="rounded p-1 hover:bg-surface-2">
          {swatch}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content {...focusReturn} align="end" sideOffset={4} className="z-50 grid grid-cols-3 gap-1 rounded-md border border-border bg-bg p-2 shadow-lg">
          {TASK_COLORS.map((color) => (
            <Popover.Close asChild key={color}>
              <button
                type="button"
                aria-label={color}
                aria-pressed={task.color === color}
                onClick={() => color !== task.color && onChange(color)}
                className={`h-6 w-6 rounded ${task.color === color ? "ring-2 ring-text ring-offset-1 ring-offset-bg" : ""}`}
                style={{ background: taskColors(color).fill }}
              />
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
 * Keys on the task list (when not typing): ↑/↓ select, Enter/F2 edit the title, Delete removes,
 * Alt+Shift+→ / ← indent / outdent, Escape clears the selection. Tab is never taken: it moves focus.
 */
export function useListKeys(allRows: readonly BoardRow[]) {
  const board = useBoard();
  const run = useRun();
  const { selectedId, select, edit } = useSelection();
  return (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const index = allRows.findIndex((entry) => entry.row.id === selectedId);
    const current = allRows[index];
    const move = (to: number) => {
      const next = allRows[Math.min(Math.max(to, 0), allRows.length - 1)];
      if (next) select(next.row.id);
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
