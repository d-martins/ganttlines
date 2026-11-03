import { canonicalTags, MAX_TAG_LENGTH, MAX_TAGS_PER_TASK, tagKey, type TaskRow } from "@ganttlines/engine";
import { useQuery } from "@tanstack/react-query";
import { GripVertical, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { workspaceTags } from "../../api/queries";
import { toast } from "../../ui/toast";
import { useBoard, useRun } from "../board-context";

/** how many known tags the dropdown offers at most */
const MAX_SUGGESTIONS = 8;

const CHIP = "flex max-w-full items-center gap-0.5 rounded-full border border-border-strong bg-surface-2 py-0.5 text-xs text-text";

interface Choice {
  tag: string;
  /** a tag nobody uses yet */
  create: boolean;
}

const hasTag = (tags: readonly string[], tag: string) => tags.some((other) => tagKey(other) === tagKey(tag));

/** `tags` with the one at `from` moved to before the one at `to` (`tags.length`: to the end). */
function moveTag(tags: readonly string[], from: number, to: number): string[] {
  const next = tags.filter((_, index) => index !== from);
  next.splice(to > from ? to - 1 : to, 0, tags[from]!);
  return next;
}

/**
 * A task's tags: chips in its order (× removes one, the handle drags it to another place) and an
 * "Add tag" box that offers the workspace's matching tags, then creating a new one. Every change
 * sends the whole list. Viewers see the chips only.
 */
export function TagsSection({ task }: { task: TaskRow }) {
  const board = useBoard();
  const run = useRun();
  const { canEdit, state } = board;
  // Only signed-in editors and admins may list the workspace's tags; others need no suggestions.
  const workspace = useQuery(workspaceTags(canEdit && board.canEditCalendar)).data;
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [drag, setDrag] = useState<{ from: number; to: number | null } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const latest = useRef(task.tags);
  latest.current = task.tags;
  const listId = useId();

  // The workspace's tags, then any on this board it doesn't list yet (just added here, say).
  const known = useMemo(() => {
    const byKey = new Map<string, string>();
    const boardTags = Object.values(state.rows).flatMap((row) => (row.kind === "task" ? row.tags : []));
    for (const tag of [...(workspace ?? []), ...boardTags]) if (!byKey.has(tagKey(tag))) byKey.set(tagKey(tag), tag);
    return [...byKey.values()];
  }, [workspace, state.rows]);

  const needle = tagKey(text);
  const choices: Choice[] = needle
    ? [
        ...known
          .filter((tag) => tagKey(tag).includes(needle) && !hasTag(task.tags, tag))
          .slice(0, MAX_SUGGESTIONS)
          .map((tag) => ({ tag, create: false })),
        ...(hasTag(known, text) || hasTag(task.tags, text) ? [] : [{ tag: text.trim(), create: true }]),
      ]
    : [];
  const showList = focused && choices.length > 0;
  const active = Math.min(highlight, choices.length - 1);

  const send = (tags: string[]) => run({ type: "setTags", id: task.id, tags });
  const add = (choice: Choice) => {
    // A refused tag stays in the box, so what was typed isn't lost.
    if (task.tags.length >= MAX_TAGS_PER_TASK) return toast(`A task has at most ${MAX_TAGS_PER_TASK} tags`, { tone: "error" });
    if (!send([...task.tags, ...canonicalTags([choice.tag], known)])) return;
    setText("");
    setHighlight(0);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (choices.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + choices.length) % choices.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[active];
      if (choice) add(choice);
    } else if (event.key === "Escape" && text) {
      event.stopPropagation();
      setText("");
    } else if (event.key === "Backspace" && text === "" && task.tags.length > 0) {
      event.preventDefault();
      send(task.tags.slice(0, -1));
    }
  };

  // Dragging a chip by its handle, as rows in the task list are: the drop lands before the chip under the pointer.
  const startDrag = (event: ReactPointerEvent, from: number) => {
    if (!canEdit || event.button !== 0) return;
    event.preventDefault();
    let to: number | null = null;
    setDrag({ from, to });
    const move = (moveEvent: PointerEvent) => {
      const chips = [...(list.current?.querySelectorAll<HTMLElement>(":scope > [data-chip]") ?? [])];
      const index = chips.findIndex((chip) => {
        const box = chip.getBoundingClientRect();
        return moveEvent.clientY < box.top || (moveEvent.clientY <= box.bottom && moveEvent.clientX < box.left + box.width / 2);
      });
      to = index < 0 ? chips.length : index;
      setDrag({ from, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (to === null) return;
      const tags = latest.current;
      const next = moveTag(tags, from, to);
      if (next.some((tag, index) => tag !== tags[index])) send(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** where the dragged chip would land: a line before this chip, or after the last one */
  const dropMark = (index: number) => {
    if (!drag || drag.to === null || drag.to === drag.from || drag.to === drag.from + 1) return "";
    if (drag.to === index) return "shadow-[-3px_0_0_var(--accent)]";
    return drag.to === task.tags.length && index === task.tags.length - 1 ? "shadow-[3px_0_0_var(--accent)]" : "";
  };

  if (!canEdit && task.tags.length === 0) return <p className="text-sm text-muted">None</p>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {task.tags.length > 0 ? (
        <ul ref={list} aria-label="Tags" className="flex max-w-full flex-wrap items-center gap-1">
          {task.tags.map((tag, index) => (
            <li key={tag} data-chip className={`group ${CHIP} ${canEdit ? "pr-1 pl-0.5" : "px-2"} ${drag?.from === index ? "opacity-50" : ""} ${dropMark(index)}`}>
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Move the tag “${tag}”`}
                  tabIndex={-1}
                  onPointerDown={(event) => startDrag(event, index)}
                  className="cursor-grab touch-none text-muted opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
                >
                  <GripVertical aria-hidden size={12} />
                </button>
              ) : null}
              <span data-tag className="truncate">
                {tag}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  aria-label={`Remove the tag “${tag}”`}
                  onClick={() => send(task.tags.filter((_, other) => other !== index))}
                  className="rounded-full text-muted hover:text-text"
                >
                  <X aria-hidden size={12} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className="relative min-w-28 flex-1">
          <input
            role="combobox"
            aria-label="Add tag"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList ? `${listId}-${active}` : undefined}
            placeholder="Add tag"
            maxLength={MAX_TAG_LENGTH}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKey}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="w-full rounded-md border border-transparent bg-transparent px-0 py-0.5 text-sm text-text outline-none transition-[padding,border-color] duration-200 ease-out placeholder:text-muted focus:border-border-strong focus:bg-bg focus:px-2 motion-reduce:transition-none"
          />
          {showList ? (
            <ul id={listId} role="listbox" aria-label="Tags to add" className="absolute top-full left-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-md border border-border bg-bg p-1 text-sm shadow-lg">
              {choices[0] && !choices[0].create ? (
                <li role="presentation" className="px-2 pt-0.5 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                  Recent
                </li>
              ) : null}
              {choices.map((choice, index) => (
                <li
                  key={`${choice.create}:${choice.tag}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  // Keeps the focus in the box.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => add(choice)}
                  className={`cursor-pointer truncate rounded px-2 py-1 ${index === active ? "bg-surface-2" : ""} ${choice.create ? "text-accent" : ""}`}
                >
                  {choice.create ? `+ Create "${choice.tag}"` : choice.tag}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
