import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { ACTIVE_CHIP } from "../filter-bar";

/** How many of a task's tags show beside its bar; the rest are behind "+X". */
const SHOWN = 2;
/** how long the "+X" popover stays after the pointer leaves it (time to move onto it) */
const CLOSE_DELAY_MS = 150;

export interface TagFilter {
  /** the tag is in the board's tag filter */
  active: (tag: string) => boolean;
  /** adds the tag to the filter, or takes it out */
  toggle: (tag: string) => void;
}

function TagChip({ tag, filter }: { tag: string; filter: TagFilter }) {
  const on = filter.active(tag);
  return (
    <button
      type="button"
      aria-label={`Filter by the tag “${tag}”`}
      aria-pressed={on}
      onClick={() => filter.toggle(tag)}
      className={`max-w-32 truncate rounded-full border px-1.5 text-[10.5px] leading-4 font-normal ${on ? ACTIVE_CHIP : "border-border-strong bg-surface-2 text-text hover:border-accent"}`}
    >
      {tag}
    </button>
  );
}

/**
 * A task's tags beside its bar: the first two, then "+X" (hover or click it for all of them).
 * Clicking a tag toggles it in the board's filter.
 */
export function TagChips({ title, tags, filter }: { title: string; tags: readonly string[]; filter: TagFilter }) {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  if (tags.length === 0) return null;
  const more = tags.length - SHOWN;
  const stay = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  const leave = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  return (
    // A click on a tag filters; it doesn't select the row.
    <span className="pointer-events-auto flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {tags.slice(0, SHOWN).map((tag) => (
        <TagChip key={tag} tag={tag} filter={filter} />
      ))}
      {more > 0 ? (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={`${more} more ${more === 1 ? "tag" : "tags"}`}
              onPointerEnter={stay}
              onPointerLeave={leave}
              onClick={(event) => {
                // Opens (hovering may have already): never toggles it shut.
                event.preventDefault();
                stay();
              }}
              className="rounded px-0.5 text-[10.5px] leading-4 font-normal text-muted hover:text-text"
            >
              +{more}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label={`Tags of “${title || "Untitled"}”`}
              side="bottom"
              align="start"
              sideOffset={4}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onPointerEnter={stay}
              onPointerLeave={leave}
              onClick={(event) => event.stopPropagation()}
              className="z-50 flex max-w-64 flex-wrap gap-1 rounded-md border border-border bg-bg p-1.5 shadow-lg"
            >
              {tags.map((tag) => (
                <TagChip key={tag} tag={tag} filter={filter} />
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </span>
  );
}
