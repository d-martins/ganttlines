import { renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTabLock } from "../src/workspace/tab-lock";

afterEach(() => {
  Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
});

describe("the one-tab lock", () => {
  it("gets the lock in development mode, where effects run twice", async () => {
    let held: string | null = null;
    const locks = {
      async request(_name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void>) {
        await Promise.resolve(); // granted later, as in browsers
        if (held && options.ifAvailable) return callback(null);
        const mine = Math.random().toString();
        held = mine;
        try {
          await callback({});
        } finally {
          if (held === mine) held = null;
        }
      },
    };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    // Development mode runs the effect, cleans it up and runs it again straight away.
    const { result, unmount } = renderHook(() => useTabLock(true), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.state).toBe("held"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.state).toBe("held");
    unmount();
    await waitFor(() => expect(held).toBeNull());
  });

  it("lets go of a lock granted after the tab stopped wanting it", async () => {
    let grant: () => void = () => undefined;
    let released = false;
    const locks = {
      async request(_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) {
        await new Promise<void>((resolve) => (grant = resolve));
        await callback({});
        released = true;
      },
    };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    const { unmount } = renderHook(() => useTabLock(true));
    await new Promise((resolve) => setTimeout(resolve, 10)); // asked, not granted yet
    unmount();
    grant();
    await waitFor(() => expect(released).toBe(true));
  });
});
