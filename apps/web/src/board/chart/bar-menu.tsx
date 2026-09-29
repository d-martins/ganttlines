import { TASK_COLORS, type TaskRow } from "@ganttlines/engine";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Wrench } from "lucide-react";
import { useBoard, useRun } from "../board-context";
import { taskColors } from "../format";
import { deleteRow } from "../list/list-actions";

const ITEM = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2";

/**
 * The spanner menu of a task bar: color, lock, milestone, duplicate, remove predecessor, delete.
 * Controlled, so Enter on a focused bar can open it too.
 */
export function BarMenu({ task, isParent, open, onOpenChange }: { task: TaskRow; isParent: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const board = useBoard();
  const run = useRun();
  const title = task.title || "Untitled";
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Options for “${title}”`}
          onPointerDown={(event) => event.stopPropagation()}
          className="flex h-5 w-5 items-center justify-center rounded bg-bg text-muted shadow-sm ring-1 ring-border hover:text-text"
        >
          <Wrench size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="z-50 min-w-48 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg">
          <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">Color</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={task.color} onValueChange={(color) => color !== task.color && run({ type: "setColor", id: task.id, color: color as TaskRow["color"] })}>
            <div className="grid grid-cols-9 gap-1 px-2 pb-1">
              {TASK_COLORS.map((color) => (
                <DropdownMenu.RadioItem
                  key={color}
                  value={color}
                  aria-label={color}
                  className="h-5 w-5 cursor-pointer rounded outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-[var(--focus)] data-[state=checked]:ring-2 data-[state=checked]:ring-text"
                  style={{ background: taskColors(color).fill }}
                />
              ))}
            </div>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {!isParent ? (
            <>
              <DropdownMenu.Item className={ITEM} onSelect={() => run({ type: "setLocked", id: task.id, locked: !task.locked })}>
                {task.locked ? "Unlock dates" : "Lock dates"}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={ITEM} onSelect={() => run({ type: "convertMilestone", id: task.id, milestone: task.duration !== 0 })}>
                {task.duration === 0 ? "Make it a task" : "Make it a milestone"}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={ITEM} onSelect={() => run({ type: "duplicateTask", id: task.id, newId: crypto.randomUUID() })}>
                Duplicate
              </DropdownMenu.Item>
            </>
          ) : null}
          {task.predecessorId ? (
            <DropdownMenu.Item className={ITEM} onSelect={() => run({ type: "removePredecessor", id: task.id })}>
              Remove predecessor
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={`${ITEM} text-danger`} onSelect={() => deleteRow(board, task)}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
