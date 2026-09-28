import type { Db, ShareLink, User } from "@ganttlines/db";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { actorOf, type Actor } from "../actor";
import { HttpError, notFound, unauthorized } from "../errors";

export const VISITOR_COOKIE = "gp_visitor";

export interface Visitor {
  id: string;
  name: string;
}

/** What a request (or WebSocket) presents: a signed-in user, a share-link token, an anonymous visitor. */
export interface Credentials {
  user: User | null;
  shareToken: string | null;
  visitor: Visitor | null;
}

/** Resolved right to see (and maybe edit) one project. */
export interface ProjectAccess {
  projectId: string;
  canEdit: boolean;
  actor: Actor;
  /** stable per person, for presence: "user:<id>" or "visitor:<id>" */
  key: string;
  /** the share link this access comes from, if any */
  linkId: string | null;
}

/**
 * Decides who may see or edit what (spec §2.4): signed-in viewers and above see every project
 * (editors/admins edit); otherwise a valid, unrevoked share link for that project grants access —
 * authenticated links to any signed-in user (incl. guests), anonymous links to visitors who picked
 * a display name. Collaborative links allow editing.
 */
export class AccessService {
  private readonly linksByHash = new Map<string, ShareLink | null>();

  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  newToken(): { token: string; tokenHash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: this.hashToken(token) };
  }

  hashToken(token: string): string {
    return createHmac("sha256", this.secret).update(`share:${token}`).digest("hex");
  }

  /** The active (unrevoked) link for a token, or null. Cached; call `invalidate` after changes. */
  async link(token: string): Promise<ShareLink | null> {
    if (token.length > 100) return null;
    const hash = this.hashToken(token);
    if (!this.linksByHash.has(hash)) {
      const link = await this.db.shareLink.findUnique({ where: { tokenHash: hash } });
      this.linksByHash.set(hash, link && !link.revokedAt ? link : null);
    }
    return this.linksByHash.get(hash) ?? null;
  }

  invalidate(linkId: string): void {
    for (const [hash, link] of this.linksByHash) if (!link || link.id === linkId) this.linksByHash.delete(hash);
  }

  signVisitor(visitor: Visitor): string {
    const payload = Buffer.from(JSON.stringify(visitor)).toString("base64url");
    return `${payload}.${this.visitorSignature(payload)}`;
  }

  readVisitor(cookie: string | undefined): Visitor | null {
    if (!cookie) return null;
    const [payload, signature] = cookie.split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.visitorSignature(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<Visitor>;
      return typeof value.id === "string" && typeof value.name === "string" ? { id: value.id, name: value.name } : null;
    } catch {
      return null;
    }
  }

  /** Access to `projectId`, or the error explaining why not. */
  async resolve(credentials: Credentials, projectId: string): Promise<ProjectAccess | HttpError> {
    const { user } = credentials;
    const activeUser = user && !user.mustChangePassword ? user : null;
    if (activeUser && activeUser.role !== "guest") {
      return {
        projectId,
        canEdit: activeUser.role === "editor" || activeUser.role === "admin",
        actor: actorOf(activeUser),
        key: `user:${activeUser.id}`,
        linkId: null,
      };
    }
    if (!credentials.shareToken) return user ? new HttpError(403, "forbidden", "You don't have access to this project") : unauthorized();
    const link = await this.link(credentials.shareToken);
    if (!link || link.projectId !== projectId) return notFound("Share link");
    return this.viaLink(link, credentials) ?? new HttpError(403, "forbidden", "You don't have access to this project");
  }

  /** Throws unless the credentials may view (or, with `level: "edit"`, edit) the project. */
  async require(credentials: Credentials, projectId: string, level: "view" | "edit"): Promise<ProjectAccess> {
    const access = await this.resolve(credentials, projectId);
    if (access instanceof HttpError) throw access;
    if (level === "edit" && !access.canEdit) throw new HttpError(403, "forbidden", "You can only view this project");
    return access;
  }

  /** Instance data (team calendar, team members): any signed-in non-guest, or any valid link visitor. */
  async requireInstanceRead(credentials: Credentials): Promise<void> {
    const { user } = credentials;
    if (user && !user.mustChangePassword && user.role !== "guest") return;
    if (!credentials.shareToken) throw user ? new HttpError(403, "forbidden", "You don't have access to this") : unauthorized();
    const link = await this.link(credentials.shareToken);
    if (!link) throw notFound("Share link");
    if (!this.viaLink(link, credentials)) throw new HttpError(403, "forbidden", "You don't have access to this");
  }

  private viaLink(link: ShareLink, { user, visitor }: Credentials): ProjectAccess | null {
    const base = { projectId: link.projectId, canEdit: link.collaboration, linkId: link.id };
    if (link.access === "authenticated") {
      if (!user) throw new HttpError(401, "sign_in_required", "Sign in to open this link");
      if (user.mustChangePassword) throw new HttpError(403, "password_change_required", "Please change your password first");
      return { ...base, actor: actorOf(user), key: `user:${user.id}` };
    }
    if (!visitor) throw new HttpError(401, "visitor_required", "Choose a display name to open this link");
    return { ...base, actor: { userId: null, label: `${visitor.name} (anonymous)`, visitorId: visitor.id }, key: `visitor:${visitor.id}` };
  }

  private visitorSignature(payload: string): string {
    return createHmac("sha256", this.secret).update(`visitor:${payload}`).digest("base64url");
  }
}
