import {
  applyCommand,
  buildTree,
  effectiveTarget,
  isAncestor,
  isParentTask,
  isValidTarget,
  linkKey,
  linksInto,
  linksOutOf,
  type Calendar,
  type Command,
  type Link,
  type LinkKey,
  type ProjectState,
  type Row,
  type RowId,
  type Schedule,
  type TaskRow,
} from "@ganttlines/engine";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { IconButton } from "../../ui/button";
import { toast } from "../../ui/toast";
import { END_WORDS, lineOf, linkOf, WHEN_WORDS, type LinkLine, type LinkShape } from "../link-phrases";
import { useSelection } from "../selection";
import { TaskPicker } from "../task-picker";
import { AIMED_BY, AIMS_FOR, AimLine, AimPicker, standing } from "./aim-section";

// Sized to their words (not the panel's full-width inputs), so a line fits: the task takes what's left.
const SELECT = "shrink-0 rounded-md border border-border-strong bg-bg px-1.5 py-1 text-sm text-text";
const TASK_BUTTON = "flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border-strong bg-bg px-2 py-1 text-left text-sm hover:bg-surface-2";

type Control = "when" | "end" | "task";
/** A line to focus once it shows: the link it now stands for, and which of its controls. */
type FocusRequest = { key: LinkKey; control: Control };
type LineRefs = { when: RefObject<HTMLSelectElement | null>; end: RefObject<HTMLSelectElement | null> };

const WHEN_OR_AIM = [AIMS_FOR, ...WHEN_WORDS] as const;
const WHEN_OR_AIMED = [AIMED_BY, ...WHEN_WORDS] as const;
type WhenOrAim = typeof AIMS_FOR | typeof AIMED_BY | (typeof WHEN_WORDS)[number];

function WordSelect<T extends string>({
  value,
  words,
  label,
  onChange,
  selectRef,
}: {
  value: T;
  words: readonly T[];
  label: string;
  onChange: (value: T) => void;
  selectRef: RefObject<HTMLSelectElement | null>;
}) {
  return (
    <select ref={selectRef} aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)} className={SELECT}>
      {words.map((word) => (
        <option key={word} value={word}>
          {word}
        </option>
      ))}
    </select>
  );
}

/** `[this task … ▾] [the other task ▾] [… ▾] ×`: a link being edited, or the new one. */
function LineControls({
  line,
  label,
  onLine,
  task,
  removeLabel,
  onRemove,
  refs,
  removeMarker = false,
  onAim,
  aimWords = WHEN_OR_AIM,
}: {
  line: LinkLine;
  /** names the line's controls: "Link with #3 Design" */
  label: string;
  onLine: (line: LinkLine) => void;
  task: ReactNode;
  removeLabel: string;
  onRemove: () => void;
  refs: LineRefs;
  /** marks × for moving focus after a removal */
  removeMarker?: boolean;
  /** offers "aims for" in the first dropdown, and what choosing it does */
  onAim?: (() => void) | undefined;
  aimWords?: readonly WhenOrAim[];
}) {
  return (
    <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
      <WordSelect<WhenOrAim> value={line.when} words={onAim ? aimWords : WHEN_WORDS} label={`${label}: this task`} selectRef={refs.when} onChange={(when) => when === AIMS_FOR || when === AIMED_BY ? onAim?.() : onLine({ ...line, when })} />
      {task}
      <WordSelect value={line.end} words={END_WORDS} label={`${label}: the other task`} selectRef={refs.end} onChange={(end) => onLine({ ...line, end })} />
      <IconButton {...(removeMarker ? { "data-remove-link": true } : {})} label={removeLabel} onClick={onRemove} className="shrink-0">
        <X size={14} />
      </IconButton>
    </li>
  );
}

/**
 * A task's links, one line each, read from this task: "starts after #3 Design finished". Editors
 * change a line's words (turning the link around and/or changing its kind) or its task, remove it,
 * and add a link with a new line; refusals show as any refused edit does. Viewers read the lines.
 */
