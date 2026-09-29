import { useId, type InputHTMLAttributes } from "react";

/** A labelled text input. */
export function Field({ label, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <input id={id} className="rounded-md border border-border-strong bg-bg px-2.5 py-1.5 text-sm text-text" {...props} />
    </div>
  );
}

export function ErrorText({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {children}
    </p>
  );
}
