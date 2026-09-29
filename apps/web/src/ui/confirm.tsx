import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import { Button } from "./button";

/**
 * A button that asks for confirmation in a modal before doing something destructive.
 * Escape, the Cancel button and clicking outside all back out.
 */
export function ConfirmButton({
  label,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  trigger,
}: {
  label: string;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  /** a custom trigger (a button) instead of the default danger button */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger ?? <Button variant="danger">{label}</Button>}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg p-5 text-text shadow-xl">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">{message}</Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="dangerSolid"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
