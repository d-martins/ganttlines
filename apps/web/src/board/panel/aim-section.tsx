import { effectiveTarget, fromDay, spanEnd, tagKey, type RowId, type Schedule, type TaskRow } from "@ganttlines/engine";
import { X } from "lucide-react";
import { useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useBoard, useRun } from "../board-context";
import { formatDay, today } from "../format";
import { formatSlack, milestonesOf, newMilestonePlace } from "../slack";
import { useFloatingList } from "./suggestion-list";

type Choice = { kind: "milestone"; id: RowId; title: string; day: number | null } | { kind: "create"; title: string };

/** How the task stands against the milestone: "2 days late: finishes …", "3 days to spare", "No date yet". */
function standing(task: TaskRow, targetId: RowId, schedule: Schedule | null, calendar: ReturnType<typeof useBoard>["calendar"]): string | null {
  const mine = schedule?.get(task.id)?.span;
  const theirs = schedule?.get(targetId)?.span;
  if (!theirs) return "No date yet";
  if (!mine) return null;
  const gap = calendar.workingHalvesBetween(spanEnd(mine), spanEnd(theirs), task.resourceId);
  if (gap >= 0) return `${formatSlack(gap)} to spare`;
  return `${formatSlack(-gap)} late: finishes ${formatDay(mine.end)}, milestone is ${formatDay(theirs.end)}`;
}

/**
 * The milestone a task aims for. A box like the tags': click for the board's milestones, type to narrow
 * them or name a new one, which starts on the task's finish with its date ready to correct. Aiming moves nothing.
 */
export function AimSection({ task, schedule }: { task: TaskRow; schedule: Schedule | null }) {
  const { state, calendar, canEdit } = useBoard();
  const run = useRun();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [correcting, setCorrecting] = useState<RowId | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

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

  const targetId = effectiveTarget(state, task);
  const inherited = targetId !== null && task.targetId !== targetId;
  const target = targetId === null ? undefined : state.rows[targetId];
  const source = inherited ? findSource(state.rows, task, targetId) : null;
  const result = targetId !== null ? standing(task, targetId, schedule, calendar) : null;
  const correctingSpan = correcting ? schedule?.get(correcting)?.span : null;

  const clear = () => {
    setText("");
    setHighlight(null);
    setOpen(false);
  };
  const pick = (choice: Choice) => {
    if (choice.kind === "milestone") {
      if (run({ type: "setTarget", id: task.id, targetId: choice.id })) clear();
      return;
    }
    const newId = crypto.randomUUID();
    const finish = schedule?.get(task.id)?.span?.end ?? today();
    if (!run({ type: "createTargetMilestone", id: task.id, newId, title: choice.title, ...newMilestonePlace(state), start: fromDay(finish) })) return;
    clear();
    setCorrecting(newId);
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
      const exactChoice = choices.find((choice) => tagKey(choice.title) === needle);
      const choice = showList ? choices[active] : needle ? exactChoice : undefined;
      if (choice) pick(choice);
    } else if (event.key === "Escape" && showList) {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Escape" && text) {
      event.stopPropagation();
      setText("");
    }
  };

  const onLeave = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setCorrecting(null);
  };

  const summary = target ? (
    <div className="flex flex-col gap-0.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-text">{target.title || "Untitled"}</span>
        {canEdit && !inherited ? (
          <button type="button" aria-label={`Stop aiming for “${target.title}”`} onClick={() => run({ type: "setTarget", id: task.id, targetId: null })} className="ml-auto rounded-full text-muted hover:text-text">
            <X aria-hidden size={14} />
          </button>
        ) : null}
      </div>
      {source ? <span className="text-xs text-muted">From {source}</span> : null}
      {result ? <span className={`text-xs ${result.includes("late") ? "text-danger" : "text-muted"}`}>{result}</span> : null}
    </div>
  ) : null;

  if (!canEdit) return summary ?? <p className="text-sm text-muted">None</p>;
  return (
    <div className="flex flex-col gap-1" onBlur={onLeave}>
      {summary}
      {target && !inherited ? null : (
        <div className="min-w-28">
          <input
            ref={box}
            role="combobox"
            aria-label="Aiming for"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            placeholder="Pick or name a milestone"
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
            className="w-full rounded-md border border-transparent bg-transparent px-0 py-0.5 text-sm text-text outline-none transition-[padding,border-color] duration-200 ease-out placeholder:text-muted focus:border-border-strong focus:bg-bg focus:px-2 motion-reduce:transition-none"
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
                      <span className="truncate">{choice.title || "Untitled"}</span>
                      <span className="flex-none text-xs text-muted">{choice.day === null ? "no date" : formatDay(choice.day)}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {correcting ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          Date
          <input
            type="date"
            aria-label="Milestone date"
            autoFocus
            value={correctingSpan ? fromDay(correctingSpan.start) : ""}
            onChange={(event) => event.target.value && run({ type: "moveTask", id: correcting, start: event.target.value })}
            className="rounded-md border border-border-strong bg-bg px-2 py-0.5 text-sm text-text"
          />
        </label>
      ) : null}
    </div>
  );
}

function findSource(rows: ReturnType<typeof useBoard>["state"]["rows"], task: TaskRow, targetId: RowId): string | null {
  for (let up = task.parentId === null ? undefined : rows[task.parentId]; up; up = up.parentId === null ? undefined : rows[up.parentId]) {
    if (up.kind === "task" && up.targetId === targetId) return up.title || "Untitled";
  }
  return null;
}
