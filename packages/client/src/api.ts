/** A failed API call: `code` is the server's machine-readable `error` (e.g. "unauthorized"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type ApiFn = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;
/** The bit of `fetch` the client needs (tests pass an in-memory one). */
export type FetchLike = (
  path: string,
  init: { method: HttpMethod; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; statusText: string; json(): Promise<unknown> }>;

/** JSON requests through `fetchLike`. Resolves to undefined for 204; failures throw `ApiError`. */
export function createApi(fetchLike: FetchLike, extraHeaders: () => Record<string, string> = () => ({})): ApiFn {
  return async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { ...extraHeaders() };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchLike(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
    }
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!response.ok) {
      // No JSON body: a proxy or gateway answered because the server itself is down or restarting.
      if (!data && response.status >= 500) throw new ApiError(response.status, "unavailable", "The server isn't responding. Try again in a moment.");
      throw new ApiError(response.status, data?.error ?? "http_error", data?.message ?? response.statusText);
    }
    return data as T;
  };
}
