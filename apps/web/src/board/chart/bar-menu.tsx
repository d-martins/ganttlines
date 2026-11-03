import { TASK_COLORS, type TaskRow } from "@ganttlines/engine";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Wrench } from "lucide-react";
import { useRef, type KeyboardEvent, type SyntheticEvent } from "react";
import { useBoard, useRun } from "../board-context";
import { taskColors } from "../format";
import { deleteRow } from "../list/list-actions";
import { TagsSection } from "../panel/tags-section";

const ITEM = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none hover:bg-surface-2 data-[highlighted]:bg-surface-2";
const LABEL = "px-2 py-1 text-xs text-muted";

/**
 * The spanner menu of a task bar: color, tags, lock, milestone, duplicate, delete.
 * Controlled, so Enter on a focused bar can open it too.
 */
export function BarMenu({ task, isParent, open, onOpenChange }: { task: TaskRow; isParent: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const board = useBoard();
  const run = useRun();
  const title = task.title || "Untitled";
  const tags = useRef<HTMLDivElement>(null);
  const inTags = (element: EventTarget | null) => tags.current?.contains(element as Node | null) === true;

  // The menu's items take the focus from under the mouse: not while typing a tag.
  const holdFocus = {
    onPointerMove: (event: SyntheticEvent) => inTags(document.activeElement) && event.preventDefault(),
    onPointerLeave: (event: SyntheticEvent) => inTags(document.activeElement) && event.preventDefault(),
  };

  // The tag box is no menu item, so the arrows can't reach it: Tab goes there and back.
  const onTabCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const target = inTags(event.target)
      ? event.currentTarget.querySelector<HTMLElement>('[role="menuitemradio"][data-state="checked"]')
      : tags.current?.querySelector("input");
    target?.focus();
  };

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
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 overflow-y-auto rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg"
          onKeyDownCapture={onTabCapture}
          // Radix hears Escape on the document, before the box: leave it to close the suggestions.
          onEscapeKeyDown={(event) => tags.current?.querySelector('[aria-expanded="true"]') && event.preventDefault()}
        >
          <DropdownMenu.Label className={LABEL}>Color</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={task.color} onValueChange={(color) => color !== task.color && run({ type: "setColor", id: task.id, color: color as TaskRow["color"] })}>
            <div className="grid grid-cols-9 gap-1 px-2 pb-1">
              {TASK_COLORS.map((color) => (
                <DropdownMenu.RadioItem
                  key={color}
                  value={color}
                  aria-label={color}
                  {...holdFocus}
                  className="h-5 w-5 cursor-pointer rounded outline-none hover:ring-2 hover:ring-[var(--focus)] data-[highlighted]:ring-2 data-[highlighted]:ring-[var(--focus)] data-[state=checked]:ring-2 data-[state=checked]:ring-text"
                  style={{ background: taskColors(color).fill }}
                />
              ))}
            </div>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Label className={LABEL}>Tags</DropdownMenu.Label>
          {/* Keys typed here are the box's, not the menu's: no typeahead or arrow moves, and Space or Enter don't close it. */}
          <div
            ref={tags}
            className="px-2 pb-1"
            onKeyDown={(event) => event.stopPropagation()}
            // A removed chip takes the focus with it, and the menu would hand it to a swatch.
            onClick={(event) => (event.target as Element).closest("button") && tags.current?.querySelector("input")?.focus()}
          >
            <TagsSection task={task} inlineList />
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {!isParent ? (
            <>
              <DropdownMenu.Item {...holdFocus} className={ITEM} onSelect={() => run({ type: "setLocked", id: task.id, locked: !task.locked })}>
                {task.locked ? "Unlock dates" : "Lock dates"}
              </DropdownMenu.Item>
              <DropdownMenu.Item {...holdFocus} className={ITEM} onSelect={() => run({ type: "convertMilestone", id: task.id, milestone: task.duration !== 0 })}>
                {task.duration === 0 ? "Make it a task" : "Make it a milestone"}
              </DropdownMenu.Item>
              <DropdownMenu.Item {...holdFocus} className={ITEM} onSelect={() => run({ type: "duplicateTask", id: task.id, newId: crypto.randomUUID() })}>
                Duplicate
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          ) : null}
          <DropdownMenu.Item {...holdFocus} className={`${ITEM} text-danger`} onSelect={() => deleteRow(board, task)}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
