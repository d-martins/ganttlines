import { effectiveTarget, isValidTarget, tagKey, type Link, type ProjectState, type Row, type RowId } from "@ganttlines/engine";
import type { BoardSearch } from "../router";

/** What the board is narrowed to. OR within one filter, AND across them; an empty one is off. */
export interface BoardFilters {
  /** title search, case-insensitive */
  q: string;
  /** resource ids; "none" = unassigned */
  people: (string | "none")[];
  tags: string[];
  /** section ids: each shows with what's anywhere under it */
  sections: RowId[];
  /** milestone ids: what aims for each, and what feeds that */
  milestones: RowId[];
}

export const NO_FILTERS: BoardFilters = { q: "", people: [], tags: [], sections: [], milestones: [] };

/** Whether these filters narrow anything; for what a board really filters by, pass them through knownFilters. */
export function isFiltering(f: BoardFilters): boolean {
  return f.q.trim() !== "" || f.people.length > 0 || f.tags.some((tag) => tagKey(tag) !== "") || f.sections.length > 0 || f.milestones.length > 0;
}

/**
 * The filters with the people and sections this board doesn't know left out (people are known from
 * `team` when given, else from this board's tasks), so a link naming them never empties the board.
 * Tags are text: one nobody here uses still filters (to nothing), so it never drops out.
 */
export function knownFilters(state: ProjectState, f: BoardFilters, team?: ReadonlySet<string>): BoardFilters {
  const knownPeople = team ?? new Set(Object.values(state.rows).flatMap((row) => (row.kind === "task" && row.resourceId !== null ? [row.resourceId] : [])));
  return {
    q: f.q,
    people: f.people.filter((id) => id === "none" || knownPeople.has(id)),
    tags: f.tags,
    sections: f.sections.filter((id) => state.rows[id]?.kind === "section"),
    milestones: f.milestones.filter((id) => isValidTarget(state, id)),
  };
}

/**
 * What a milestone filter finds: the milestones, the tasks aiming for them (subtasks inherit a parent's
 * target unless they have their own), and any task with a chain of links leading to one of those, as
 * those can make it miss too.
 */
function towardsMilestones(state: ProjectState, milestones: ReadonlySet<RowId>): Set<RowId> {
  const rows = Object.values(state.rows);
  const heads = new Map<RowId, Link[]>();
  for (const link of Object.values(state.links)) heads.set(link.followerId, [...(heads.get(link.followerId) ?? []), link]);
  const kids = new Map<RowId, RowId[]>();
  for (const row of rows) if (row.parentId !== null) kids.set(row.parentId, [...(kids.get(row.parentId) ?? []), row.id]);
  const aiming = (row: Readonly<Row>) => {
    const target = effectiveTarget(state, row as Row);
    return target !== null && milestones.has(target);
  };
  const found = new Set<RowId>();
  const waiting: RowId[] = [];
  const add = (id: RowId) => {
    if (found.has(id)) return;
    found.add(id);
    waiting.push(id);
  };
  for (const row of rows) if (row.kind === "task" && (milestones.has(row.id) || aiming(row))) add(row.id);
  // Bounded by `found`: each row is walked once, so a loop can't run forever.
  while (waiting.length > 0) {
    const id = waiting.pop()!;
    // A link into a parent holds back everything under it, too.
    let steps = rows.length;
    for (let up: Readonly<Row> | undefined = state.rows[id]; up && steps > 0; up = up.parentId === null ? undefined : state.rows[up.parentId], steps--) {
      for (const link of heads.get(up.id) ?? []) {
        const feeders = [link.predecessorId];
        while (feeders.length > 0) {
          const feeder = feeders.pop()!;
          const row = state.rows[feeder];
          // A subtask with a target of its own answers to that one.
          if (row?.kind === "task" && (feeder === link.predecessorId || row.targetId === null || milestones.has(row.targetId))) add(feeder);
          feeders.push(...(kids.get(feeder) ?? []));
        }
      }
    }
  }
  return found;
}

/**
 * Rows that match, plus the ancestors shown as context; null when not filtering (see knownFilters).
 * A section whose title the search finds, or that the section filter names, matches, and every row in
 * it passes that filter too; the other filters still pick among those rows (people and tags only ever
 * pick tasks), so a named section shows even with nothing in it left. Rows in `keep` count as matches
 * too (rows kept on screen after they stopped).
 */
