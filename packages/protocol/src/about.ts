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
  /** admins: whether outgoing email (SMTP) is set up */
  mail?: { configured: boolean };
  /** admins: who must use two-factor to sign in with a password */
  requireTwoFactor?: TwoFactorRequirement;
}

/** PUT /api/settings/update-check */
export const UpdateCheckBody = z.strictObject({ enabled: z.boolean() });
export type UpdateCheckBody = z.infer<typeof UpdateCheckBody>;

/** Who must use two-factor to sign in with a password (single sign-on relies on the provider's). */
export const TWO_FACTOR_REQUIREMENTS = ["off", "admins", "everyone"] as const;
export type TwoFactorRequirement = (typeof TWO_FACTOR_REQUIREMENTS)[number];

/** PUT /api/settings/require-two-factor */
export const RequireTwoFactorBody = z.strictObject({ require: z.enum(TWO_FACTOR_REQUIREMENTS) });
export type RequireTwoFactorBody = z.infer<typeof RequireTwoFactorBody>;
