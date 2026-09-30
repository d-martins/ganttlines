import { z } from "zod";

/** GET /api/about — the running version; admins also get the update check's findings. */
export interface AboutDto {
  version: string;
  updates?: {
    /** the admins' switch: ask GitHub for new releases (about once a day) */
    enabled: boolean;
    /** the newest published release, when known */
    latest: { version: string; url: string } | null;
    /** `latest` is newer than the running version */
    available: boolean;
  };
}

/** PUT /api/settings/update-check */
export const UpdateCheckBody = z.strictObject({ enabled: z.boolean() });
export type UpdateCheckBody = z.infer<typeof UpdateCheckBody>;
