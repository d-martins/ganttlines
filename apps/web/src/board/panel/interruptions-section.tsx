import { dayOf, fromDay, isAfternoon, partsOf, pausesOf, toDay, type Calendar, type Command, type HalfDay, type Schedule, type TaskRow } from "@ganttlines/engine";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../../ui/button";
import { formatDays } from "../chart/bars";
import { formatDay } from "../format";

const DATE = "min-w-0 flex-1 rounded-md border border-border-strong bg-bg px-1.5 py-1 text-sm text-text";

interface Stored {
  after: number;
  from: string;
  to: string;
  /** the half work stopped in, and where it picks up, for an end the panel's whole days leave alone */
  startsAfternoon: boolean;
  resume: HalfDay;
}

/** One interruption's dates: Save appears once there's something to save. */
function Line({ stored, label, canEdit, note, onSave, onRemove }: { stored: Stored | null; label: string; canEdit: boolean; note?: string | null; onSave: (from: string, to: string) => boolean; onRemove: () => void }) {
  const [from, setFrom] = useState(stored?.from ?? "");
  const [to, setTo] = useState(stored?.to ?? "");
  const changed = from !== "" && to !== "" && (from !== stored?.from || to !== stored?.to);
  return (
    <li className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1 text-sm">
        <input type="date" aria-label={`Interrupted from${label}`} value={from} onChange={(event) => setFrom(event.target.value)} className={DATE} />
        to
        <input type="date" aria-label={`Interrupted until${label}`} value={to} onChange={(event) => setTo(event.target.value)} className={DATE} />
        {canEdit && changed ? (
          <button type="button" onClick={() => onSave(from, to)} className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-text">
            Save
          </button>
        ) : null}
        <IconButton label={`Remove interruption${label}`} onClick={onRemove} className="shrink-0">
          <X size={14} />
        </IconButton>
      </div>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
    </li>
  );
}

/** A task's own interruptions: from and to, whole days. Half days come from the chart. */
export function InterruptionsSection({ task, schedule, calendar, canEdit, run }: { task: TaskRow; schedule: Schedule | null; calendar: Calendar; canEdit: boolean; run: (command: Command) => unknown }) {
  const [adding, setAdding] = useState(false);
  const computed = schedule?.get(task.id);
  const resource = task.resourceId;
  const stored: Stored[] = pausesOf(task, partsOf(computed), calendar).map(({ after, lastWorked, resume }) => ({
    after,
    from: fromDay(dayOf(calendar.nextHalfAfter(lastWorked, resource))),
    to: fromDay(dayOf(calendar.snapHalfBack(resume - 1, resource))),
    startsAfternoon: isAfternoon(calendar.nextHalfAfter(lastWorked, resource)),
    resume,
  }));
  const addition = (from: string, to: string, was?: Stored) => {
    const keepsEnd = was?.to === to;
    const resume = keepsEnd ? fromDay(dayOf(was!.resume)) : fromDay(calendar.nextAfter(toDay(to), resource));
    return {
      type: "addBreak" as const,
      id: task.id,
      from,
      ...(was?.from === from && was.startsAfternoon ? { fromHalf: "afternoon" as const } : {}),
      resume,
      ...(keepsEnd && isAfternoon(was!.resume) ? { resumeHalf: "afternoon" as const } : {}),
    };
  };
  const finish = computed?.span ? formatDay(computed.span.end) : null;
  const note = finish ? `Still ${formatDays(task.duration)} ${task.duration === 1 ? "day" : "days"} of work. Now finishes ${finish}.` : null;
  if (!canEdit) {
    if (stored.length === 0) return <p className="text-sm text-muted">None</p>;
    return (
      <ul className="flex flex-col gap-1 text-sm">
        {stored.map(({ after, from, to }) => (
          <li key={after}>
            {formatDay(toDay(from))} to {formatDay(toDay(to))}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {stored.length > 0 || adding ? (
        <ul className="flex flex-col gap-2">
          {stored.map((line) => (
            <Line
              // A saved change is a new line, with the dates it now has.
              key={`${line.after}-${line.from}-${line.to}`}
              stored={line}
              label={` ${line.from}`}
              canEdit
              note={note}
              onSave={(from, to) => run({ type: "relink", steps: [{ type: "removeBreak", id: task.id, after: line.after }, addition(from, to, line)] }) !== null}
              onRemove={() => run({ type: "removeBreak", id: task.id, after: line.after })}
            />
          ))}
          {adding ? (
            <Line
              stored={null}
              label=""
              canEdit
              onSave={(from, to) => {
                const done = run(addition(from, to)) !== null;
                if (done) setAdding(false);
                return done;
              }}
              onRemove={() => setAdding(false)}
            />
          ) : null}
        </ul>
      ) : null}
      {!adding ? (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text">
          <Plus aria-hidden size={13} /> Add interruption
        </button>
      ) : null}
    </div>
  );
}
