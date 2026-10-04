import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";
import { keys } from "./queries";

/** Server answers that mean "your session is gone or blocked": re-check who is signed in. */
const SESSION_ERRORS = new Set(["unauthorized", "password_change_required", "two_factor_setup_required"]);

/**
 * The app's query client. When any request reports a lost session, the "who am I" query is
 * refreshed so the signed-in layout redirects to sign-in (or password change, or two-factor setup) — even on screens
 * that stay open for hours, like the board.
 */
export function createQueryClient({ retry = true }: { retry?: boolean } = {}): QueryClient {
  const onError = (error: unknown) => {
    if (error instanceof ApiError && SESSION_ERRORS.has(error.code)) void client.invalidateQueries({ queryKey: keys.me });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      // Client errors (4xx) won't fix themselves; only retry network/server trouble.
      queries: {
        retry: retry ? (count, error) => count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500) : false,
      },
    },
  });
  return client;
}
