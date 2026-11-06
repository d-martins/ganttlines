import { buildTree, childrenOf, dayOf, effectiveTarget, fromDay, isParentTask, spanEnd, tagKey, type Calendar, type Command, type HalfDay, type ProjectState, type RowId, type Schedule, type TaskRow } from "@ganttlines/engine";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "../../ui/button";
import { formatDay, today } from "../format";
import { formatSlack, milestonesOf, newMilestonePlace } from "../slack";
import { CommitInput } from "./commit-input";
import { useFloatingList } from "./suggestion-list";

/** The word for aiming on a link line, beside "starts after" and the rest. */
export const AIMS_FOR = "aims for";
/** The same, read from the milestone. */
export const AIMED_BY = "aimed by";

type Choice = { kind: "milestone"; id: RowId; title: string; day: number | null } | { kind: "create"; title: string };

interface AimProps {
  task: TaskRow;
  state: ProjectState;
  calendar: Calendar;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  run: (command: Command) => unknown;
}

/** How the task stands against the milestone: "2 days late: finishes …", "3 days to spare", "No date yet". */
/**
 * When a task's work is done, measured against `targetId`: for a parent, the last of its subtasks that answer
 * to that milestone. A milestone inside it is a date, not work, so it doesn't make the parent late.
 */
function workFinish(task: TaskRow, state: ProjectState, schedule: Schedule | null, targetId: RowId): HalfDay | null {
  const tree = buildTree(state);
  if (!isParentTask(tree, task)) {
    const span = schedule?.get(task.id)?.span;
    return span ? spanEnd(span) : null;
  }
  const finishes: HalfDay[] = [];
  const walk = (parent: RowId) => {
    for (const child of childrenOf(tree, parent)) {
      if (child.kind !== "task") continue;
      if (isParentTask(tree, child)) {
        walk(child.id);
        continue;
      }
      if (child.duration === 0 || effectiveTarget(state, child) !== targetId) continue;
      const span = schedule?.get(child.id)?.span;
      if (span) finishes.push(spanEnd(span));
    }
  };
  walk(task.id);
  return finishes.length > 0 ? Math.max(...finishes) : null;
}

export function standing({ task, state, calendar, schedule }: Pick<AimProps, "task" | "state" | "calendar" | "schedule">, targetId: RowId): { text: string; late: boolean } | null {
  const theirs = schedule?.get(targetId)?.span;
  if (!theirs) return { text: "No date yet", late: false };
  const finish = workFinish(task, state, schedule, targetId);
  if (finish === null) return null;
  const gap = calendar.workingHalvesBetween(finish, spanEnd(theirs), task.resourceId);
  if (gap >= 0) return { text: `${formatSlack(gap)} to spare`, late: false };
  return { text: `${formatSlack(-gap)} late: finishes ${formatDay(dayOf(finish))}, milestone is ${formatDay(theirs.end)}`, late: true };
}

/**
 * Picks the milestone a task aims for, or names a new one, which starts on the task's finish. Works like
 * the tag box: it opens with the board's milestones, soonest first, and typing narrows them.
 */
