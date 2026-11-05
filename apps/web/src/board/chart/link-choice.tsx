import { isValidTarget, type Command, type ProjectState, type RowId, type TaskRow } from "@ganttlines/engine";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef } from "react";
import { lineOf } from "../link-phrases";

/** A link dragged between a task and a milestone: it could mean either, so the drop asks. */
export interface LinkChoice {
  x: number;
  y: number;
  task: TaskRow;
  milestone: TaskRow;
  /** the link as it was dragged */
  link: Extract<Command, { type: "addLink" }>;
}

/** The task and the milestone a dragged link joins, when it joins one of each; else null. */
export function linkChoiceFor(state: ProjectState, link: Extract<Command, { type: "addLink" }>): Pick<LinkChoice, "task" | "milestone" | "link"> | null {
  const [from, to] = [state.rows[link.predecessorId], state.rows[link.followerId]];
  if (from?.kind !== "task" || to?.kind !== "task") return null;
  const fromIsMilestone = isValidTarget(state, from.id);
  if (fromIsMilestone === isValidTarget(state, to.id)) return null;
  return { task: fromIsMilestone ? to : from, milestone: fromIsMilestone ? from : to, link };
}

/** What the link does, in the words the panel uses for anything but the usual kind. */
function linkNote(link: LinkChoice["link"], taskName: string, milestoneName: string, fromTask: boolean): string {
  if (link.kind === "FS") return fromTask ? `The milestone moves if ${taskName} is late` : `${taskName} starts after the milestone`;
  const { when, end } = lineOf({ kind: link.kind, thisWaits: true });
  return fromTask ? `${milestoneName} ${when} ${taskName} ${end}` : `${taskName} ${when} ${milestoneName} ${end}`;
}

const ITEM = "cursor-pointer rounded px-2 py-1.5 outline-none hover:bg-surface-2 data-[highlighted]:bg-surface-2";
const NOTE = "block text-xs text-muted";

/** Aim for the milestone, which moves nothing and comes first, or make the link that was dragged. */
export function LinkChoiceMenu({ choice, state, run, onClose }: { choice: LinkChoice; state: ProjectState; run: (command: Command) => unknown; onClose: () => void }) {
  const first = useRef<HTMLDivElement>(null);
  // Aiming is ready for Enter.
  useEffect(() => {
    // After the menu has taken the focus for itself.
    const frame = requestAnimationFrame(() => first.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const { task, milestone, link } = choice;
  const taskName = task.title || "Untitled";
  const milestoneName = milestone.title || "Untitled";
  const fromTask = link.predecessorId === task.id;
  const aimingElsewhere = task.targetId !== null && task.targetId !== milestone.id ? state.rows[task.targetId]?.title : undefined;
  return (
    <DropdownMenu.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenu.Trigger asChild>
        <span aria-label={`Link ${taskName} and ${milestoneName}`} className="fixed h-0 w-0" style={{ left: choice.x, top: choice.y }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="z-50 w-72 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg"
        >
          <DropdownMenu.Item ref={first} className={ITEM} onSelect={() => run({ type: "setTarget", id: task.id, targetId: milestone.id })}>
            {taskName} aims for {milestoneName}
            <span className={NOTE}>{aimingElsewhere === undefined ? "Never moves the milestone" : `Instead of ${aimingElsewhere || "Untitled"}`}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={ITEM} onSelect={() => run(link)}>
            Link: {fromTask ? `${milestoneName} waits for ${taskName}` : `${taskName} waits for ${milestoneName}`}
            <span className={NOTE}>{linkNote(link, taskName, milestoneName, fromTask)}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
