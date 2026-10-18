import type { ProjectState, Row, RowId } from "./model";

/** FS: starts after the predecessor finishes; SS: starts once it starts; FF: can't finish before it finishes. */
export type LinkKind = "FS" | "SS" | "FF";
export const LINK_KINDS: readonly LinkKind[] = ["FS", "SS", "FF"];

/** What identifies a link: several links may join the same two tasks, one per kind. */
export interface LinkRef {
  predecessorId: RowId;
  followerId: RowId;
  kind: LinkKind;
}

export interface Link extends LinkRef {
  /** Working days (half-day steps) of delay; only FS may be negative (overlap). */
  lag: number;
}

export type LinkKey = string;

export function linkKey(ref: LinkRef): LinkKey {
  return `${ref.followerId}|${ref.predecessorId}|${ref.kind}`;
}

export const MAX_LINKS_PER_TASK = 50;
export const MAX_LAG = 3660;

function sortedByKey(links: Link[]): Link[] {
  return links
    .map((link) => [linkKey(link), link] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, link]) => link);
}

/** The links the task follows, ordered by key. */
export function linksInto(state: ProjectState, followerId: RowId): Link[] {
  return sortedByKey(Object.values(state.links ?? {}).filter((link) => link.followerId === followerId));
}

/** The links that follow the task, ordered by key. */
export function linksOutOf(state: ProjectState, predecessorId: RowId): Link[] {
  return sortedByKey(Object.values(state.links ?? {}).filter((link) => link.predecessorId === predecessorId));
}

/**
 * Links join two different tasks of the same project, never a task and one of its ancestors or
 * descendants; lags are whole or half days within MAX_LAG, negative only for FS; a task follows
 * at most MAX_LINKS_PER_TASK links.
 */
export function findLinkProblem(rows: readonly Row[], links: readonly Link[]): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  // Bounded by the row count so corrupted parent links can never loop forever.
  const isAncestor = (ancestorId: RowId, id: RowId): boolean => {
    let current = byId.get(id)?.parentId ?? null;
    for (let steps = byId.size; current !== null && steps > 0; steps--) {
      if (current === ancestorId) return true;
      current = byId.get(current)?.parentId ?? null;
    }
    return false;
  };
  const into = new Map<RowId, number>();
  for (const link of links) {
    const name = linkKey(link);
    if (!LINK_KINDS.includes(link.kind)) return `link ${name} has an unknown kind`;
    for (const id of [link.predecessorId, link.followerId]) {
      const row = byId.get(id);
      if (!row) return `link ${name} has a missing task ${id}`;
      if (row.kind !== "task") return `link ${name} joins section ${id}`;
    }
    if (link.predecessorId === link.followerId) return `link ${name} joins a task to itself`;
    if (isAncestor(link.predecessorId, link.followerId) || isAncestor(link.followerId, link.predecessorId)) {
      return `link ${name} joins a task to its own parent or subtask`;
    }
    const { lag } = link;
    if (typeof lag !== "number" || !Number.isInteger(lag * 2) || Math.abs(lag) > MAX_LAG || (link.kind !== "FS" && lag < 0)) {
      return `link ${name} has an invalid lag ${lag}`;
    }
    const count = (into.get(link.followerId) ?? 0) + 1;
    if (count > MAX_LINKS_PER_TASK) return `task ${link.followerId} follows more than ${MAX_LINKS_PER_TASK} links`;
    into.set(link.followerId, count);
  }
  return null;
}