export function LinksSection({
  task,
  state,
  numbers,
  canEdit,
  run,
  calendar,
  schedule = null,
}: {
  task: TaskRow;
  state: ProjectState;
  numbers: ReadonlyMap<RowId, number>;
  canEdit: boolean;
  run: (command: Command) => unknown;
  /** checks a change of task (a remove and an add) before sending either */
  calendar: Calendar;
  /** dates shown next to the tasks offered */
  schedule?: Schedule | null;
}) {
  const select = useSelection((selection) => selection.select);
  const [draft, setDraft] = useState<{ line: LinkLine; open: boolean; aim?: boolean } | null>(null);
  // A milestone just created from here: its date is ready to correct.
  const [correcting, setCorrecting] = useState<RowId | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // After ×, the line that took the removed one's place (or Add link, when none is left) gets focus.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ index: number; before: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const aimWhen = useRef<HTMLSelectElement>(null);
  const draftRefs: LineRefs = { when: useRef<HTMLSelectElement>(null), end: useRef<HTMLSelectElement>(null) };

  const numberOf = (id: RowId) => numbers.get(id) ?? 0;
  // A milestone has nothing to aim with.
  const canAim = task.duration !== 0 || isParentTask(buildTree(state), task);
  const aimProps = { task, state, calendar, schedule, numbers, run };
  const aiming = canAim && effectiveTarget(state, task) !== null;
  // From a milestone's side: the tasks that chose it, not subtasks that only inherit.
  const isTarget = isValidTarget(state, task.id);
  const aimers = isTarget
    ? Object.values(state.rows)
        .filter((row): row is TaskRow => row.kind === "task" && row.targetId === task.id)
        .sort((a, b) => numberOf(a.id) - numberOf(b.id))
    : [];
  const canAimHere = (row: Row) => row.kind === "task" && row.id !== task.id && row.targetId !== task.id && !isValidTarget(state, row.id);
  const aimWords = isTarget ? WHEN_OR_AIMED : WHEN_OR_AIM;
  const otherOf = (link: Link) => (link.followerId === task.id ? link.predecessorId : link.followerId);
  const links = [...linksInto(state, task.id), ...linksOutOf(state, task.id)]
    .map((link) => ({ link, key: linkKey(link) }))
    .sort((a, b) => numberOf(otherOf(a.link)) - numberOf(otherOf(b.link)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ link }) => link);
  const nameOf = (id: RowId) => `#${numberOf(id)} ${state.rows[id]?.title || "Untitled"}`;
  const between = (otherId: RowId, thisWaits: boolean) => (thisWaits ? { predecessorId: otherId, followerId: task.id } : { predecessorId: task.id, followerId: otherId });
  // Never itself, a section, its own parents or subtasks, or a task already linked this way.
  const excludeFor =
    ({ kind, thisWaits }: LinkShape) =>
    (row: Row) =>
      row.kind !== "task" ||
      row.id === task.id ||
      isAncestor(state, row.id, task.id) ||
      isAncestor(state, task.id, row.id) ||
      state.links[linkKey({ ...between(row.id, thisWaits), kind })] !== undefined;

  useEffect(() => {
    // Once the removed line is gone.
    if (focusAfterRemove === null || links.length >= focusAfterRemove.before || !container.current) return;
    setFocusAfterRemove(null);
    const removes = container.current.querySelectorAll<HTMLElement>("[data-remove-link]");
    (removes[focusAfterRemove.index] ?? addButton.current)?.focus();
  }, [focusAfterRemove, links.length]);

  /** A line's new words: the same link turned around and/or of another kind. */
  const changeLine = (link: Link, line: LinkLine, control: Control) => {
    const { kind, thisWaits } = linkOf(line);
    const reverse = thisWaits !== (link.followerId === task.id);
    if (kind === link.kind && !reverse) return;
    const ref = { predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind };
    const command: Command = { type: "updateLink", ...ref, ...(kind !== link.kind ? { newKind: kind } : {}), ...(reverse ? { reverse: true } : {}) };
    const now = reverse ? { predecessorId: link.followerId, followerId: link.predecessorId, kind } : { ...ref, kind };
    if (run(command) !== null) setFocus({ key: linkKey(now), control });
  };

  /**
   * Another task on a line: this link removed (its follower left to its own date and other links)
   * and the new one added, both or neither.
   */
  const changeTask = (link: Link, otherId: RowId) => {
    const remove: Command = { type: "removeLink", predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind, keepPlace: false };
    // The delay carries over (an overlap only where the kind allows one).
    const lag = link.kind === "FS" ? link.lag : Math.max(0, link.lag);
    const add = { type: "addLink" as const, ...between(otherId, link.followerId === task.id), kind: link.kind, ...(lag !== 0 ? { lag } : {}) };
    const removed = applyCommand(state, calendar, remove);
    const checked = removed.ok ? applyCommand(removed.state, calendar, add) : removed;
    if (!checked.ok) {
      toast(checked.message, { tone: "error" });
      return;
    }
    if (run(remove) !== null && run(add) !== null) setFocus({ key: linkKey(add), control: "task" });
  };

  /** An aim turned into a link with its milestone, both or neither. */
  const aimToLink = (when: LinkLine["when"]) => {
    if (task.targetId === null) return;
    const line = { when, end: "finished" as const };
    const { kind, thisWaits } = linkOf(line);
    const stop: Command = { type: "setTarget", id: task.id, targetId: null };
    const add = { type: "addLink" as const, ...between(task.targetId, thisWaits), kind };
    const stopped = applyCommand(state, calendar, stop);
    const checked = stopped.ok ? applyCommand(stopped.state, calendar, add) : stopped;
    if (!checked.ok) {
      toast(checked.message, { tone: "error" });
      return;
    }
    if (run(stop) !== null && run(add) !== null) setFocus({ key: linkKey(add), control: "when" });
  };

  /** From the milestone: a task's aim here turned into a link with it, both or neither. */
  const aimedToLink = (aimer: TaskRow, when: LinkLine["when"]) => {
    const { kind, thisWaits } = linkOf({ when, end: "finished" });
    const stop: Command = { type: "setTarget", id: aimer.id, targetId: null };
    const add = { type: "addLink" as const, ...between(aimer.id, thisWaits), kind };
    const stopped = applyCommand(state, calendar, stop);
    const checked = stopped.ok ? applyCommand(stopped.state, calendar, add) : stopped;
    if (!checked.ok) {
      toast(checked.message, { tone: "error" });
      return;
    }
    if (run(stop) !== null && run(add) !== null) setFocus({ key: linkKey(add), control: "when" });
  };

  /** From the milestone: the aim here moved to another task. */
  const changeAimer = (aimer: TaskRow, otherId: RowId) => {
    // The new aim first: if it's refused, the old one is still there.
    if (run({ type: "setTarget", id: otherId, targetId: task.id }) !== null) run({ type: "setTarget", id: aimer.id, targetId: null });
  };

  /** A link between a task and a milestone turned into an aim, both or neither. */
  const linkToAim = (link: Link) => {
    // Aiming moves nothing: whatever the link was holding stays where it's shown.
    const remove: Command = { type: "removeLink", predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind };
    const aim: Command = isTarget ? { type: "setTarget", id: otherOf(link), targetId: task.id } : { type: "setTarget", id: task.id, targetId: otherOf(link) };
    const removed = applyCommand(state, calendar, remove);
    const checked = removed.ok ? applyCommand(removed.state, calendar, aim) : removed;
    if (!checked.ok) {
      toast(checked.message, { tone: "error" });
      return;
    }
    if (run(remove) !== null) run(aim);
  };

  const pickForDraft = (line: LinkLine, otherId: RowId) => {
    const { kind, thisWaits } = linkOf(line);
    const add = { type: "addLink" as const, ...between(otherId, thisWaits), kind };
    if (run(add) === null) return; // the draft stays
    setDraft(null);
    setFocus({ key: linkKey(add), control: "task" });
  };

  const aimLine = aiming ? (
    <AimLine
      {...aimProps}
      canEdit={canEdit}
      correcting={correcting}
      onCorrected={() => setCorrecting(null)}
      onCreated={setCorrecting}
      onGo={select}
      whenSelect={
        <WordSelect<WhenOrAim>
          value={AIMS_FOR}
          words={WHEN_OR_AIM}
          label={`Aims for ${nameOf(effectiveTarget(state, task)!)}: this task`}
          selectRef={aimWhen}
          onChange={(when) => when !== AIMS_FOR && when !== AIMED_BY && aimToLink(when)}
        />
      }
    />
  ) : null;

  if (!canEdit) {
    if (links.length === 0 && !aiming && aimers.length === 0) return <p className="text-sm text-muted">None</p>;
    return (
      <ul aria-label="Links" className="flex flex-col gap-1 text-sm">
        {aimLine}
        {aimers.map((aimer) => {
          const result = standing({ task: aimer, calendar, schedule }, task.id);
          return (
            <li key={aimer.id} className="flex flex-col gap-0.5">
              <span>
                {AIMED_BY}{" "}
                <button type="button" onClick={() => select(aimer.id)} className="rounded px-0.5 font-medium hover:bg-surface-2">
                  {nameOf(aimer.id)}
                </button>
              </span>
              {result ? <span className={`text-xs ${result.late ? "text-danger" : "text-muted"}`}>{result.text}</span> : null}
            </li>
          );
        })}
        {links.map((link) => {
          const otherId = otherOf(link);
          const { when, end } = lineOf({ kind: link.kind, thisWaits: link.followerId === task.id });
          return (
            <li key={linkKey(link)}>
              {when}{" "}
              <button type="button" onClick={() => select(otherId)} className="rounded px-0.5 font-medium hover:bg-surface-2">
                {nameOf(otherId)}
              </button>{" "}
              {end}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div ref={container} className="flex flex-col gap-2">
      {links.length === 0 && !draft && !aiming && aimers.length === 0 ? <p className="text-sm text-muted">None</p> : null}
      {links.length > 0 || draft || aiming || aimers.length > 0 ? (
        <ul aria-label="Links" className="flex flex-col gap-1">
          {aimLine}
          {aimers.map((aimer) => (
            <AimedByLine
              key={aimer.id}
              aimer={aimer}
              name={nameOf(aimer.id)}
              result={standing({ task: aimer, calendar, schedule }, task.id)}
              state={state}
              schedule={schedule}
              numbers={numbers}
              exclude={(row) => !canAimHere(row)}
              onWhen={(when) => aimedToLink(aimer, when)}
              onTask={(otherId) => changeAimer(aimer, otherId)}
              onGo={() => select(aimer.id)}
              onRemove={() => run({ type: "setTarget", id: aimer.id, targetId: null })}
            />
          ))}
          {links.map((link, index) => (
            <LinkLineEditor
              key={linkKey(link)}
              link={link}
              taskId={task.id}
              name={nameOf(otherOf(link))}
              state={state}
              schedule={schedule}
              numbers={numbers}
              exclude={excludeFor}
              focus={focus?.key === linkKey(link) ? focus.control : null}
              onFocused={() => setFocus(null)}
              onLine={(line, control) => changeLine(link, line, control)}
              onAim={(canAim && isValidTarget(state, otherOf(link))) || (isTarget && !isValidTarget(state, otherOf(link))) ? () => linkToAim(link) : undefined}
              aimWords={aimWords}
              onTask={(otherId) => changeTask(link, otherId)}
              onGo={() => select(otherOf(link))}
              onRemove={() => {
                if (run({ type: "removeLink", predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind }) !== null) {
                  setFocusAfterRemove({ index, before: links.length });
                }
              }}
            />
          ))}
          {draft?.aim && isTarget ? (
            <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
              <WordSelect<WhenOrAim>
                value={AIMED_BY}
                words={WHEN_OR_AIMED}
                label="New link: this task"
                selectRef={draftRefs.when}
                onChange={(when) => when !== AIMED_BY && when !== AIMS_FOR && setDraft({ line: { ...draft.line, when }, open: false })}
              />
              <TaskPicker
                exclude={(row) => !canAimHere(row)}
                onPick={(otherId) => {
                  if (run({ type: "setTarget", id: otherId, targetId: task.id }) !== null) setDraft(null);
                }}
                state={state}
                schedule={schedule}
                numbers={numbers}
                searchLabel="Find a task to aim here"
                open={draft.open}
                onOpenChange={(open) => setDraft((current) => current && { ...current, open })}
                trigger={
                  <button type="button" aria-label="New link: choose a task" className={`${TASK_BUTTON} text-muted`}>
                    <span className="truncate">choose a task…</span>
                    <ChevronDown aria-hidden size={13} className="ml-auto shrink-0" />
                  </button>
                }
              />
              <IconButton label="Discard the new link" onClick={() => { setDraft(null); addButton.current?.focus(); }} className="shrink-0">
                <X size={14} />
              </IconButton>
            </li>
          ) : draft?.aim ? (
            <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
              <WordSelect<WhenOrAim>
                value={AIMS_FOR}
                words={WHEN_OR_AIM}
                label="New link: this task"
                selectRef={draftRefs.when}
                onChange={(when) => when !== AIMS_FOR && when !== AIMED_BY && setDraft({ line: { ...draft.line, when }, open: false })}
              />
              <AimPicker
                {...aimProps}
                onDone={() => setDraft(null)}
                onCreated={setCorrecting}
              />
              <IconButton label="Discard the new link" onClick={() => { setDraft(null); addButton.current?.focus(); }} className="shrink-0">
                <X size={14} />
              </IconButton>
            </li>
          ) : draft ? (
            <LineControls
              onAim={canAim ? () => setDraft({ ...draft, aim: true, open: false }) : isTarget ? () => setDraft({ ...draft, aim: true, open: true }) : undefined}
              aimWords={aimWords}
              line={draft.line}
              label="New link"
              refs={draftRefs}
              onLine={(line) => setDraft({ ...draft, line })}
              removeLabel="Discard the new link"
              onRemove={() => {
                setDraft(null);
                addButton.current?.focus();
              }}
              task={
                <TaskPicker
                  exclude={excludeFor(linkOf(draft.line))}
                  onPick={(otherId) => pickForDraft(draft.line, otherId)}
                  state={state}
                  schedule={schedule}
                  numbers={numbers}
                  searchLabel="Find a task to link"
                  open={draft.open}
                  onOpenChange={(open) => setDraft((current) => current && { ...current, open })}
                  trigger={
                    <button type="button" aria-label="New link: choose a task" className={`${TASK_BUTTON} text-muted`}>
                      <span className="truncate">choose a task…</span>
                      <ChevronDown aria-hidden size={13} className="ml-auto shrink-0" />
                    </button>
                  }
                />
              }
            />
          ) : null}
        </ul>
      ) : null}
      <button
        ref={addButton}
        type="button"
        data-add-link
        onClick={() => setDraft((current) => (current ? { ...current, open: true } : { line: { when: "starts after", end: "finished" }, open: true }))}
        className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
      >
        <Plus aria-hidden size={13} /> Add link
      </button>
    </div>
  );
}

/** One link's line; `focus` puts focus on one of its controls (a changed link is a new line). */
function LinkLineEditor({
  link,
  taskId,
  name,
  state,
  schedule,
  numbers,
  exclude,
  focus,
  onFocused,
  onLine,
  onTask,
  onGo,
  onRemove,
  onAim,
  aimWords,
}: {
  link: Link;
  taskId: RowId;
  /** the other task: "#3 Design" */
  name: string;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  exclude: (shape: LinkShape) => (row: Row) => boolean;
  focus: Control | null;
  onFocused: () => void;
  onLine: (line: LinkLine, control: Control) => void;
  onTask: (otherId: RowId) => void;
  onGo: () => void;
  onRemove: () => void;
  onAim?: (() => void) | undefined;
  aimWords: readonly WhenOrAim[];
}) {
  const [open, setOpen] = useState(false);
  const refs: LineRefs = { when: useRef<HTMLSelectElement>(null), end: useRef<HTMLSelectElement>(null) };
  const taskButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    (focus === "task" ? taskButton : refs[focus]).current?.focus();
    onFocused();
  }, [focus]);
  const shape = { kind: link.kind, thisWaits: link.followerId === taskId };
  const line = lineOf(shape);
  const label = `Link with ${name}`;
  return (
    <LineControls
      line={line}
      label={label}
      refs={refs}
      removeMarker
      onLine={(next) => onLine(next, next.when !== line.when ? "when" : "end")}
      removeLabel={`Remove link with ${name}`}
      onRemove={onRemove}
      onAim={onAim}
      aimWords={aimWords}
      task={
        <TaskPicker
          exclude={exclude(shape)}
          onPick={onTask}
          state={state}
          schedule={schedule}
          numbers={numbers}
          searchLabel="Find a task to link"
          open={open}
          onOpenChange={setOpen}
          footer={
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onGo();
              }}
              className="text-xs text-muted hover:text-text"
            >
              Go to {name}
            </button>
          }
          trigger={
            <button ref={taskButton} type="button" aria-label={`${label}: change the task`} title={name} className={TASK_BUTTON}>
              <span className="truncate">{name}</span>
              <ChevronDown aria-hidden size={13} className="ml-auto shrink-0 text-muted" />
            </button>
          }
        />
      }
    />
  );
}

