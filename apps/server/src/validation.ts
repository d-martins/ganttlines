import { z } from "zod";
import { badRequest, notFound } from "./errors";

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw badRequest(z.prettifyError(result.error));
  return result.data;
}

const uuid = z.uuid();

/** Route ids are UUIDs; anything else cannot exist (and would make Postgres reject the query). */
export function parseId(value: unknown, what: string): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw notFound(what);
  return result.data;
}
