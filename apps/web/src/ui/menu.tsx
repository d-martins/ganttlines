import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

/** A dropdown menu (keyboard accessible via Radix). */
export function Menu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-44 rounded-md border border-border bg-bg p-1 text-sm text-text shadow-lg">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ onSelect, children, danger = false }: { onSelect: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={`cursor-pointer rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2 ${danger ? "text-danger" : ""}`}
    >
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 py-1 text-xs text-muted">{children}</DropdownMenu.Label>;
}

export function MenuRadio<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
      {options.map((option) => (
        <DropdownMenu.RadioItem
          key={option.value}
          value={option.value}
          className="flex cursor-pointer items-center justify-between rounded px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"
        >
          {option.label}
          <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-border" />;
