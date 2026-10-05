import type { Comment, Db } from "@ganttlines/db";
import type { RowChange } from "@ganttlines/engine";
import type { BaselineDto, CommentDto, HighlightDto, ProjectDto } from "@ganttlines/protocol";
import type { AccessService } from "../auth/access";
import type { InstanceService } from "../calendar/instance-service";
import type { ClusterEvent, EventBus } from "../cluster/types";
import type { AppliedEvent } from "../projects/project-service";
import { KeyedQueue } from "../queue";
import { sessionDigest, type Hub } from "./hub";
import type { Presence } from "./presence";

/** Close code asking browsers to reconnect (and catch up): "service restart". */
export const CLOSE_RECONNECT = 1012;

/** Where `Live` re-reads what other copies only name. */
export interface LiveSources {
  db: Db;
  instance: InstanceService;
  access: AccessService;
  highlights(projectId: string): Promise<HighlightDto[]>;
  baselines(projectId: string): Promise<BaselineDto[]>;
  /** a comment as `viewerKey` sees it ("is it mine?") */
  comment(comment: Comment, viewerKey: string | null): CommentDto;
}

/**
 * What a copy tells its browsers, told to every copy: each method acts on this copy's connections
 * and publishes the event; events from other copies are relayed to this copy's connections (large
 * data is re-read from the database). In single mode the bus goes nowhere.
 */
export class Live {
  /** remote patches per project, relayed one at a time so browsers get versions in order */
  private readonly relays = new KeyedQueue();

  constructor(
    private readonly hub: Hub,
    private readonly bus: EventBus,
    private readonly presence: Presence,
    private readonly sources: LiveSources,
    log: (message: string, error?: unknown) => void,
  ) {
    bus.subscribe((event, from) => void this.receive(event, from).catch((error: unknown) => log(`cluster: relaying "${event.type}" failed`, error)));
    bus.onResync(() => {
      presence.reset();
      sources.instance.invalidate();
      sources.access.invalidate("*");
      hub.closeAll(CLOSE_RECONNECT, "Reconnect");
    });
  }

  /** A board change: other copies were told by the change's own transaction (see ProjectService). */
  patch({ projectId, version, commandId, actor, changes }: AppliedEvent): void {
    this.hub.broadcast(projectId, { type: "patch", projectId, version, commandId, actor: { userId: actor.userId, label: actor.label }, changes });
  }

  projectMeta(project: ProjectDto): void {
    this.hub.broadcast(project.id, { type: "project", project });
    void this.bus.publish({ type: "project", project });
  }

  instanceChanged(version: number): void {
    this.hub.broadcastAll({ type: "instance", version });
    void this.bus.publish({ type: "instance", version });
  }

  comment(comment: Comment): void {
    this.relayComment(comment);
    void this.bus.publish({ type: "comment", commentId: comment.id });
  }

  /** Lists are re-read and sent one at a time per project (here and when relayed), so the last one sent is the latest. */
  async highlights(projectId: string): Promise<void> {
    await this.relays.run(`highlights:${projectId}`, async () => {
      this.hub.broadcast(projectId, { type: "highlights", projectId, highlights: await this.sources.highlights(projectId) });
    });
    void this.bus.publish({ type: "highlights", projectId });
  }

  async baselines(projectId: string): Promise<void> {
    await this.relays.run(`baselines:${projectId}`, async () => {
      this.hub.broadcast(projectId, { type: "baselines", projectId, baselines: await this.sources.baselines(projectId) });
    });
    void this.bus.publish({ type: "baselines", projectId });
  }

  /** Closes a user's live connections everywhere (optionally keeping one session's). */
  closeUser(userId: string, exceptSessionToken?: string | null): void {
    const except = exceptSessionToken ? sessionDigest(exceptSessionToken) : null;
    this.hub.closeUserExceptDigest(userId, except);
    void this.bus.publish({ type: "closeUser", userId, exceptSession: except });
  }

  closeSession(sessionToken: string): void {
    const session = sessionDigest(sessionToken);
    this.hub.closeSessionDigest(session);
    void this.bus.publish({ type: "closeSession", session });
  }

  /** A link was revoked: cached copies are dropped and its connections closed, everywhere. */
  closeLink(linkId: string): void {
    this.sources.access.invalidate(linkId);
    this.hub.closeLink(linkId);
    void this.bus.publish({ type: "closeLink", linkId });
  }

  /** A link's settings changed: cached copies are dropped everywhere. */
  linkChanged(linkId: string): void {
    this.sources.access.invalidate(linkId);
    void this.bus.publish({ type: "linkChanged", linkId });
  }

  projectDeleted(projectId: string): void {
    this.sources.access.forgetProject(projectId);
    this.hub.closeProject(projectId);
    void this.bus.publish({ type: "projectDeleted", projectId });
  }

  private relayComment(comment: Comment): void {
    this.hub.broadcastEach(comment.projectId, (connection) => ({
      type: "comment",
      projectId: comment.projectId,
      comment: this.sources.comment(comment, connection.viewer?.id ?? null),
    }));
  }

  private async receive(event: ClusterEvent, from: string): Promise<void> {
    const { hub, sources } = this;
    switch (event.type) {
      case "patch":
        return this.relays.run(event.projectId, async () => {
          if (hub.roomSize(event.projectId) === 0) return;
          const entry = await sources.db.commandLog.findUnique({ where: { projectId_version: { projectId: event.projectId, version: event.version } } });
          if (!entry) return hub.broadcast(event.projectId, { type: "reload", projectId: event.projectId });
          hub.broadcast(event.projectId, {
            type: "patch",
            projectId: event.projectId,
            version: entry.version,
            commandId: entry.commandId,
            actor: { userId: entry.actorUserId, label: entry.actorLabel },
            changes: entry.changes as unknown as RowChange[],
          });
        });
      case "project":
        return hub.broadcast(event.project.id, { type: "project", project: event.project });
      case "instance":
        sources.instance.invalidate();
        return hub.broadcastAll({ type: "instance", version: event.version });
      case "comment": {
        const comment = await sources.db.comment.findUnique({ where: { id: event.commentId } });
        if (comment) this.relayComment(comment);
        return;
      }
      case "highlights":
        return this.relays.run(`highlights:${event.projectId}`, async () => {
          if (hub.roomSize(event.projectId) > 0) hub.broadcast(event.projectId, { type: "highlights", projectId: event.projectId, highlights: await sources.highlights(event.projectId) });
        });
      case "baselines":
        return this.relays.run(`baselines:${event.projectId}`, async () => {
          if (hub.roomSize(event.projectId) > 0) hub.broadcast(event.projectId, { type: "baselines", projectId: event.projectId, baselines: await sources.baselines(event.projectId) });
        });
      case "closeUser":
        return hub.closeUserExceptDigest(event.userId, event.exceptSession);
      case "closeSession":
        return hub.closeSessionDigest(event.session);
      case "closeLink":
        sources.access.invalidate(event.linkId);
        return hub.closeLink(event.linkId);
      case "linkChanged":
        return sources.access.invalidate(event.linkId);
      case "projectDeleted":
        sources.access.forgetProject(event.projectId);
        return hub.closeProject(event.projectId);
      case "presence":
      case "rooms":
      case "alive":
      case "bye":
        return this.presence.receive(event, from);
    }
  }
}
