import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { errorMessage } from "../api/client";
import { Button } from "./button";

/** Renders children once `query` has data; otherwise a loading line or an error with a retry button. */
export function QueryState<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-danger">
        {errorMessage(query.error)}
        <Button onClick={() => void query.refetch()}>Retry</Button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
