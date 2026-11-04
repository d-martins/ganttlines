import { milestonesOf } from "./slack";
import { tagKey, type ProjectState, type RowId } from "@ganttlines/engine";
import type { ResourceDto } from "@ganttlines/protocol";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NO_FILTERS, type BoardFilters } from "./filters";
import { outline } from "./rows";

type Part = "people" | "tags" | "milestones" | "sections";
const PART_NAMES: Record<Part, string> = { people: "People", tags: "Tags", milestones: "Milestone", sections: "Section" };
const CHIP_NAMES: Record<Part, string> = { people: "People", tags: "Tag", milestones: "Milestone", sections: "Section" };

interface Option {
  value: string;
  label: string;
  depth?: number;
}

const CONTENT = "z-50 max-h-80 min-w-44 overflow-y-auto rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg";
/** A filter in use (the filter chips, and tags on the chart that are filtered by). */
export const ACTIVE_CHIP = "border-accent/40 bg-accent-soft text-text";
const ITEM = "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2";

/**
 * The strip under the top bar: the title search, one chip per filter in use, "+ Filter" and, while
 * filtering, how many tasks match. Every change goes through `onUpdate` (into the address).
 */
export function FilterBar({
  state,
  resources,
  filters,
  known,
  filtering,
  count,
  onUpdate,
}: {
  state: ProjectState;
  resources: readonly ResourceDto[];
  /** the filters as in the address */
  filters: BoardFilters;
  /** the part of them this board knows (see knownFilters): what the chips show */
  known: BoardFilters;
  /** the board is narrowed */
  filtering: boolean;
  count: { matching: number; total: number };
  onUpdate: (change: (current: BoardFilters) => BoardFilters) => void;
}) {
  const options = useOptions(state, resources, filters);
  const toggle = (part: Part, value: string) =>
    onUpdate((current) => {
      const list = current[part];
      const same = (entry: string) => (part === "tags" ? tagKey(entry) === tagKey(value) : entry === value);
      return { ...current, [part]: list.some(same) ? list.filter((entry) => !same(entry)) : [...list, value] };
    });
  const checked = (part: Part, value: string) => (part === "tags" ? filters.tags.some((tag) => tagKey(tag) === tagKey(value)) : filters[part].includes(value));
  const items = (part: Part) => <PartItems options={options[part]} part={part} checked={checked} toggle={toggle} />;

  const chips = (["people", "tags", "milestones", "sections"] as const).flatMap((part) => {
    const labels = chipLabels(part, known, options);
    return labels.length > 0 ? [{ part, label: `${CHIP_NAMES[part]}: ${labels.join(", ")}` }] : [];
  });

  return (
    <div role="toolbar" aria-label="Filters" className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface px-2 py-1 text-xs">
      <SearchBox value={filters.q} onChange={(q) => onUpdate((current) => ({ ...current, q }))} />
      {chips.map(({ part, label }) => (
        <span key={part} className={`flex items-center rounded-full border ${ACTIVE_CHIP}`}>
          <FilterMenu
            part={part}
            items={items}
            trigger={
              <button type="button" className="max-w-64 truncate rounded-l-full py-0.5 pr-1 pl-2.5 hover:underline">
                {label}
              </button>
            }
          />
          <button
            type="button"
            aria-label={`Remove the filter ${label}`}
            onClick={() => onUpdate((current) => ({ ...current, [part]: [] }))}
            className="rounded-r-full py-0.5 pr-2 pl-0.5 text-muted hover:text-text"
          >
            <X aria-hidden size={12} />
          </button>
        </span>
      ))}
      <FilterMenu
        part={null}
        items={items}
        trigger={
          <button type="button" className="rounded-full border border-dashed border-border-strong px-2.5 py-0.5 text-muted hover:border-accent hover:text-text">
            + Filter
          </button>
        }
      />
      {filtering ? (
        <span className="ml-auto flex items-center gap-1.5 text-muted">
          <span className="tabular-nums">
            {count.matching} of {count.total} tasks
          </span>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => onUpdate(() => NO_FILTERS)} className="rounded px-1 text-accent hover:underline">
            Clear all
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * "+ Filter" (`part` null) first asks which filter, then shows its choices in the same menu, under a
 * title that goes back (as do Backspace and ←) to ask again; a chip opens straight on its own part.
 */
function FilterMenu({ part: initial, items, trigger }: { part: Part | null; items: (part: Part) => ReactNode; trigger: ReactNode }) {
  const [part, setPart] = useState<Part | null>(initial);
  const content = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const go = (next: Part | null) => {
    moved.current = true;
    setPart(next);
  };
  // The chosen item is gone once the menu changes: keep focus in the menu, for the arrow keys.
  useEffect(() => {
    if (moved.current) content.current?.focus();
    moved.current = false;
  }, [part]);
  const canGoBack = initial === null && part !== null;
  return (
    <DropdownMenu.Root onOpenChange={(open) => open && setPart(initial)}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={content}
          align="start"
          sideOffset={4}
          className={CONTENT}
          onKeyDown={(event) => {
            if (!canGoBack) return;
            // Backspace belongs to a text box that has focus.
            const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
            if (event.key === "ArrowLeft" || (event.key === "Backspace" && !typing)) {
              event.preventDefault();
              go(null);
            }
          }}
        >
          {part === null ? (
            (["people", "tags", "milestones", "sections"] as const).map((choice) => (
              <DropdownMenu.Item
                key={choice}
                onSelect={(event) => {
                  event.preventDefault();
                  go(choice);
                }}
                className={`${ITEM} justify-between`}
              >
                {PART_NAMES[choice]}
                <ChevronRight aria-hidden size={14} className="text-muted" />
              </DropdownMenu.Item>
            ))
          ) : (
            <>
              {canGoBack ? (
                <DropdownMenu.Item
                  aria-label={`Back from ${PART_NAMES[part]}`}
                  onSelect={(event) => {
                    event.preventDefault();
                    go(null);
                  }}
                  className={`${ITEM} gap-1 py-1 pl-1 text-xs font-semibold text-muted data-[highlighted]:text-text`}
                >
                  <ChevronLeft aria-hidden size={14} />
                  {PART_NAMES[part]}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Label className="px-2 py-1 text-xs font-semibold text-muted">{PART_NAMES[part]}</DropdownMenu.Label>
              )}
              {items(part)}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The search box keeps what's typed (spaces and all) while the address holds the trimmed-away rest. */
function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value);
  // Changed from elsewhere (Clear all, back / forward): show it.
  useEffect(() => {
    setText((current) => (current.trim() === value.trim() ? current : value));
  }, [value]);
  const change = (next: string) => {
    setText(next);
    onChange(next);
  };
  return (
    <label className="flex w-48 min-w-0 items-center gap-1 rounded-md border border-border bg-bg px-1.5 text-muted focus-within:border-accent">
      <Search aria-hidden size={12} className="shrink-0" />
      <input
        type="search"
        aria-label="Search tasks"
        placeholder="Search tasks"
        value={text}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && change("")}
        className="min-w-0 flex-1 bg-transparent py-1 text-text outline-none placeholder:text-muted"
      />
    </label>
  );
}

function PartItems({
  options,
  part,
  checked,
  toggle,
}: {
  options: Option[];
  part: Part;
  checked: (part: Part, value: string) => boolean;
  toggle: (part: Part, value: string) => void;
}): ReactNode {
  if (options.length === 0) {
    return <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{part === "tags" ? "No tags on this board yet." : "No sections on this board yet."}</DropdownMenu.Label>;
  }
  return options.map((option) => (
    <DropdownMenu.CheckboxItem
      key={option.value}
      checked={checked(part, option.value)}
      // Stays open: several choices in a row are common.
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={() => toggle(part, option.value)}
      className={ITEM}
      style={option.depth ? { paddingLeft: 8 + option.depth * 12 } : undefined}
    >
      <span aria-hidden className="w-3 text-accent">
        <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
      </span>
      {option.label}
    </DropdownMenu.CheckboxItem>
  ));
}

/** What each part of the menu offers: the team and "Unassigned", the tags used here, the sections here. */
function useOptions(state: ProjectState, resources: readonly ResourceDto[], filters: BoardFilters): Record<Part, Option[]> {
  return useMemo(() => {
    const tasks = Object.values(state.rows).flatMap((row) => (row.kind === "task" ? [row] : []));
    const assigned = new Set(tasks.map((row) => row.resourceId));
    const people: Option[] = [
      ...resources.filter((resource) => !resource.inactive || assigned.has(resource.id) || filters.people.includes(resource.id)).map((resource) => ({ value: resource.id, label: resource.name })),
      { value: "none", label: "Unassigned" },
    ];
    // One entry per tag, in the spelling used here; tags in the filter that nobody uses here stay listed (to turn off).
    const tags = new Map<string, string>();
    for (const tag of [...tasks.flatMap((row) => row.tags), ...filters.tags]) if (tagKey(tag) && !tags.has(tagKey(tag))) tags.set(tagKey(tag), tag);
    const sections = outline(state)
      .visible.filter((entry) => entry.row.kind === "section")
      .map((entry) => ({ value: entry.row.id, label: entry.row.title || "Untitled", depth: entry.depth }));
    // Soonest first by the date placed on, undated last.
    const milestones = milestonesOf(state)
      .flatMap((row) => (row.kind === "task" ? [row] : []))
      .sort((a, b) => (a.userStart ?? "9999").localeCompare(b.userStart ?? "9999"))
      .map((row) => ({ value: row.id, label: row.title || "Untitled" }));
    return {
      people,
      milestones,
      tags: [...tags.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((tag) => ({ value: tag, label: tag })),
      sections,
    };
  }, [state, resources, filters.people, filters.tags]);
}

/** A chip's values: names of people and sections, tags as spelled here. */
function chipLabels(part: Part, known: BoardFilters, options: Record<Part, Option[]>): string[] {
  const label = (value: string) => (part === "tags" ? options.tags.find((option) => tagKey(option.value) === tagKey(value))?.label : options[part].find((option) => option.value === value)?.label);
  const values: RowId[] = part === "tags" ? known.tags.filter((tag) => tagKey(tag) !== "") : known[part];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = label(value) ?? value;
    const key = part === "tags" ? tagKey(value) : value;
    if (seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}
