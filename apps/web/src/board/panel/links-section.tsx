import {
  isAncestor,
  LINK_KIND_WORDS,
  LINK_KINDS,
  linkKey,
  linksInto,
  linksOutOf,
  type Command,
  type Link,
  type LinkKey,
  type LinkKind,
  type ProjectState,
  type Row,
  type RowId,
  type Schedule,
  type TaskRow,
} from "@ganttlines/engine";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { IconButton } from "../../ui/button";
import { parseDays } from "../list/list-actions";
import { useSelection } from "../selection";
import { delayWords } from "../link-words";
import { TaskPicker } from "../task-picker";
import { CommitInput, INPUT } from "./commit-input";

type Direction = "into" | "outOf";
const DIRECTIONS: readonly { id: Direction; label: string }[] = [
  { id: "into", label: "Waits on" },
  { id: "outOf", label: "Needed by" },
];

const SELECT = `${INPUT} w-auto min-w-0`;

function KindSelect({ value, label, onChange, selectRef }: { value: LinkKind; label: string; onChange: (kind: LinkKind) => void; selectRef?: Ref<HTMLSelectElement> }) {
  return (
    <select ref={selectRef} aria-label={label} value={value} onChange={(event) => onChange(event.target.value as LinkKind)} className={SELECT}>
      {LINK_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {LINK_KIND_WORDS[kind]}
        </option>
      ))}
    </select>
  );
}

/**
 * One link, named by its task at the far end: a button that goes there, then its kind and delay.
 * A new kind makes it another link (and line), so `focusKind` puts focus back on its kind.
 */
function LinkLine({
  link,
  otherId,
  direction,
  state,
  numbers,
  canEdit,
  run,
  focusKind,
  onKindChanged,
  onRemoved,
}: {
  link: Link;
  otherId: RowId;
  direction: Direction;
  state: ProjectState;
  numbers: ReadonlyMap<RowId, number>;
  canEdit: boolean;
  run: (command: Command) => unknown;
  focusKind: boolean;
  onKindChanged: (key: LinkKey | null) => void;
  onRemoved: () => void;
}) {
  const select = useSelection((selection) => selection.select);
  const kindSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!focusKind) return;
    kindSelect.current?.focus();
    onKindChanged(null);
  }, [focusKind]);
  const ref = { predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind };
  const other = `#${numbers.get(otherId)} ${state.rows[otherId]?.title || "Untitled"}`;
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-sm">
      <button type="button" onClick={() => select(otherId)} className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-2">
        <span className="text-xs text-muted tabular-nums">#{numbers.get(otherId)}</span>{" "}
        <span className="truncate">{state.rows[otherId]?.title || "Untitled"}</span>
      </button>
      {canEdit ? (
        <div className="ml-auto flex items-center gap-1">
          <KindSelect
            value={link.kind}
            label={`Kind of link with ${other}`}
            selectRef={kindSelect}
            onChange={(newKind) => {
              if (newKind !== link.kind && run({ type: "updateLink", ...ref, newKind }) !== null) onKindChanged(linkKey({ ...ref, kind: newKind }));
            }}
          />
          <CommitInput
            type="number"
            // On a "Needed by" line, the delay belongs to the other task's link to this one.
            aria-label={direction === "into" ? `Delay after ${other}` : `Delay for ${other}`}
            title={link.kind === "FS" ? "Delay in working days (negative: overlap)" : "Delay in working days"}
            step={0.5}
            min={link.kind === "FS" ? undefined : 0}
            value={String(link.lag)}
            onCommit={(value) => run({ type: "updateLink", ...ref, lag: parseDays(value) ?? 0 })}
            className="w-16"
          />
          <IconButton data-remove-link label={`Remove link with ${other}`} onClick={() => run({ type: "removeLink", ...ref }) !== null && onRemoved()}>
            <X size={14} />
          </IconButton>
        </div>
      ) : (
        <span className="ml-auto text-xs text-muted">
          {LINK_KIND_WORDS[link.kind]}
          {delayWords(link.lag)}
        </span>
      )}
    </li>
  );
}

