import type { z } from "zod";
import { ApiError } from "../api";

export interface Validation {
  protocol: typeof import("@ganttlines/protocol");
  /** The input as `schema` reads it (trimmed, defaults filled in), or a 400 like the server's. */
  check<T extends z.ZodType>(schema: T, input: unknown): z.output<T>;
  explain(error: z.ZodError): string;
}

let loading: Promise<Validation> | null = null;

/** The protocol's request schemas (and zod), loaded on first use so they stay out of the first download. */
export function validation(): Promise<Validation> {
  loading ??= Promise.all([import("@ganttlines/protocol"), import("zod")]).then(([protocol, zod]) => ({
    protocol,
    explain: (error) => zod.z.prettifyError(error),
    check: (schema, input) => {
      const result = schema.safeParse(input ?? {});
      if (!result.success) throw new ApiError(400, "invalid_request", zod.z.prettifyError(result.error));
      return result.data;
    },
  }));
  return loading;
}
