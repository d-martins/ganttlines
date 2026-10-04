import type { Db, ShareLink, User } from "@ganttlines/db";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { actorOf, type Actor } from "../actor";
import { HttpError, notFound, unauthorized } from "../errors";
import { pendingStepError, type PendingStep } from "./guard";

export const VISITOR_COOKIE = "gp_visitor";

export interface Visitor {
  id: string;
  name: string;
}

/** What a request (or WebSocket) presents: a signed-in user, a share-link token, an anonymous visitor. */
export interface Credentials {
  user: User | null;
  /** the user must change their password or set up two-factor before anything else */
  pendingStep: PendingStep | null;
  shareToken: string | null;
  visitor: Visitor | null;
}

/** Resolved right to see (and maybe edit) one project. */
export interface ProjectAccess {
  projectId: string;
  canEdit: boolean;
  /** signed-in users can always comment; link visitors only on collaborative links */
  canComment: boolean;
  actor: Actor;
  /** stable per person, for presence: "user:<id>" or "visitor:<id>" */
  key: string;
  /** the share link this access comes from, if any */
  linkId: string | null;
}

/**
 * Decides who may see or edit what: signed-in viewers and above see every project
 * (editors/admins edit); otherwise a valid, unrevoked share link for that project grants access —
 * authenticated links to any signed-in user (incl. guests), anonymous links to visitors who picked
 * a display name. Collaborative links allow editing.
 */
/** Cached link rows (active or revoked; unknown tokens are not cached). */
const MAX_CACHED_LINKS = 10_000;

export class AccessService {
  private readonly linksByHash = new Map<string, Promise<ShareLink | null>>();
  /** projects known to exist (projects are never deleted, so positives can be cached) */
  private readonly knownProjects = new Set<string>();

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

  /** The active (unrevoked) link for a token, or null. */
  async link(token: string): Promise<ShareLink | null> {
    const link = await this.find(token);
    return link && !link.revokedAt ? link : null;
  }

  /**
   * The stored link for a token, revoked or not (null if unknown). Lookups are cached as promises,
   * and `invalidate` drops them, so a lookup that was in flight during a revoke is never cached.
   */
  find(token: string): Promise<ShareLink | null> {
    if (token.length > 100) return Promise.resolve(null);
    const hash = this.hashToken(token);
    let lookup = this.linksByHash.get(hash);
    if (!lookup) {
      if (this.linksByHash.size >= MAX_CACHED_LINKS) this.linksByHash.clear();
      const pending = this.db.shareLink.findUnique({ where: { tokenHash: hash } });
      lookup = pending;
      this.linksByHash.set(hash, pending);
      pending.then(
        (link) => {
          if (!link && this.linksByHash.get(hash) === pending) this.linksByHash.delete(hash);
        },
        () => {
          if (this.linksByHash.get(hash) === pending) this.linksByHash.delete(hash);
        },
      );
    }
    return lookup;
  }

  /** Call after a project is deleted: forget it and its (cascade-deleted) links. */
  forgetProject(projectId: string): void {
    this.knownProjects.delete(projectId);
    this.linksByHash.clear();
  }

  /** Call after a link changes or is revoked. */
  invalidate(_linkId: string): void {
    this.linksByHash.clear();
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
    const link = credentials.shareToken ? await this.find(credentials.shareToken) : null;
    if (credentials.shareToken) {
      if (!link || link.projectId !== projectId) return notFound("Share link");
      if (link.revokedAt) return new HttpError(410, "link_revoked", "This share link was turned off");
    }
    if (user && !credentials.pendingStep && user.role !== "guest") {
      if (!(await this.projectExists(projectId))) return notFound("Project");
      const byRole = user.role === "editor" || user.role === "admin";
      // A collaborative link lets any signed-in user who opens it edit, like it does for guests.
      const byLink = link?.collaboration === true;
      const linkId = byRole ? null : (link?.id ?? null);
      return {
        projectId,
        canEdit: byRole || byLink,
        canComment: true,
        actor: { ...actorOf(user), linkId },
        key: `user:${user.id}`,
        linkId,
      };
    }
    if (!link) {
      if (user && credentials.pendingStep) return pendingStepError(credentials.pendingStep);
      return user ? new HttpError(403, "forbidden", "You don't have access to this project") : unauthorized();
    }
    return this.viaLink(link, credentials) ?? new HttpError(403, "forbidden", "You don't have access to this project");
  }

  private async projectExists(projectId: string): Promise<boolean> {
    if (this.knownProjects.has(projectId)) return true;
    const found = await this.db.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (found) this.knownProjects.add(projectId);
    return found !== null;
  }

  /** Throws unless the credentials may view (or, with `level: "edit"`, edit) the project. */
  async require(credentials: Credentials, projectId: string, level: "view" | "edit"): Promise<ProjectAccess> {
    const access = await this.resolve(credentials, projectId);
    if (access instanceof HttpError) throw access;
    if (level === "edit" && !access.canEdit) throw new HttpError(403, "forbidden", "You can only view this project");
    return access;
  }

  /**
   * Instance data (team calendar, team members): any signed-in non-guest ("member"), or any valid
   * link visitor ("link" — callers must hide personal details such as time-off notes).
   */
  async requireInstanceRead(credentials: Credentials): Promise<"member" | "link"> {
    const { user } = credentials;
    if (user && !credentials.pendingStep && user.role !== "guest") return "member";
    if (!credentials.shareToken) {
      if (user && credentials.pendingStep) throw pendingStepError(credentials.pendingStep);
      throw user ? new HttpError(403, "forbidden", "You don't have access to this") : unauthorized();
    }
    const link = await this.find(credentials.shareToken);
    if (!link) throw notFound("Share link");
    if (link.revokedAt) throw new HttpError(410, "link_revoked", "This share link was turned off");
    if (!this.viaLink(link, credentials)) throw new HttpError(403, "forbidden", "You don't have access to this");
    return "link";
  }

  private viaLink(link: ShareLink, { user, pendingStep, visitor }: Credentials): ProjectAccess | null {
    const base = { projectId: link.projectId, canEdit: link.collaboration, canComment: link.collaboration, linkId: link.id };
    if (link.access === "authenticated") {
      if (!user) throw new HttpError(401, "sign_in_required", "Sign in to open this link");
      if (pendingStep) throw pendingStepError(pendingStep);
      return { ...base, actor: { ...actorOf(user), linkId: link.id }, key: `user:${user.id}` };
    }
    if (!visitor) throw new HttpError(401, "visitor_required", "Choose a display name to open this link");
    return {
      ...base,
      actor: { userId: null, label: `${visitor.name} (anonymous)`, visitorId: visitor.id, linkId: link.id },
      key: `visitor:${visitor.id}`,
    };
  }

  private visitorSignature(payload: string): string {
    return createHmac("sha256", this.secret).update(`visitor:${payload}`).digest("base64url");
  }
}
