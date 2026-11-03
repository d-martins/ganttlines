import { tagKey, type ProjectState, type Row, type RowId } from "@ganttlines/engine";
import type { BoardSearch } from "../router";

/** What the board is narrowed to. OR within one filter, AND across them; an empty one is off. */
export interface BoardFilters {
  /** title search, case-insensitive */
  q: string;
  /** resource ids; "none" = unassigned */
  people: (string | "none")[];
  tags: string[];
  /** section ids: tasks anywhere under one of them */
  sections: RowId[];
}

export const NO_FILTERS: BoardFilters = { q: "", people: [], tags: [], sections: [] };

export function isFiltering(f: BoardFilters): boolean {
  return f.q.trim() !== "" || f.people.length > 0 || f.tags.length > 0 || f.sections.length > 0;
}

/**
 * Rows that match, plus the ancestors shown as context; null when not filtering. Only tasks match.
 * People and sections this board doesn't know are ignored (people are known from `team` when given,
 * else from this board's tasks), so a link naming them never empties the board.
 */
export function filterRows(state: ProjectState, f: BoardFilters, team?: ReadonlySet<string>): { matches: Set<RowId>; context: Set<RowId> } | null {
  const rows = Object.values(state.rows);
  const tasks = rows.filter((row) => row.kind === "task");
  const needle = f.q.trim().toLocaleLowerCase();
  const knownPeople = team ?? new Set(tasks.flatMap((row) => (row.resourceId === null ? [] : [row.resourceId])));
  const people = new Set(f.people.filter((id) => id === "none" || knownPeople.has(id)));
  // Tags are text: one nobody here uses still filters (to nothing), so it never drops out.
  const tags = new Set(f.tags.map(tagKey).filter((key) => key !== ""));
  const sections = new Set(f.sections.filter((id) => state.rows[id]?.kind === "section"));
  if (!needle && people.size === 0 && tags.size === 0 && sections.size === 0) return null;

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
  const matches = new Set<RowId>();
  for (const row of tasks) {
    if (needle && !row.title.toLocaleLowerCase().includes(needle)) continue;
    if (people.size > 0 && !people.has(row.resourceId ?? "none")) continue;
    if (tags.size > 0 && !row.tags.some((tag) => tags.has(tagKey(tag)))) continue;
    if (sections.size > 0 && !ancestors(row).some((above) => sections.has(above.id))) continue;
    matches.add(row.id);
  }
  const context = new Set<RowId>();
  for (const id of matches) {
    for (const above of ancestors(state.rows[id]!)) if (!matches.has(above.id)) context.add(above.id);
  }
  return { matches, context };
}

export function filtersFromSearch(search: BoardSearch): BoardFilters {
  return { q: search.q ?? "", people: search.people ?? [], tags: search.tags ?? [], sections: search.sections ?? [] };
}

/** The address's part for these filters: empty ones are left out. */
export function searchFromFilters(f: BoardFilters): Pick<BoardSearch, "q" | "people" | "tags" | "sections"> {
  return {
    ...(f.q.trim() ? { q: f.q } : {}),
    ...(f.people.length > 0 ? { people: f.people } : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
    ...(f.sections.length > 0 ? { sections: f.sections } : {}),
  };
}