export function AimPicker({ task, state, schedule, numbers, run, onDone, onCreated }: AimProps & { onDone: () => void; onCreated: (id: RowId) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  useEffect(() => box.current?.focus(), []);

  const milestones = useMemo(() => {
    const dayOf = (id: RowId) => schedule?.get(id)?.span?.start ?? null;
    return milestonesOf(state)
      .map((row) => ({ id: row.id, title: row.title, day: dayOf(row.id) }))
      .sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity));
  }, [state, schedule]);

  const needle = tagKey(text);
  const exact = needle !== "" && milestones.some((milestone) => tagKey(milestone.title) === needle);
  const choices: Choice[] = [
    ...milestones.filter((milestone) => tagKey(milestone.title).includes(needle)).map((milestone) => ({ kind: "milestone" as const, ...milestone })),
    ...(needle && !exact ? [{ kind: "create" as const, title: text.trim() }] : []),
  ];
  const showList = open && choices.length > 0;
  const active = Math.min(highlight ?? (needle ? 0 : -1), choices.length - 1);
  useFloatingList(showList, box, list);

  const pick = (choice: Choice) => {
    if (choice.kind === "milestone") {
      if (run({ type: "setTarget", id: task.id, targetId: choice.id }) !== null) onDone();
      return;
    }
    const newId = crypto.randomUUID();
    const finish = schedule?.get(task.id)?.span?.end ?? today();
    if (run({ type: "createTargetMilestone", id: task.id, newId, title: choice.title, ...newMilestonePlace(state), start: fromDay(finish) }) === null) return;
    onCreated(newId);
    onDone();
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      if (!showList) return setOpen(true);
      const down = event.key === "ArrowDown";
      setHighlight(active < 0 ? (down ? 0 : choices.length - 1) : (active + (down ? 1 : -1) + choices.length) % choices.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = showList ? choices[active] : needle ? choices.find((candidate) => tagKey(candidate.title) === needle) : undefined;
      if (choice) pick(choice);
    } else if (event.key === "Escape" && showList) {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Escape" && text) {
      event.stopPropagation();
      setText("");
    }
  };

  return (
    <div className="min-w-0 flex-1">
      <input
        ref={box}
        role="combobox"
        aria-label="Aims for: choose a milestone"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={task.targetId !== null && state.rows[task.targetId] ? `Instead of ${state.rows[task.targetId]!.title || "Untitled"}` : "Pick or name a milestone"}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setHighlight(null);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setHighlight(null);
        }}
        className="w-full rounded-md border border-border-strong bg-bg px-2 py-1 text-sm text-text placeholder:text-muted"
      />
      {showList ? (
        <ul ref={list} id={listId} role="listbox" aria-label="Milestones" className="fixed z-50 w-64 overflow-y-auto rounded-md border border-border bg-bg p-1 text-sm shadow-lg">
          {choices.map((choice, index) => (
            <li
              key={choice.kind === "create" ? "create" : choice.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keeps the focus in the box.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => pick(choice)}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 ${index === active ? "bg-surface-2" : ""} ${choice.kind === "create" ? "text-accent" : ""}`}
            >
              {choice.kind === "create" ? (
                `+ Create "${choice.title}"`
              ) : (
                <>
                  <span className="truncate">{`#${numbers.get(choice.id) ?? 0} ${choice.title || "Untitled"}`}</span>
                  <span className="flex-none text-xs text-muted">{choice.day === null ? "no date" : formatDay(choice.day)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The aim as the first of a task's link lines: `[aims for ▾] [#14 Milestone ▾] ×`, with how it stands
 * under it. One from a parent is a plain line. `whenSelect` is the first dropdown, for editors.
 */
export function AimLine({
  canEdit,
  correcting,
  onCorrected,
  onCreated,
  onGo,
  whenSelect,
  onStopped,
  ...props
}: AimProps & {
  canEdit: boolean;
  /** a milestone just created here, whose date is ready to correct */
  correcting: RowId | null;
  onCorrected: () => void;
  onCreated: (id: RowId) => void;
  onGo: (id: RowId) => void;
  whenSelect: ReactNode;
  /** the × was pressed, and this line is going: where the keyboard goes next is the caller's */
  onStopped: () => void;
}) {
  const { task, state, schedule, numbers, run } = props;
  const [changing, setChanging] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const changeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    // A milestone just made here: its date has the focus.
    if (correcting === null) changeButton.current?.focus();
  }, [refocus]);
  const targetId = effectiveTarget(state, task);
  const target = targetId === null ? undefined : state.rows[targetId];
  if (targetId === null || !target) return null;
  const inherited = task.targetId !== targetId;
  const name = `#${numbers.get(targetId) ?? 0} ${target.title || "Untitled"}`;
  const result = standing(props, targetId);
  const source = inherited ? sourceOf(state, task, targetId) : null;
  const correctingSpan = correcting ? schedule?.get(correcting)?.span : null;
  const note = [source ? `From ${source}` : null, result?.text ?? null].filter(Boolean).join(" · ");
  return (
    <li data-link-line className="flex min-w-0 flex-col gap-1 text-sm">
      {canEdit && !inherited ? (
        <div className="flex min-w-0 items-center gap-1">
          {whenSelect}
          {changing ? (
            <AimPicker
              {...props}
              onDone={() => {
                setChanging(false);
                setRefocus(true);
              }}
              onCreated={onCreated}
            />
          ) : (
            <button
              ref={changeButton}
              type="button"
              aria-label={`Aims for ${name}: change the milestone`}
              title={name}
              onClick={() => setChanging(true)}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border-strong bg-bg px-2 py-1 text-left text-sm text-text"
            >
              <span className="truncate">{name}</span>
              <ChevronDown aria-hidden size={13} className="ml-auto shrink-0 text-muted" />
            </button>
          )}
          <IconButton label={`Stop aiming for “${target.title}”`} onClick={() => run({ type: "setTarget", id: task.id, targetId: null }) !== null && onStopped()} className="shrink-0">
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        <div className="min-w-0">
          {AIMS_FOR}{" "}
          <button type="button" onClick={() => onGo(targetId)} className="rounded px-0.5 font-medium hover:bg-surface-2">
            {name}
          </button>
        </div>
      )}
      {note ? <span className={`text-xs ${result?.late ? "text-danger" : "text-muted"}`}>{note}</span> : null}
      {correcting ? (
        <label className="flex items-center gap-2 text-xs text-muted" onBlur={onCorrected}>
          Date
          <CommitInput
            type="date"
            aria-label="Milestone date"
            autoFocus
            value={correctingSpan ? fromDay(correctingSpan.start) : ""}
            onCommit={(date) => date && run({ type: "moveTask", id: correcting, start: date })}
            className="w-auto py-0.5"
          />
        </label>
      ) : null}
    </li>
  );
}

function sourceOf(state: ProjectState, task: TaskRow, targetId: RowId): string | null {
  const { rows } = state;
  for (let up = task.parentId === null ? undefined : rows[task.parentId]; up; up = up.parentId === null ? undefined : rows[up.parentId]) {
    if (up.kind === "task" && up.targetId === targetId) return up.title || "Untitled";
  }
  return null;
}
