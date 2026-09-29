import * as Tooltip from "@radix-ui/react-tooltip";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-text border-accent hover:opacity-90",
  secondary: "bg-bg text-text border-border hover:bg-surface-2",
  danger: "bg-bg text-danger border-border hover:bg-surface-2",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-2",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/** An icon-only button; `label` is both its accessible name and its tooltip. */
export function IconButton({ label, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text ${className}`}
          {...props}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={6} className="rounded bg-text px-2 py-1 text-xs text-bg shadow">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
