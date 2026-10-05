import { ApiError, createApi } from "@ganttlines/client";
import { SHARE_TOKEN_HEADER } from "@ganttlines/protocol/constants";

export { ApiError };

let shareToken: string | null = null;

/** In share-link mode every request carries the link's token. */
export function setShareToken(token: string | null): void {
  shareToken = token;
}

/** The share link's token while in link mode (the board's live link carries it too). */
export const currentShareToken = (): string | null => shareToken;

/** JSON request to the server (same origin, session cookie). Resolves to undefined for 204. */
export const api = createApi(
  (path, init) => fetch(path, { ...init, credentials: "same-origin" }),
  (): Record<string, string> => (shareToken ? { [SHARE_TOKEN_HEADER]: shareToken } : {}),
);

/** A readable message for any thrown error (API errors carry the server's own wording). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong";
}

/**
 * The error of the most recently started of several actions (mutations) — null once a later one
 * works, so an old failure doesn't linger next to newer results.
 */
export function latestError(...actions: { error: Error | null; submittedAt: number }[]): Error | null {
  let latest: { error: Error | null; submittedAt: number } | undefined;
  for (const action of actions) if (action.submittedAt > 0 && (!latest || action.submittedAt >= latest.submittedAt)) latest = action;
  return latest?.error ?? null;
}
