import { useState, type InputHTMLAttributes } from "react";

export const INPUT = "w-full rounded-md border border-border-strong bg-bg px-2 py-1 text-sm text-text disabled:border-border disabled:text-muted";

/**
 * A text box for a stored value: shows the latest value (including other people's edits) until
 * you start typing, then commits on Enter or when it loses focus; Escape puts the value back.
 */
export function CommitInput({ value, onCommit, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      {...props}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== null) {
          event.stopPropagation();
          setDraft(null);
        }
      }}
      className={`${INPUT} ${props.className ?? ""}`}
    />
  );
}
