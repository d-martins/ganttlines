import type { RowId } from "@ganttlines/engine";
import { useEffect, useReducer, useRef } from "react";

/**
 * The rows to show as matches: `matches`, plus rows that stopped matching while focused (an edit
 * took them out of the filter). Such a row stays while it is focused, leaves `delayMs` after focus
 * moves away, and stays for good if it matches again. A row that stops matching while not focused
 * leaves straight away, and so does every kept row when `scope` (the filters) changes.
 */
export function useLinger(matches: ReadonlySet<RowId>, focusedId: RowId | null, delayMs = 5000, scope: unknown = null): ReadonlySet<RowId> {
  const kept = useRef(new Set<RowId>());
  const previous = useRef({ matches, scope });
  const timers = useRef(new Map<RowId, ReturnType<typeof setTimeout>>());
  const cache = useRef<{ matches: ReadonlySet<RowId>; key: string; shown: ReadonlySet<RowId> } | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const forget = (id: RowId) => {
    kept.current.delete(id);
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  };
  // Worked out while rendering, so a kept row is never left out of even one frame (it would lose focus).
  if (!Object.is(previous.current.scope, scope)) {
    for (const id of [...kept.current]) forget(id);
  } else if (focusedId !== null && previous.current.matches.has(focusedId) && !matches.has(focusedId)) {
    kept.current.add(focusedId);
  }
  previous.current = { matches, scope };
  for (const id of [...kept.current]) if (matches.has(id)) forget(id);

  useEffect(() => {
    for (const id of kept.current) {
      const timer = timers.current.get(id);
      if (id === focusedId) {
        clearTimeout(timer);
        timers.current.delete(id);
      } else if (timer === undefined) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            kept.current.delete(id);
            rerender();
          }, delayMs),
        );
      }
    }
  });
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  if (kept.current.size === 0) return matches;
  const key = [...kept.current].sort().join("\n");
  if (cache.current?.matches !== matches || cache.current.key !== key) cache.current = { matches, key, shown: new Set([...matches, ...kept.current]) };
  return cache.current.shown;
}
