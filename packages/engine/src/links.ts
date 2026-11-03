import type { Change, LinkChange } from "./changes";
import type { ProjectState, Row, RowId } from "./model";
import { hasAncestor } from "./tree";

/**
 * FS: starts after the predecessor finishes; SS: starts once it starts; FF: can't finish before it
 * finishes; SF: can't finish before it starts.
 */
export type LinkKind = "FS" | "SS" | "FF" | "SF";
export const LINK_KINDS: readonly LinkKind[] = ["FS", "SS", "FF", "SF"];
/** Each kind in the words people see. */
export const LINK_KIND_WORDS: Readonly<Record<LinkKind, string>> = {
  FS: "after it finishes",
  SS: "once it starts",
  FF: "can't finish before it",
  SF: "can't finish before it starts",
};

/** Kinds that hold back the follower's end rather than its start: onto a parent, they stretch it. */
export const isFinishLink = (kind: LinkKind): boolean => kind === "FF" || kind === "SF";

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
  const isAncestor = (ancestorId: RowId, id: RowId) => hasAncestor((rowId) => byId.get(rowId), byId.size, ancestorId, id);
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

/** A link whose kind changed: logged as a delete of the old kind and a create of the new one. */
export interface LinkKindChange {
  /** the link as it is now */
  link: Link;
  fromKind: LinkKind;
  toKind: LinkKind;
}

export const isLinkKindChange = (change: Change | LinkKindChange): change is LinkKindChange => "toKind" in change;

/**
 * The changes of one history entry with each whole-link delete and create of the same two tasks
 * read as one kind change (where the first of the two was); everything else passes through.
 */
export function pairKindChanges(changes: readonly Change[]): (Change | LinkKindChange)[] {
  // A whole-link create (`created`) or delete.
  const isWhole = (change: Change, created: boolean): change is LinkChange =>
    "link" in change && change.field === "*" && (created ? change.before === null : change.after === null) && change.before !== change.after;
  const used = new Set<number>();
  const result: (Change | LinkKindChange)[] = [];
  for (const [index, change] of changes.entries()) {
    if (used.has(index)) continue;
    const created = isWhole(change, true);
    if (created || isWhole(change, false)) {
      const { link } = change as LinkChange;
      const match = changes.findIndex(
        (other, at) =>
          at > index &&
          !used.has(at) &&
          isWhole(other, !created) &&
          other.link.predecessorId === link.predecessorId &&
          other.link.followerId === link.followerId &&
          other.link.kind !== link.kind,
      );
      if (match >= 0) {
        used.add(match);
        const [removed, added] = (created ? [changes[match], change] : [change, changes[match]]) as [LinkChange, LinkChange];
        result.push({ link: added.after as Link, fromKind: removed.link.kind, toKind: added.link.kind });
        continue;
      }
    }
    result.push(change);
  }
  return result;
}
