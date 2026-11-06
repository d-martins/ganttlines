import {
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
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { IconButton } from "../../ui/button";
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

const INTERRUPTED_BY = "interrupted by";
const INTERRUPTS = "interrupts";
const INTERRUPT_WORDS = [INTERRUPTED_BY, INTERRUPTS] as const;
type InterruptWord = (typeof INTERRUPT_WORDS)[number];
const isInterruptWord = (word: string): word is InterruptWord => word === INTERRUPTED_BY || word === INTERRUPTS;

const WHEN_OR_AIM = [AIMS_FOR, ...WHEN_WORDS] as const;
const WHEN_OR_AIMED = [AIMED_BY, ...WHEN_WORDS] as const;
type WhenOrAim = typeof AIMS_FOR | typeof AIMED_BY | InterruptWord | (typeof WHEN_WORDS)[number];

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
  onInterrupt,
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
  /** offers "interrupted by" and "interrupts" in the first dropdown, and what choosing one does */
  onInterrupt?: ((word: InterruptWord) => void) | undefined;
}) {
  const words: readonly WhenOrAim[] = [...(onAim ? aimWords : WHEN_WORDS), ...(onInterrupt ? INTERRUPT_WORDS : [])];
  return (
    <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
      <WordSelect<WhenOrAim>
        value={line.when}
        words={words}
        label={`${label}: this task`}
        selectRef={refs.when}
        onChange={(when) => (when === AIMS_FOR || when === AIMED_BY ? onAim?.() : isInterruptWord(when) ? onInterrupt?.(when) : onLine({ ...line, when }))}
      />
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
  /** for how an aiming task stands against its milestone */
  calendar: Calendar;
  /** dates shown next to the tasks offered */
  schedule?: Schedule | null;
}) {
  const select = useSelection((selection) => selection.select);
  const [draft, setDraft] = useState<{ line: LinkLine; open: boolean; aim?: boolean; interrupt?: InterruptWord } | null>(null);
  // A milestone just created from here: its date is ready to correct.
  const [correcting, setCorrecting] = useState<RowId | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  // An aim just picked from the new line: the keyboard stays with it.
  const [focusAim, setFocusAim] = useState(false);
  // After ×, the line that took the removed one's place (or Add link, when none is left) gets focus.
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ index: number; before: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const aimWhen = useRef<HTMLSelectElement>(null);
  const draftRefs: LineRefs = { when: useRef<HTMLSelectElement>(null), end: useRef<HTMLSelectElement>(null) };

  const numberOf = (id: RowId) => numbers.get(id) ?? 0;
  // A milestone has nothing to aim with.
  const tree = useMemo(() => buildTree(state), [state]);
  const canAim = task.duration !== 0 || isParentTask(tree, task);
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
  /** Aiming this task here would end its aim for something else. */
  const replacedAim = (row: TaskRow) => (row.targetId !== null && state.rows[row.targetId] ? `Instead of ${state.rows[row.targetId]!.title || "Untitled"}` : undefined);
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
    if (!focusAim) return;
    setFocusAim(false);
    // A milestone just made here: its date has the focus.
    if (correcting === null) aimWhen.current?.focus();
  }, [focusAim]);

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

  /** Another task on a line: this link removed (its follower left to its own date and other links) and the new one added. */
  const changeTask = (link: Link, otherId: RowId) => {
    const remove = { type: "removeLink" as const, predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind, keepPlace: false };
    // The delay carries over (an overlap only where the kind allows one).
    const lag = link.kind === "FS" ? link.lag : Math.max(0, link.lag);
    const add = { type: "addLink" as const, ...between(otherId, link.followerId === task.id), kind: link.kind, ...(lag !== 0 ? { lag } : {}) };
    if (run({ type: "relink", steps: [remove, add] }) !== null) setFocus({ key: linkKey(add), control: "task" });
  };

  /** A task's aim turned into a link with `otherId` (the milestone, or the task from the milestone's side). */
  const aimAsLink = (aimerId: RowId, otherId: RowId, when: LinkLine["when"]) => {
    const { kind, thisWaits } = linkOf({ when, end: "finished" });
    const add = { type: "addLink" as const, ...between(otherId, thisWaits), kind };
    if (run({ type: "relink", steps: [{ type: "setTarget", id: aimerId, targetId: null }, add] }) !== null) setFocus({ key: linkKey(add), control: "when" });
  };

  /** From the milestone: the aim here moved to another task. */
  const changeAimer = (aimer: TaskRow, otherId: RowId) => {
    run({
      type: "relink",
      steps: [
        { type: "setTarget", id: otherId, targetId: task.id },
        { type: "setTarget", id: aimer.id, targetId: null },
      ],
    });
  };

  /** A link between a task and a milestone turned into an aim. */
  const linkToAim = (link: Link) => {
    // Aiming moves nothing: whatever the link was holding stays where it's shown.
    const remove = { type: "removeLink" as const, predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind };
    const aim = isTarget ? { type: "setTarget" as const, id: otherOf(link), targetId: task.id } : { type: "setTarget" as const, id: task.id, targetId: otherOf(link) };
    run({ type: "relink", steps: [remove, aim] });
  };

  // Tasks with work of their own and no subtasks can interrupt or be interrupted.
  const hasWork = (row: Row | undefined): row is TaskRow => row?.kind === "task" && row.duration !== 0 && !isParentTask(tree, row);
  const canInterrupt = hasWork(task);
  const interruptedBy = canInterrupt ? [...(task.interruptedBy ?? [])].filter((id) => state.rows[id]).sort((a, b) => numberOf(a) - numberOf(b)) : [];
  const interrupting = canInterrupt
    ? Object.values(state.rows)
        .filter((row): row is TaskRow => row.kind === "task" && (row.interruptedBy ?? []).includes(task.id))
        .sort((a, b) => numberOf(a.id) - numberOf(b.id))
    : [];
  const canPairWith = (row: Row) => hasWork(row) && row.id !== task.id && !isAncestor(state, row.id, task.id) && !isAncestor(state, task.id, row.id);
  const interruption = (word: InterruptWord, otherId: RowId) => (word === INTERRUPTED_BY ? { id: task.id, byId: otherId } : { id: otherId, byId: task.id });
  const taken = (word: InterruptWord, row: Row) => (word === INTERRUPTED_BY ? interruptedBy.includes(row.id) : interrupting.some((other) => other.id === row.id));
  const stopInterrupt = (word: InterruptWord, otherId: RowId) => ({ type: "removeInterruption" as const, ...interruption(word, otherId) });

  /** An interruption turned into a link with the same task, or flipped. */
  const interruptToWord = (word: InterruptWord, otherId: RowId, next: WhenOrAim) => {
    if (isInterruptWord(next)) {
      run({ type: "relink", steps: [stopInterrupt(word, otherId), { type: "addInterruption", ...interruption(next, otherId) }] });
      return;
    }
    if (next === AIMS_FOR || next === AIMED_BY) return;
    const { kind, thisWaits } = linkOf({ when: next, end: "finished" });
    const add = { type: "addLink" as const, ...between(otherId, thisWaits), kind };
    if (run({ type: "relink", steps: [stopInterrupt(word, otherId), add] }) !== null) setFocus({ key: linkKey(add), control: "when" });
  };

  /** A link turned into an interruption between the same two tasks. */
  const linkToInterrupt = (link: Link, word: InterruptWord) => {
    const remove = { type: "removeLink" as const, predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind, keepPlace: false };
    run({ type: "relink", steps: [remove, { type: "addInterruption", ...interruption(word, otherOf(link)) }] });
  };

  const interruptLines = (lineWord: InterruptWord, others: readonly RowId[]) =>
    others.map((otherId) => (
      <InterruptLine
        key={`${lineWord}-${otherId}`}
        word={lineWord}
        name={nameOf(otherId)}
        title={state.rows[otherId]?.title || "Untitled"}
        state={state}
        schedule={schedule}
        numbers={numbers}
        exclude={(row) => !canPairWith(row) || taken(lineWord, row)}
        onWord={(word) => interruptToWord(lineWord, otherId, word)}
        onTask={(next) => run({ type: "relink", steps: [stopInterrupt(lineWord, otherId), { type: "addInterruption", ...interruption(lineWord, next) }] })}
        onGo={() => select(otherId)}
        onRemove={() => run(stopInterrupt(lineWord, otherId))}
      />
    ));

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
      onStopped={() => addButton.current?.focus()}
      whenSelect={
        <WordSelect<WhenOrAim>
          value={AIMS_FOR}
          words={WHEN_OR_AIM}
          label={`Aims for ${nameOf(effectiveTarget(state, task)!)}: this task`}
          selectRef={aimWhen}
          onChange={(when) => when !== AIMS_FOR && when !== AIMED_BY && !isInterruptWord(when) && task.targetId !== null && aimAsLink(task.id, task.targetId, when)}
        />
      }
    />
  ) : null;

  if (!canEdit) {
    if (links.length === 0 && !aiming && aimers.length === 0 && interruptedBy.length === 0 && interrupting.length === 0) return <p className="text-sm text-muted">None</p>;
    const readLine = (word: InterruptWord, otherId: RowId) => (
      <li key={`${word}-${otherId}`}>
        {word}{" "}
        <button type="button" onClick={() => select(otherId)} className="rounded px-0.5 font-medium hover:bg-surface-2">
          {nameOf(otherId)}
        </button>
      </li>
    );
    return (
      <ul aria-label="Links" className="flex flex-col gap-1 text-sm">
        {aimLine}
        {aimers.map((aimer) => {
          const result = standing({ task: aimer, state, calendar, schedule }, task.id);
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
        {interruptedBy.map((id) => readLine(INTERRUPTED_BY, id))}
        {interrupting.map((row) => readLine(INTERRUPTS, row.id))}
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
      {links.length === 0 && !draft && !aiming && aimers.length === 0 && interruptedBy.length === 0 && interrupting.length === 0 ? <p className="text-sm text-muted">None</p> : null}
      {links.length > 0 || draft || aiming || aimers.length > 0 || interruptedBy.length > 0 || interrupting.length > 0 ? (
        <ul aria-label="Links" className="flex flex-col gap-1">
          {aimLine}
          {aimers.map((aimer) => (
            <AimedByLine
              key={aimer.id}
              aimer={aimer}
              name={nameOf(aimer.id)}
              result={standing({ task: aimer, state, calendar, schedule }, task.id)}
              state={state}
              schedule={schedule}
              numbers={numbers}
              exclude={(row) => !canAimHere(row)}
              noteOf={replacedAim}
              onWhen={(when) => aimAsLink(aimer.id, aimer.id, when)}
              onTask={(otherId) => changeAimer(aimer, otherId)}
              onGo={() => select(aimer.id)}
              onRemove={() => run({ type: "setTarget", id: aimer.id, targetId: null })}
            />
          ))}
          {interruptLines(INTERRUPTED_BY, interruptedBy)}
          {interruptLines(INTERRUPTS, interrupting.map((row) => row.id))}
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
              onInterrupt={canInterrupt && hasWork(state.rows[otherOf(link)]) ? (word) => linkToInterrupt(link, word) : undefined}
              onTask={(otherId) => changeTask(link, otherId)}
              onGo={() => select(otherOf(link))}
              onRemove={() => {
                if (run({ type: "removeLink", predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind }) !== null) {
                  setFocusAfterRemove({ index, before: links.length });
                }
              }}
            />
          ))}
          {draft?.interrupt ? (
            <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
              <WordSelect<WhenOrAim>
                value={draft.interrupt}
                words={[...WHEN_WORDS, ...INTERRUPT_WORDS]}
                label="New link: this task"
                selectRef={draftRefs.when}
                onChange={(when) => {
                  if (isInterruptWord(when)) setDraft({ ...draft, interrupt: when, open: false });
                  else if (when !== AIMS_FOR && when !== AIMED_BY) setDraft({ line: { ...draft.line, when }, open: false });
                }}
              />
              <TaskPicker
                exclude={(row) => !canPairWith(row) || taken(draft.interrupt!, row)}
                onPick={(otherId) => {
                  if (run({ type: "addInterruption", ...interruption(draft.interrupt!, otherId) }) !== null) setDraft(null);
                }}
                state={state}
                schedule={schedule}
                numbers={numbers}
                searchLabel="Find a task to interrupt with"
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
          ) : draft?.aim && isTarget ? (
            <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
              <WordSelect<WhenOrAim>
                value={AIMED_BY}
                words={WHEN_OR_AIMED}
                label="New link: this task"
                selectRef={draftRefs.when}
                onChange={(when) => when !== AIMED_BY && when !== AIMS_FOR && !isInterruptWord(when) && setDraft({ line: { ...draft.line, when }, open: false })}
              />
              <TaskPicker
                exclude={(row) => !canAimHere(row)}
                noteOf={replacedAim}
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
                onChange={(when) => when !== AIMS_FOR && when !== AIMED_BY && !isInterruptWord(when) && setDraft({ line: { ...draft.line, when }, open: false })}
              />
              <AimPicker
                {...aimProps}
                onDone={() => {
                  setDraft(null);
                  setFocusAim(true);
                }}
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
              onInterrupt={canInterrupt ? (word) => setDraft({ ...draft, interrupt: word, open: true }) : undefined}
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
  onInterrupt,
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
  onInterrupt?: ((word: InterruptWord) => void) | undefined;
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
      onInterrupt={onInterrupt}
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

/** `[interrupted by ▾] [#4 Hotfix ▾] ×`, or `[interrupts ▾]`, from either of the two tasks. */
function InterruptLine({
  word,
  name,
  title,
  state,
  schedule,
  numbers,
  exclude,
  onWord,
  onTask,
  onGo,
  onRemove,
}: {
  word: InterruptWord;
  name: string;
  title: string;
  state: ProjectState;
  schedule: Schedule | null;
  numbers: ReadonlyMap<RowId, number>;
  exclude: (row: Row) => boolean;
  onWord: (word: WhenOrAim) => void;
  onTask: (otherId: RowId) => void;
  onGo: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const when = useRef<HTMLSelectElement>(null);
  const label = word === INTERRUPTED_BY ? `Interrupted by ${name}` : `Interrupts ${name}`;
  return (
    <li data-link-line className="flex min-w-0 items-center gap-1 text-sm">
      <WordSelect<WhenOrAim> value={word} words={[...WHEN_WORDS, ...INTERRUPT_WORDS]} label={`${label}: this task`} selectRef={when} onChange={(next) => next !== word && onWord(next)} />
      <TaskPicker
        exclude={exclude}
        onPick={onTask}
        state={state}
        schedule={schedule}
        numbers={numbers}
        searchLabel="Find a task to interrupt with"
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
          <button type="button" aria-label={`${label}: change the task`} title={name} className={TASK_BUTTON}>
            <span className="truncate">{name}</span>
            <ChevronDown aria-hidden size={13} className="ml-auto shrink-0 text-muted" />
          </button>
        }
      />
      <IconButton label={`Stop “${title}” interrupting`} onClick={onRemove} className="shrink-0">
        <X size={14} />
      </IconButton>
    </li>
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
  noteOf,
  onWhen,
  onTask,
  onGo,
  onRemove,
}: {
  noteOf: (row: TaskRow) => string | undefined;
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
          onChange={(word) => word !== AIMED_BY && word !== AIMS_FOR && !isInterruptWord(word) && onWhen(word)}
        />
        <TaskPicker
          exclude={exclude}
          noteOf={noteOf}
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