export function filterRows(
  state: ProjectState,
  f: BoardFilters,
  team?: ReadonlySet<string>,
  keep?: ReadonlySet<RowId>,
): { matches: Set<RowId>; context: Set<RowId> } | null {
  const rows = Object.values(state.rows);
  const known = knownFilters(state, f, team);
  const needle = known.q.trim().toLocaleLowerCase();
  const people = new Set(known.people);
  const tags = new Set(known.tags.map(tagKey).filter((key) => key !== ""));
  const sections = new Set(known.sections);
  const milestones = new Set(known.milestones);
  if (!needle && people.size === 0 && tags.size === 0 && sections.size === 0 && milestones.size === 0) return null;
  const towards = milestones.size > 0 ? towardsMilestones(state, milestones) : null;

  const limit = rows.length;
  /** ancestors, nearest first (bounded, in case stored rows loop) */
  const ancestors = (row: Readonly<Row>): Readonly<Row>[] => {
    const found: Readonly<Row>[] = [];
    let parent = row.parentId === null ? undefined : state.rows[row.parentId];
    for (let steps = limit; parent && steps > 0; steps--) {
      found.push(parent);
      parent = parent.parentId === null ? undefined : state.rows[parent.parentId];
    }
    return found;
  };
  const found = (row: Readonly<Row>) => row.title.toLocaleLowerCase().includes(needle);
  const matches = new Set<RowId>();
  for (const row of rows) {
    const above = ancestors(row);
    const named = row.kind === "section" && ((needle !== "" && found(row)) || sections.has(row.id));
    if (needle && !found(row) && !above.some((up) => up.kind === "section" && found(up))) continue;
    if (sections.size > 0 && !sections.has(row.id) && !above.some((up) => sections.has(up.id))) continue;
    if (row.kind === "task") {
      if (people.size > 0 && !people.has(row.resourceId ?? "none")) continue;
      if (tags.size > 0 && !row.tags.some((tag) => tags.has(tagKey(tag)))) continue;
      if (towards && !towards.has(row.id)) continue;
    } else if (!named && (people.size > 0 || tags.size > 0 || towards)) continue;
    matches.add(row.id);
  }
  for (const id of keep ?? []) if (state.rows[id]) matches.add(id);
  const context = new Set<RowId>();
  for (const id of matches) {
    for (const above of ancestors(state.rows[id]!)) if (!matches.has(above.id)) context.add(above.id);
  }
  return { matches, context };
}

export function filtersFromSearch(search: BoardSearch): BoardFilters {
  return { q: search.q ?? "", people: search.people ?? [], tags: search.tags ?? [], sections: search.sections ?? [], milestones: search.milestones ?? [] };
}

/** The address's part for these filters: empty ones are left out. */
export function searchFromFilters(f: BoardFilters): Pick<BoardSearch, "q" | "people" | "tags" | "sections" | "milestones"> {
  return {
    ...(f.q.trim() ? { q: f.q } : {}),
    ...(f.people.length > 0 ? { people: f.people } : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
    ...(f.sections.length > 0 ? { sections: f.sections } : {}),
    ...(f.milestones.length > 0 ? { milestones: f.milestones } : {}),
  };
}

/** `search` with its filters replaced by `f` (the baseline and the rest are kept). */
export function withFilters(search: BoardSearch, f: BoardFilters): BoardSearch {
  const { q: _q, people: _people, tags: _tags, sections: _sections, milestones: _milestones, ...rest } = search;
  return { ...rest, ...searchFromFilters(f) };
}

/** Whether the tag filter includes `tag` (in any spelling). */
export const hasTag = (f: BoardFilters, tag: string): boolean => f.tags.some((entry) => tagKey(entry) === tagKey(tag));

/** The filters with `tag` added to the tag filter, or taken out when it's there (in any spelling). */
export function toggleTag(f: BoardFilters, tag: string): BoardFilters {
  return { ...f, tags: hasTag(f, tag) ? f.tags.filter((entry) => tagKey(entry) !== tagKey(tag)) : [...f.tags, tag] };
}
