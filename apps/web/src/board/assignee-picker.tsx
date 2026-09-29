import type { ResourceDto } from "@ganttlines/protocol";
import * as Popover from "@radix-ui/react-popover";
import { Check, Plus, UserX } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { errorMessage } from "../api/client";
import { useCreateResource } from "../api/queries";
import { Avatar } from "../ui/avatar";
import { useFocusReturnOnKeyboardClose } from "../ui/popover-focus";
import { toast } from "../ui/toast";

interface Option {
  key: string;
  label: string;
  resource: ResourceDto | null;
  create?: boolean;
}

/**
 * Pick one assignee: type to filter, arrows to move, Enter to choose. Inactive people are hidden
 * unless already assigned. People who may add team members can create one from what they typed.
 */
export function AssigneePicker({
  value,
  resources,
  canCreate,
  onChange,
  trigger,
}: {
  value: string | null;
  resources: readonly ResourceDto[];
  canCreate: boolean;
  onChange: (resourceId: string | null) => void;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const create = useCreateResource();
  const listId = useId();
  const focusReturn = useFocusReturnOnKeyboardClose();

  const needle = query.trim().toLocaleLowerCase();
  const people = resources.filter((resource) => (!resource.inactive || resource.id === value) && resource.name.toLocaleLowerCase().includes(needle));
  const options: Option[] = [
    ...(needle ? [] : [{ key: "none", label: "Unassigned", resource: null }]),
    ...people.map((resource) => ({ key: resource.id, label: resource.name, resource })),
    ...(canCreate && needle && !resources.some((resource) => resource.name.toLocaleLowerCase() === needle)
      ? [{ key: "create", label: `New team member “${query.trim()}”`, resource: null, create: true }]
      : []),
  ];

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };
  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.create) {
      create.mutate(
        { name: query.trim() },
        {
          onSuccess: ({ resource }) => onChange(resource.id),
          onError: (error) => toast(`Couldn't add the team member: ${errorMessage(error)}`, { tone: "error" }),
        },
      );
    } else if (option.resource?.id !== value) {
      onChange(option.resource?.id ?? null);
    }
    close();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) return close();
        // Open on the current assignee, so it's clear who has the task (and Enter keeps it).
        setActive(Math.max(options.findIndex((option) => (option.resource?.id ?? null) === value && !option.create), 0));
        setOpen(true);
      }}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content {...focusReturn} align="start" sideOffset={4} className="z-50 w-64 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${options[active]!.key}` : undefined}
            aria-label="Find a person"
            placeholder="Find a person…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") setActive((index) => Math.min(index + 1, options.length - 1));
              else if (event.key === "ArrowUp") setActive((index) => Math.max(index - 1, 0));
              else if (event.key === "Enter") choose(options[active]);
              else return;
              event.preventDefault();
            }}
            className="mb-1 w-full rounded border border-border-strong bg-bg px-2 py-1"
          />
          <div role="listbox" id={listId} aria-label="People" className="max-h-64 overflow-auto">
            {options.map((option, index) => {
              const current = !option.create && (option.resource?.id ?? null) === value;
              return (
                <div
                  key={option.key}
                  id={`${listId}-${option.key}`}
                  role="option"
                  aria-selected={current}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 ${index === active ? "bg-surface-2" : ""} ${current ? "font-semibold" : ""}`}
                >
                  {option.create ? (
                    <Plus size={16} className="text-muted" />
                  ) : option.resource ? (
                    <Avatar name={option.resource.name} color={option.resource.avatarColor} size={20} />
                  ) : (
                    <UserX size={16} className="text-muted" />
                  )}
                  <span className="truncate">{option.label}</span>
                  {current ? <Check aria-hidden size={14} className="ml-auto shrink-0 text-accent" /> : null}
                </div>
              );
            })}
            {options.length === 0 ? <p className="px-2 py-1.5 text-muted">Nobody matches.</p> : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
