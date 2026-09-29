import { SHARE_TOKEN_HEADER } from "@ganttlines/protocol";

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

let shareToken: string | null = null;

/** In share-link mode every request carries the link's token (plan 3d). */
export function setShareToken(token: string | null): void {
  shareToken = token;
}

/** JSON request to the server (same origin, session cookie). Resolves to undefined for 204. */
export async function api<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (shareToken) headers[SHARE_TOKEN_HEADER] = shareToken;
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection.");
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? "http_error", data?.message ?? response.statusText);
  return data as T;
}

/** A readable message for any thrown error (API errors carry the server's own wording). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong";
}
