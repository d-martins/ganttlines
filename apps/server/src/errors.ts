/** An error that maps directly to an HTTP response `{ error: code, message }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "invalid_request", message);
export const unauthorized = () => new HttpError(401, "unauthorized", "Please sign in");
export const forbidden = (message = "You don't have access to this") => new HttpError(403, "forbidden", message);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
