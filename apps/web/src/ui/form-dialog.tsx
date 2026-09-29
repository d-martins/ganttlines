import * as Dialog from "@radix-ui/react-dialog";
import type { FormEvent, ReactNode } from "react";
import { Button } from "./button";
import { ErrorText } from "./field";

/**
 * A small modal form (controlled). Enter submits; Escape, Cancel and clicking outside close it.
 * `error` shows under the fields; `pending` disables the submit button.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  pending = false,
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: () => void;
  pending?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-5 text-text shadow-xl">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          {description ? <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
            {children}
            <ErrorText>{error}</ErrorText>
            <div className="mt-2 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={pending}>
                {submitLabel}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
