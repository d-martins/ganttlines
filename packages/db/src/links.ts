import { LINK_KINDS, type Link, type LinkKind } from "@ganttlines/engine";
import type { Link as DbLink } from "../generated/prisma/client";

/** Stored link → engine link. */
export function toEngineLink(link: DbLink): Link {
  if (!(LINK_KINDS as readonly string[]).includes(link.kind)) {
    throw new Error(`Link ${link.predecessorId} -> ${link.followerId} has unknown kind ${link.kind}`);
  }
  return { predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind as LinkKind, lag: link.lag };
}

/** Engine link → stored link. */
export function toDbLink(link: Link, projectId: string): DbLink {
  return { projectId, predecessorId: link.predecessorId, followerId: link.followerId, kind: link.kind, lag: link.lag };
}
