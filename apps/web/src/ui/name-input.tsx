import { useEffect, useRef, useState } from "react";

/** A name edited in place: saved on Enter or when leaving it; Escape (or a failed save) puts it back. */
export function NameInput({
  label,
  value,
  onCommit,
  className,
  allowEmpty = false,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (name: string, revert: () => void) => void;
  className: string;
  /** an empty name is saved too (e.g. clearing an optional label) */
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const name = draft.trim();
        if (cancelled.current || (!name && !allowEmpty) || name === value) {
          cancelled.current = false;
          setDraft(value);
          return;
        }
        onCommit(name, () => setDraft(value));
      }}
      className={`rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-accent ${className}`}
    />
  );
}