/** From a milestone's side: `[aimed by ▾] [#8 QA ▾] ×`, with how that task stands under it. */
function AimedByLine({
  aimer,
  name,
  result,
  state,
  schedule,
  numbers,
  exclude,
  onWhen,
  onTask,
  onGo,
  onRemove,
}: {
  aimer: TaskRow;
  name: string;
  result: { text: string; late: boolean } | null;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  exclude: (row: Row) => boolean;
  onWhen: (when: LinkLine["when"]) => void;
  onTask: (otherId: RowId) => void;
  onGo: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const when = useRef<HTMLSelectElement>(null);
  return (
    <li data-link-line className="flex min-w-0 flex-col gap-1 text-sm">
      <div className="flex min-w-0 items-center gap-1">
        <WordSelect<WhenOrAim>
          value={AIMED_BY}
          words={WHEN_OR_AIMED}
          label={`Aimed by ${name}: this task`}
          selectRef={when}
          onChange={(word) => word !== AIMED_BY && word !== AIMS_FOR && onWhen(word)}
        />
        <TaskPicker
          exclude={exclude}
          onPick={onTask}
          state={state}
          schedule={schedule}
          numbers={numbers}
          searchLabel="Find a task to aim here"
          open={open}
          onOpenChange={setOpen}
          footer={
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onGo();
              }}
              className="text-xs text-muted hover:text-text"
            >
              Go to {name}
            </button>
          }
          trigger={
            <button type="button" aria-label={`Aimed by ${name}: change the task`} title={name} className={TASK_BUTTON}>
              <span className="truncate">{name}</span>
              <ChevronDown aria-hidden size={13} className="ml-auto shrink-0 text-muted" />
            </button>
          }
        />
        <IconButton label={`Stop “${aimer.title || "Untitled"}” aiming here`} onClick={onRemove} className="shrink-0">
          <X size={14} />
        </IconButton>
      </div>
      {result ? <span className={`text-xs ${result.late ? "text-danger" : "text-muted"}`}>{result.text}</span> : null}
    </li>
  );
}
