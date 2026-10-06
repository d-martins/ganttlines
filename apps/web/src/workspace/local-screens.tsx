import { Link } from "@tanstack/react-router";
import { errorMessage } from "../api/client";
import { Button } from "../ui/button";

/** Another tab is using this browser's workspace. */
export function OpenElsewhere({ onUseHere }: { onUseHere: () => void }) {
  return (
    <div className="mx-auto mt-24 flex max-w-md flex-col gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">GanttLines is open in another tab</h1>
      <p className="text-sm text-muted">Only one tab can change this browser's workspace at a time.</p>
      <Button variant="primary" className="self-center" onClick={onUseHere}>
        Use here
      </Button>
    </div>
  );
}

/** The browser's workspace couldn't be opened (e.g. saved by a newer GanttLines). */
export function LocalWorkspaceProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="mx-auto mt-24 flex max-w-md flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">This browser's workspace can't be opened</h1>
      <p role="alert" className="text-sm text-danger">
        {errorMessage(error)}
      </p>
      <Button className="self-start" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Changes stopped being saved (storage full or blocked): the work stays until the tab closes. */
export function StorageBanner() {
  return (
    <p role="alert" className="border-b border-border bg-[var(--warning-soft,#fff4e5)] px-4 py-1.5 text-xs">
      Changes can't be saved in this browser right now (its storage is full or blocked). Your work stays here until you close the tab —{" "}
      <Link to="/settings" className="underline">
        export it
      </Link>{" "}
      to keep a copy.
    </p>
  );
}