/**
 * A task's links: the tasks it waits on and those that wait on it, each with its kind and delay.
 * Editors change, remove and add links here; refusals show as any refused edit does.
 */
export function LinksSection({
  task,
  state,
  numbers,
  canEdit,
  run,
  schedule = null,
}: {
  task: TaskRow;
  state: ProjectState;
  numbers: ReadonlyMap<RowId, number>;
  canEdit: boolean;
  run: (command: Command) => unknown;
  /** dates shown next to the tasks offered for a new link */
  schedule?: Schedule | null;
}) {
  const [direction, setDirection] = useState<Direction>("into");
  const [kind, setKind] = useState<LinkKind>("FS");
  const [focusKind, setFocusKind] = useState<LinkKey | null>(null);
  // After ×, the line that took the removed one's place (or Add link, when none is left) gets focus.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ index: number; before: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const groups = [
    { ...DIRECTIONS[0]!, links: linksInto(state, task.id), otherOf: (link: Link) => link.predecessorId },
    { ...DIRECTIONS[1]!, links: linksOutOf(state, task.id), otherOf: (link: Link) => link.followerId },
  ];
  const between = (otherId: RowId) => (direction === "into" ? { predecessorId: otherId, followerId: task.id } : { predecessorId: task.id, followerId: otherId });
  // Never itself, a section, its own parents or subtasks, or a task already linked this way.
  const exclude = (row: Row) =>
    row.kind !== "task" || row.id === task.id || isAncestor(state, row.id, task.id) || isAncestor(state, task.id, row.id) || state.links[linkKey({ ...between(row.id), kind })] !== undefined;

  const total = groups[0]!.links.length + groups[1]!.links.length;
  useEffect(() => {
    // Once the removed line is gone.
    if (focusAfterRemove === null || total >= focusAfterRemove.before || !container.current) return;
    setFocusAfterRemove(null);
    const removes = container.current.querySelectorAll<HTMLElement>("[data-remove-link]");
    (removes[focusAfterRemove.index] ?? container.current.querySelector<HTMLElement>("[data-add-link]"))?.focus();
  }, [focusAfterRemove, total]);
  const flatIndex = (direction: Direction, index: number) => (direction === "outOf" ? groups[0]!.links.length : 0) + index;

  return (
    <div ref={container} className="flex flex-col gap-2">
      {groups.map(({ id, label, links, otherOf }) =>
        links.length > 0 ? (
          <div key={id} role="group" aria-label={label} className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-muted">{label}</h4>
            <ul className="flex flex-col gap-1">
              {links.map((link, index) => (
                <LinkLine
                  key={linkKey(link)}
                  link={link}
                  otherId={otherOf(link)}
                  direction={id}
                  state={state}
                  numbers={numbers}
                  canEdit={canEdit}
                  run={run}
                  focusKind={focusKind === linkKey(link)}
                  onKindChanged={setFocusKind}
                  onRemoved={() => setFocusAfterRemove({ index: flatIndex(id, index), before: total })}
                />
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {groups.every(({ links }) => links.length === 0) ? <p className="text-sm text-muted">None.</p> : null}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-1">
          <select aria-label="New link direction" value={direction} onChange={(event) => setDirection(event.target.value as Direction)} className={SELECT}>
            {DIRECTIONS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <KindSelect value={kind} label="New link kind" onChange={setKind} />
          <TaskPicker
            exclude={exclude}
            onPick={(otherId) => run({ type: "addLink", ...between(otherId), kind })}
            state={state}
            schedule={schedule}
            numbers={numbers}
            searchLabel="Find a task to link"
            trigger={
              <button type="button" data-add-link className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text">
                <Plus size={13} /> Add link
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
