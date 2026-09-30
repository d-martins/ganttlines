import * as Popover from "@radix-ui/react-popover";
import { Check } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useFocusReturnOnKeyboardClose } from "./popover-focus";

export interface SearchOption {
  key: string;
  label: string;
  /** an icon or avatar before the label */
  leading?: ReactNode;
  /** muted text after the label (dates, …) */
  detail?: string;
  /** the value it has now: opened on, marked with a check */
  current?: boolean;
  onChoose: () => void;
}

/**
 * A searchable single-choice list in a popover: type to filter, ↑/↓ to move, Enter to choose. It
 * opens on the current choice (checked). With `open`/`onOpenChange` it is controlled and the
 * trigger is only an anchor — the owner decides what opens it (e.g. a double-click); otherwise a
 * click on the trigger opens it.
 */
export function SearchSelect({
  trigger,
  options,
  searchLabel,
  placeholder,
  empty = "Nothing matches.",
  footer,
  open: controlledOpen,
  onOpenChange,
  align = "start",
}: {
  trigger: ReactNode;
  /** the options for what has been typed */
  options: (query: string) => SearchOption[];
  searchLabel: string;
  placeholder: string;
  empty?: string;
  /** extra controls under the list */
  footer?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "end";
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();
  const focusReturn = useFocusReturnOnKeyboardClose();
  const list = options(query.trim());
  // Until the pointer or arrows move, the highlight sits on the current choice (or the first match).
  const index = Math.min(active ?? Math.max(list.findIndex((option) => option.current), 0), Math.max(list.length - 1, 0));

  const setOpen = (next: boolean) => {
    if (!next) {
      setQuery("");
      setActive(null);
    }
    if (controlled) onOpenChange?.(next);
    else setOwnOpen(next);
  };
  const choose = (option: SearchOption | undefined) => {
    if (!option) return;
    setOpen(false);
    option.onChoose();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {controlled ? <Popover.Anchor asChild>{trigger}</Popover.Anchor> : <Popover.Trigger asChild>{trigger}</Popover.Trigger>}
      <Popover.Portal>
        <Popover.Content {...focusReturn} align={align} sideOffset={4} className="z-50 w-72 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={list[index] ? `${listId}-${list[index]!.key}` : undefined}
            aria-label={searchLabel}
            placeholder={placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") setActive(Math.min(index + 1, list.length - 1));
              else if (event.key === "ArrowUp") setActive(Math.max(index - 1, 0));
              else if (event.key === "Enter") choose(list[index]);
              else return;
              event.preventDefault();
            }}
            className="mb-1 w-full rounded border border-border-strong bg-bg px-2 py-1"
          />
          <div role="listbox" id={listId} aria-label={searchLabel} className="max-h-64 overflow-auto">
            {list.map((option, position) => (
              <div
                key={option.key}
                id={`${listId}-${option.key}`}
                role="option"
                aria-selected={option.current ?? false}
                onPointerEnter={() => setActive(position)}
                onClick={() => choose(option)}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${position === index ? "bg-surface-2" : ""} ${option.current ? "font-semibold" : ""}`}
              >
                {option.leading}
                <span className="truncate">{option.label}</span>
                {option.detail ? <span className="ml-auto shrink-0 text-xs font-normal text-muted">{option.detail}</span> : null}
                {option.current ? <Check aria-hidden size={14} className={`${option.detail ? "" : "ml-auto"} shrink-0 text-accent`} /> : null}
              </div>
            ))}
            {list.length === 0 ? <p className="px-2 py-1.5 text-muted">{empty}</p> : null}
          </div>
          {footer ? <div className="mt-1 border-t border-border px-2 pt-2 pb-1">{footer}</div> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
