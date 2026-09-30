import { buildTree, childrenOf, computeSchedule, CycleError, fromDay, isParentTask, TASK_COLORS, type Row, type RowId, type Schedule, type TaskRow } from "@ganttlines/engine";
import { COMMAND_LIMITS } from "@ganttlines/protocol";
import { useQuery } from "@tanstack/react-query";
import { Lock, Plus, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { currentUser } from "../../api/queries";
import { Avatar } from "../../ui/avatar";
import { RichTextEditor } from "../../ui/rich-text";
import { toast } from "../../ui/toast";
import { IconButton } from "../../ui/button";
import { AssigneePicker } from "../assignee-picker";
import { PredecessorPicker } from "../predecessor-picker";
import { useBoard, useRun } from "../board-context";
import { formatDay, taskColors } from "../format";
import { formatDays } from "../chart/bars";
import { addSubtask, parseDays, setActualDays, setWorkingDays } from "../list/list-actions";
import { actualDaysOf } from "../model";
import { useSelection } from "../selection";
import { Activity } from "./activity";
import { Comments } from "./comments";

const INPUT = "w-full rounded-md border border-border-strong bg-bg px-2 py-1 text-sm text-text disabled:border-border disabled:text-muted";

/**
 * A text box for a stored value: shows the latest value (including other people's edits) until
 * you start typing, then commits on Enter or when it loses focus; Escape puts the value back.
 */
function CommitInput({ value, onCommit, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      {...props}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== null) {
          event.stopPropagation();
          setDraft(null);
        }
      }}
      className={`${INPUT} ${props.className ?? ""}`}
    />
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[7rem_1fr] items-center gap-2 text-sm">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The details panel: slides over the chart from the right and shows the selected row — its fields
 * (edited through the same checked commands as the list and chart), description, subtasks,
 * comments and history. Selecting another row retargets it; Escape or × closes it.
 */
export function DetailsPanel({ numbers }: { numbers: ReadonlyMap<RowId, number> }) {
  const board = useBoard();
  const { state, calendar, sync } = board;
  const { selectedId, panelOpen, closePanel } = useSelection();
  const me = useQuery(currentUser);
  const run = useRun();
  const panel = useRef<HTMLElement>(null);
  const selected = selectedId ? state.rows[selectedId] : undefined;
  const open = panelOpen && selected !== undefined;
  // While sliding out, keep showing the row it had (the selection may already be gone).
  const [lastId, setLastId] = useState<RowId | null>(null);
  useEffect(() => {
    if (open) setLastId(selected.id);
  }, [open, selected?.id]);
  const row = open ? selected : lastId ? state.rows[lastId] : undefined;
  // Rich text boxes grow up to half the panel's height.
  const [halfHeight, setHalfHeight] = useState(240);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => setHalfHeight(Math.round(element.clientHeight / 2) || 240);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [row !== undefined]);
  const schedule = useMemo<Schedule | null>(() => {
    try {
      return computeSchedule(state, calendar);
    } catch (error) {
      if (error instanceof CycleError) return null;
      throw error;
    }
  }, [state, calendar]);

  if (!row) return null;
  // Selecting a row opens the panel without taking focus (the list keeps the keyboard). Closing it
  // from inside hands focus back to the row's title in the list.
  const close = () => {
    const inside = panel.current?.contains(document.activeElement) ?? false;
    closePanel();
    if (inside) (document.querySelector<HTMLElement>(`[data-cell="${CSS.escape(row.id)}:title"]`) ?? document.querySelector<HTMLElement>('[role="treegrid"]'))?.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
      event.stopPropagation();
      close();
    }
  };
  const tree = buildTree(state);
  const children = childrenOf(tree, row.id);
  const isParent = isParentTask(tree, row);
  const kindLabel = row.kind === "section" ? "Section" : isParent ? "Parent task" : row.kind === "task" && row.duration === 0 ? "Milestone" : "Task";

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={`Details of “${row.title || "Untitled"}”`}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={onKey}
      // Slides in (on first mount by the keyframes, later by the transition) and out; still for reduced motion.
      className={`animate-panel-in absolute top-0 right-0 bottom-0 z-30 flex w-[min(26rem,92%)] flex-col overflow-y-auto border-l border-border bg-bg shadow-xl outline-none transition-[translate,visibility] duration-200 ease-out motion-reduce:animate-none motion-reduce:transition-none ${
        open ? "visible translate-x-0" : "invisible translate-x-full"
      }`}
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg px-4 py-2">
        <span className="text-xs text-muted">
          #{numbers.get(row.id)} · {kindLabel}
        </span>
        <IconButton label="Close details (Esc)" className="ml-auto" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        <CommitInput
          aria-label="Task title"
          value={row.title}
          placeholder="Untitled"
          maxLength={COMMAND_LIMITS.titleMax}
          disabled={!board.canEdit}
          onCommit={(title) => run({ type: "updateTitle", id: row.id, title: title.trim() })}
          className="border-transparent px-1 text-base font-semibold hover:border-border focus:border-border-strong"
        />
        {row.kind === "task" ? <Description task={row} maxHeight={halfHeight} /> : null}
        {row.kind === "task" ? <TaskFields task={row} isParent={isParent} schedule={schedule} numbers={numbers} /> : null}
      </div>
      <Section title={row.kind === "section" ? "Tasks" : "Subtasks"}>
        <ul className="flex flex-col gap-1 text-sm">
          {children.map((child) => (
            <ChildLink key={child.id} child={child} schedule={schedule} numbers={numbers} />
          ))}
        </ul>
        {children.length === 0 ? <p className="text-sm text-muted">None.</p> : null}
        {board.canEdit ? (
          <button type="button" className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text" onClick={() => addSubtask(board, state, row)}>
            <Plus size={13} /> Add {row.kind === "section" ? "a task" : "a subtask"}
          </button>
        ) : null}
      </Section>
      {row.kind === "task" ? (
        <Section title="Comments">
          <Comments projectId={sync.projectId} taskId={row.id} canComment={board.canComment} isAdmin={me.data?.role === "admin"} maxHeight={halfHeight} />
        </Section>
      ) : null}
      <Section title="History">
        <Activity projectId={sync.projectId} rowId={row.id} names={{ state, resources: board.resourceMap }} />
      </Section>
    </aside>
  );
}

