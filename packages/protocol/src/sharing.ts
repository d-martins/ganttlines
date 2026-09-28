import { z } from "zod";

/** Requests made through a share link carry its token in this header (the WebSocket uses `?share=`). */
export const SHARE_TOKEN_HEADER = "x-share-token";

export const LINK_ACCESS = ["anonymous", "authenticated"] as const;
export type LinkAccess = (typeof LINK_ACCESS)[number];

const label = z.string().trim().max(100);

export const CreateShareLinkBody = z.strictObject({
  access: z.enum(LINK_ACCESS),
  /** false = view only; true = the board can be edited through the link */
  collaboration: z.boolean().default(false),
  label: label.default(""),
});
export const UpdateShareLinkBody = z.strictObject({ collaboration: z.boolean().optional(), label: label.optional() });
/**
 * An anonymous visitor's display name, chosen on first visit. Control and bidirectional-override
 * characters are removed and whitespace collapsed, so a name cannot hide the "(anonymous)" suffix.
 */
export const VisitorBody = z.strictObject({
  name: z
    .string()
    .max(200)
    .transform((value) => value.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(60)),
});

export type CreateShareLinkBody = z.input<typeof CreateShareLinkBody>;
export type UpdateShareLinkBody = z.infer<typeof UpdateShareLinkBody>;
export type VisitorBody = z.infer<typeof VisitorBody>;

export interface ShareLinkDto {
  id: string;
  projectId: string;
  access: LinkAccess;
  collaboration: boolean;
  label: string;
  createdBy: string;
  createdAt: string;
  revoked: boolean;
}

/** Response of POST /api/projects/:id/share-links — the token is only ever shown here. */
export interface CreatedShareLinkDto {
  link: ShareLinkDto;
  token: string;
  url: string;
}

/** Response of GET /api/share/:token — what a visitor needs before opening the board. */
export interface ShareInfoDto {
  project: { id: string; name: string };
  access: LinkAccess;
  collaboration: boolean;
  label: string;
  /** authenticated links: the visitor must sign in first */
  needsSignIn: boolean;
  /** anonymous links: the display name chosen earlier in this browser, if any */
  visitor: { name: string } | null;
}
