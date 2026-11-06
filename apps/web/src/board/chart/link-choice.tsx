import { applyCommand, isParentTask, buildTree, isValidTarget, type Calendar, type Command, type LinkKind, type ProjectState, type RowId, type TaskRow } from "@ganttlines/engine";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { useChartDrag } from "./drag";

/** A link dragged from one task onto another: where it was dropped, and the direction it went. */
export interface LinkChoice {
  x: number;
  y: number;
  fromId: RowId;
  toId: RowId;
}

export interface LinkOption {
  label: string;
  note?: string;
  command: Command;
  /** what the board would say to it */
  refused?: string;
}

const LINK_WORDS: readonly { kind: LinkKind; sentence: (follower: string, predecessor: string) => string }[] = [
  { kind: "FS", sentence: (follower, predecessor) => `${follower} starts after ${predecessor} finishes` },
  { kind: "SS", sentence: (follower, predecessor) => `${follower} starts when ${predecessor} starts` },
  { kind: "FF", sentence: (follower, predecessor) => `${follower} finishes when ${predecessor} finishes` },
  { kind: "SF", sentence: (follower, predecessor) => `${follower} finishes when ${predecessor} starts` },
];

/** What dropping `fromId` on `toId` could mean, read from the task dragged; the first is what Enter takes. */
export function optionsFor(state: ProjectState, calendar: Calendar, fromId: RowId, toId: RowId): LinkOption[] {
  const [from, to] = [state.rows[fromId], state.rows[toId]];
  if (from?.kind !== "task" || to?.kind !== "task") return [];
  const [fromName, toName] = [from.title || "Untitled", to.title || "Untitled"];
  const options: LinkOption[] = [];
  const [fromMilestone, toMilestone] = [isValidTarget(state, fromId), isValidTarget(state, toId)];
  if (fromMilestone !== toMilestone) {
    const [task, milestone] = (fromMilestone ? [to, from] : [from, to]) as [TaskRow, TaskRow];
    const elsewhere = task.targetId !== null && task.targetId !== milestone.id ? state.rows[task.targetId]?.title : undefined;
    options.push({
      label: `${task.title || "Untitled"} aims for ${milestone.title || "Untitled"}`,
      note: elsewhere === undefined ? "Never moves the milestone" : `Instead of ${elsewhere || "Untitled"}`,
      command: { type: "setTarget", id: task.id, targetId: milestone.id },
    });
  }
  for (const { kind, sentence } of LINK_WORDS) {
    options.push({
      label: sentence(fromName, toName),
      ...(kind === "FS" && fromMilestone && !toMilestone ? { note: `The milestone moves if ${toName} is late` } : {}),
      command: { type: "addLink", predecessorId: toId, followerId: fromId, kind },
    });
  }
  const tree = buildTree(state);
  const hasWork = (task: TaskRow) => task.duration !== 0 && !isParentTask(tree, task);
  if (hasWork(from) && hasWork(to)) {
    options.push({ label: `${fromName} interrupts ${toName}`, note: `${toName} stops while ${fromName} runs`, command: { type: "addInterruption", id: toId, byId: fromId } });
  }
  return options.map((option) => {
    const result = applyCommand(state, calendar, option.command);
    return result.ok ? option : { ...option, refused: result.message };
  });
}

const ITEM = "cursor-pointer rounded px-2 py-1.5 outline-none hover:bg-surface-2 data-[highlighted]:bg-surface-2 data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[disabled]:hover:bg-transparent";
const NOTE = "block text-xs text-muted";

/** Which relation to make. It stays where it opened; pointing at an option shows it on the board. */
export function LinkChoiceMenu({ choice, state, calendar, run, onClose }: { choice: LinkChoice; state: ProjectState; calendar: Calendar; run: (command: Command) => unknown; onClose: () => void }) {
  // The board as it was when dropped: what the menu is showing moves bars underneath it.
  const board = useRef(state);
  const [swapped, setSwapped] = useState(false);
  const [fromId, toId] = swapped ? [choice.toId, choice.fromId] : [choice.fromId, choice.toId];
  const [options] = useState(() => new Map<boolean, LinkOption[]>());
  const shown = options.get(swapped) ?? optionsFor(board.current, calendar, fromId, toId);
  options.set(swapped, shown);
  const first = useRef<HTMLDivElement>(null);
  /** Only once someone has moved: opening puts focus on the first option, ready for Enter, and changes nothing. */
  const moved = useRef(false);
  const preview = (command: Command | null) => useChartDrag.setState({ drag: command ? { rowId: fromId, command, line: null, targetId: null } : null });

  useEffect(() => {
    // After the menu has taken the focus for itself.
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [swapped]);
  useEffect(() => () => useChartDrag.setState({ drag: null }), []);

  const name = (id: RowId) => board.current.rows[id]?.title || "Untitled";
  const firstEnabled = shown.findIndex((option) => !option.refused);
  return (
    <DropdownMenu.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenu.Trigger asChild>
        <span aria-label={`Link ${name(choice.fromId)} and ${name(choice.toId)}`} className="fixed h-0 w-0" style={{ left: choice.x, top: choice.y }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          onPointerMoveCapture={() => (moved.current = true)}
          onKeyDownCapture={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") moved.current = true;
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="z-50 w-80 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 pb-1.5 text-xs text-muted">
            <span className="min-w-0 truncate">
              <b className="text-text">{name(fromId)}</b> → <b className="text-text">{name(toId)}</b>
            </span>
            <DropdownMenu.Item
              className="shrink-0 cursor-pointer rounded border border-border-strong px-1.5 py-0.5 text-xs text-text outline-none data-[highlighted]:bg-surface-2"
              onFocus={() => preview(null)}
              onSelect={(event) => {
                event.preventDefault();
                moved.current = false;
                preview(null);
                setSwapped((current) => !current);
              }}
            >
              ⇄ Swap
            </DropdownMenu.Item>
          </div>
          {shown.map((option, index) => (
            <DropdownMenu.Item
              key={option.label}
              ref={index === firstEnabled ? first : undefined}
              disabled={option.refused !== undefined}
              className={ITEM}
              onFocus={() => moved.current && preview(option.command)}
              // Pointing at the option that already has focus: no focus event comes.
              onPointerMove={() => {
                if (useChartDrag.getState().drag?.command !== option.command) preview(option.command);
              }}
              onBlur={() => preview(null)}
              onSelect={() => {
                preview(null);
                run(option.command);
              }}
            >
              {option.label}
              {option.refused || option.note ? <span className={NOTE}>{option.refused ?? option.note}</span> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