function TaskFields({ task, isParent, schedule, numbers }: { task: TaskRow; isParent: boolean; schedule: Schedule | null; numbers: ReadonlyMap<RowId, number> }) {
  const board = useBoard();
  const run = useRun();
  const { canEdit, resources, resourceMap, canCreateResources, state } = board;
  const span = schedule?.get(task.id)?.span ?? null;
  const assignee = task.resourceId ? resourceMap.get(task.resourceId) : undefined;
  const leaf = !isParent;
  const actualSum = isParent ? actualDaysOf(state, buildTree(state), task.id) : null;
  const milestone = leaf && task.duration === 0;
  const datesLocked = leaf && task.locked;
  const predecessor = task.predecessorId ? state.rows[task.predecessorId] : undefined;
  const predecessorLabel = predecessor ? `#${numbers.get(predecessor.id)} ${predecessor.title || "Untitled"}` : "None";

  return (
    <div className="flex flex-col gap-2">
      <Field label="Assignee">
        {canEdit ? (
          <AssigneePicker
            value={task.resourceId}
            resources={resources}
            canCreate={canCreateResources}
            onChange={(resourceId) => run({ type: "setAssignee", id: task.id, resourceId })}
            trigger={
              <button type="button" aria-label={`Assignee: ${assignee?.name ?? "nobody"}`} className={`${INPUT} flex items-center gap-2 text-left`}>
                {assignee ? <Avatar name={assignee.name} color={assignee.avatarColor} size={18} /> : <UserRound size={16} className="text-muted" />}
                {assignee?.name ?? <span className="text-muted">Unassigned</span>}
              </button>
            }
          />
        ) : (
          <span>{assignee?.name ?? "Unassigned"}</span>
        )}
      </Field>
      <Field label={milestone ? "Date" : "Start"}>
        <CommitInput
          type="date"
          aria-label={milestone ? "Date" : "Start"}
          value={span ? fromDay(span.start) : ""}
          disabled={!canEdit || datesLocked}
          onCommit={(date) => date && run({ type: "moveTask", id: task.id, start: date })}
        />
      </Field>
      {!milestone ? (
        <Field label="End">
          <CommitInput
            type="date"
            aria-label="End"
            value={span ? fromDay(span.end) : ""}
            disabled={!canEdit || !leaf || datesLocked || !span}
            min={span ? fromDay(span.start) : undefined}
            onCommit={(date) => date && run({ type: "resizeTask", id: task.id, edge: "end", date })}
          />
        </Field>
      ) : null}
      {leaf ? (
        <Field label="Working days">
          <CommitInput
            type="number"
            aria-label="Working days"
            min={0}
            step={0.5}
            value={String(task.duration)}
            disabled={!canEdit || datesLocked}
            onCommit={(value) => {
              const days = parseDays(value);
              if (days !== null) setWorkingDays(board, task, days);
            }}
          />
        </Field>
      ) : (
        <Field label="Dates">
          <span className="text-muted">{span ? `${formatDay(span.start)} – ${formatDay(span.end)} (from its subtasks)` : "From its subtasks (none scheduled)"}</span>
        </Field>
      )}
      {leaf && !milestone ? (
        <Field label="Actual work days">
          <CommitInput
            type="number"
            aria-label="Actual work days"
            min={0.5}
            step={0.5}
            placeholder="Not recorded"
            value={task.actualDuration === null ? "" : String(task.actualDuration)}
            disabled={!canEdit}
            onCommit={(value) => setActualDays(board, task, parseDays(value))}
          />
        </Field>
      ) : null}
      {!leaf && actualSum !== null ? (
        <Field label="Actual work days">
          <span className="text-muted">{formatDays(actualSum)} (from its subtasks)</span>
        </Field>
      ) : null}
      <Field label="Predecessor">
        {canEdit ? (
          <PredecessorPicker
            task={task}
            state={state}
            schedule={schedule}
            numbers={numbers}
            trigger={
              <button type="button" aria-label={`Predecessor: ${predecessorLabel}`} className={`${INPUT} truncate text-left`}>
                {predecessorLabel}
              </button>
            }
          />
        ) : (
          <span>{predecessorLabel}</span>
        )}
      </Field>
      <Field label="Color">
        <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1">
          {TASK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={task.color === color}
              aria-label={color}
              disabled={!canEdit}
              onClick={() => color !== task.color && run({ type: "setColor", id: task.id, color })}
              className={`h-5 w-5 rounded ${task.color === color ? "ring-2 ring-text ring-offset-1 ring-offset-bg" : ""}`}
              style={{ background: taskColors(color).fill }}
            />
          ))}
        </div>
      </Field>
      {leaf ? (
        <div className="flex gap-4 pl-[7.5rem] text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={milestone} disabled={!canEdit || datesLocked} onChange={(event) => run({ type: "convertMilestone", id: task.id, milestone: event.target.checked })} />
            Milestone
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={task.locked} disabled={!canEdit} onChange={(event) => run({ type: "setLocked", id: task.id, locked: event.target.checked })} />
            <Lock size={12} aria-hidden /> Lock dates
          </label>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The task's description, as formatted text (stored as Markdown). The box grows with its content up
 * to half the panel's height, and opens to that height while it's being edited.
 */
function Description({ task, maxHeight }: { task: TaskRow; maxHeight: number }) {
  const { canEdit } = useBoard();
  const run = useRun();
  return (
    <RichTextEditor
      key={task.id}
      value={task.description}
      label="Description"
      placeholder={canEdit ? "Add a description…" : "No description."}
      editable={canEdit}
      autoSize={{ min: 72, max: maxHeight, expandOnFocus: true }}
      onCommit={(description) => {
        if (description.length > COMMAND_LIMITS.descriptionMax) return toast(`Descriptions are limited to ${COMMAND_LIMITS.descriptionMax} characters`, { tone: "error" });
        run({ type: "setDescription", id: task.id, description });
      }}
    />
  );
}

function ChildLink({ child, schedule, numbers }: { child: Row; schedule: Schedule | null; numbers: ReadonlyMap<RowId, number> }) {
  const select = useSelection((selection) => selection.select);
  const span = schedule?.get(child.id)?.span;
  return (
    <li>
      <button type="button" onClick={() => select(child.id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2">
        <span className="w-8 text-right text-xs text-muted tabular-nums">#{numbers.get(child.id)}</span>
        <span className="truncate">{child.title || "Untitled"}</span>
        <span className="ml-auto shrink-0 text-xs text-muted">{span ? (span.start === span.end ? formatDay(span.start) : `${formatDay(span.start)} – ${formatDay(span.end)}`) : "–"}</span>
      </button>
    </li>
  );
}

