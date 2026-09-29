import { useEffect, useRef, useState } from "react";

/**
 * A color picker that reports only the final choice. (React's onChange fires continuously while
 * the picker is dragged; the native "change" event fires once when the picker closes.)
 */
export function ColorInput({ label, value, onCommit }: { label: string; value: string; onCommit: (color: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const onChange = () => {
      if (input.value !== value) commit.current(input.value);
    };
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, [value]);
  return (
    <input
      ref={ref}
      type="color"
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className="h-7 w-9 cursor-pointer rounded border border-border-strong bg-bg"
    />
  );
}
