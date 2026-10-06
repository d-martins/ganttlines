import { ApiError, LocalSource, MemoryStore } from "@ganttlines/client";
import type { UserDto } from "@ganttlines/protocol";
import { create } from "zustand";
import { IndexedDbStore } from "./indexed-db-store";
import { PersistingStore } from "./persisting-store";

/** Who uses a local workspace: no account; may do everything the workspace allows. */
export const LOCAL_PERSON: UserDto = {
  id: "local",
  email: "",
  name: "You",
  role: "admin",
  mustChangePassword: false,
  twoFactor: false,
  mustSetUpTwoFactor: false,
};

/**
 * Why changes stopped being saved (the app shows a banner; the workspace keeps working in memory):
 * the browser can't store anything, the stored workspace couldn't be opened, or a change couldn't be
 * written.
 */
export type StorageProblem = "unavailable" | "open" | "save";
export const useStorageStatus = create<{ failed: false | StorageProblem }>(() => ({ failed: false }));

let opening: Promise<LocalSource> | null = null;
let store: PersistingStore | null = null;

/** This browser's workspace, opened once: from IndexedDB, or in memory when the browser can't store anything. */
export function openLocalWorkspace(): Promise<LocalSource> {
  if (!opening) {
    const failed = (problem: StorageProblem) => () => useStorageStatus.setState({ failed: problem });
    const stored = new PersistingStore(new IndexedDbStore());
    store = stored;
    const attempt = LocalSource.open(stored, { onStorageError: failed("save") }).catch((error: unknown) => {
      // Stored by a newer GanttLines (or unreadable): never hide it behind an empty workspace.
      if (error instanceof ApiError) throw error;
      failed(globalThis.indexedDB ? "open" : "unavailable")();
      return LocalSource.open(new MemoryStore(), { onStorageError: failed("save") });
    });
    attempt.catch(() => {
      if (opening === attempt) opening = null;
    });
    opening = attempt;
  }
  return opening;
}

/** Opens the workspace again from storage (another tab may have changed it meanwhile); the copy before stops writing. */
export function reopenLocalWorkspace(): Promise<LocalSource> {
  stopLocalWorkspace();
  return openLocalWorkspace();
}

/** Another tab took the workspace over: this tab's copy writes nothing more. */
export function stopLocalWorkspace(): void {
  store?.stop();
  store = null;
  opening = null;
}

/** Settles once every change made in this tab's copy is stored (before letting another tab have it). */
export async function settleLocalWorkspace(): Promise<void> {
  await (await opening?.catch(() => null))?.idle();
}

/** Tests: start from nothing. */
export function forgetLocalWorkspace(): void {
  opening = null;
  store = null;
}
