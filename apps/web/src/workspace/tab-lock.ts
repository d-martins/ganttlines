import { useCallback, useEffect, useRef, useState } from "react";

const LOCK = "ganttlines-workspace";
export type TabLockState = "checking" | "held" | "elsewhere";

/**
 * One tab changes this browser's workspace at a time (two would overwrite each other). The tab
 * holding the lock keeps it until it closes; another tab can take it over (`take`), and the first
 * then shows that it's open elsewhere. Browsers without Web Locks just carry on.
 */
export function useTabLock(enabled: boolean): { state: TabLockState; take: () => Promise<void> } {
  const [state, setState] = useState<TabLockState>("checking");
  const release = useRef<(() => void) | null>(null);

  const hold = useCallback((options: LockOptions) => {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      setState("held");
      return Promise.resolve();
    }
    return new Promise<void>((settled) => {
      locks
        .request(LOCK, options, async (lock) => {
          if (!lock) {
            setState("elsewhere");
            settled();
            return;
          }
          setState("held");
          settled();
          await new Promise<void>((done) => (release.current = done));
        })
        // Another tab took it over ("Use here" there).
        .catch(() => {
          setState("elsewhere");
          settled();
        });
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void hold({ ifAvailable: true });
    return () => release.current?.();
  }, [enabled, hold]);

  return { state: enabled ? state : "held", take: () => hold({ steal: true }) };
}
