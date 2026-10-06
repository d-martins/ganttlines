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

/** Whether changes stopped being saved (the app shows a banner; the workspace keeps working in memory). */
export const useStorageStatus = create<{ failed: boolean }>(() => ({ failed: false }));

let opening: Promise<LocalSource> | null = null;

/** This browser's workspace, opened once: from IndexedDB, or in memory when the browser can't store anything. */
export function openLocalWorkspace(): Promise<LocalSource> {
  if (!opening) {
    const failed = () => useStorageStatus.setState({ failed: true });
    const attempt = LocalSource.open(new PersistingStore(new IndexedDbStore()), { onStorageError: failed }).catch((error: unknown) => {
      // Stored by a newer GanttLines (or unreadable): never hide it behind an empty workspace.
      if (error instanceof ApiError) throw error;
      failed();
      return LocalSource.open(new MemoryStore(), { onStorageError: failed });
    });
    attempt.catch(() => {
      if (opening === attempt) opening = null;
    });
    opening = attempt;
  }
  return opening;
}

/** Opens the workspace again from storage (another tab may have changed it meanwhile). */
export function reopenLocalWorkspace(): Promise<LocalSource> {
  opening = null;
  return openLocalWorkspace();
}

/** Tests: start from nothing. */
export function forgetLocalWorkspace(): void {
  opening = null;
}
