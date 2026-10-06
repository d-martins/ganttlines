import { useCallback, useEffect, useRef, useState } from "react";

const LOCK = "ganttlines-workspace";
export type TabLockState = "checking" | "held" | "elsewhere";

type Request = { cancelled: boolean; release?: () => void };

/**
 * One tab changes this browser's workspace at a time (two would overwrite each other). The tab
 * holding the lock keeps it until it closes or stops wanting it; another tab can take it over
 * (`take`), and the first then shows that it's open elsewhere. `grant` counts the times this tab got
 * the lock: other tabs may have changed the workspace before each one. Browsers without Web Locks
 * just carry on.
 */
export function useTabLock(enabled: boolean): { state: TabLockState; grant: number; take: () => Promise<void> } {
  const [lock, setLock] = useState<{ state: TabLockState; grant: number }>({ state: "checking", grant: 0 });
  const current = useRef<Request | null>(null);

  const hold = useCallback((options: LockOptions) => {
    const request: Request = { cancelled: false };
    current.current = request;
    const set = (state: TabLockState) => {
      if (!request.cancelled) setLock((previous) => ({ state, grant: state === "held" ? previous.grant + 1 : previous.grant }));
    };
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks) {
      set("held");
      return Promise.resolve();
    }
    return new Promise<void>((settled) => {
      locks
        .request(LOCK, options, async (granted) => {
          // Granted after this tab stopped wanting it: let it go straight away.
          if (request.cancelled) return settled();
          set(granted ? "held" : "elsewhere");
          settled();
          if (granted) await new Promise<void>((done) => (request.release = done));
        })
        // Another tab took it over ("Use here" there).
        .catch(() => {
          set("elsewhere");
          settled();
        });
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLock((previous) => ({ ...previous, state: "checking" }));
    // Ask a moment later: a mount that's undone at once (React's development checks) never asks at all.
    const asking = setTimeout(() => void hold({ ifAvailable: true }));
    return () => {
      clearTimeout(asking);
      const request = current.current;
      if (!request) return;
      request.cancelled = true;
      request.release?.();
      current.current = null;
    };
  }, [enabled, hold]);

  return { state: enabled ? lock.state : "held", grant: lock.grant, take: () => hold({ steal: true }) };
}
