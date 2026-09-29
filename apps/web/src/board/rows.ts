import { buildTree, childrenOf, isParentTask, type ProjectState, type Row, type RowId } from "@ganttlines/engine";

export interface ListRow {
  row: Row;
  /** 1-based number in the full outline (stable when rows above are collapsed) */
  number: number;
  depth: number;
  /** has child rows (shows the collapse chevron) */
  hasChildren: boolean;
  /** a task whose dates roll up from child tasks (drawn as a bracket) */
  isParent: boolean;
}

export interface Outline {
  /** rows to show, in order: descendants of collapsed rows are left out */
  visible: ListRow[];
  /** every row's number, including hidden ones */
  numbers: ReadonlyMap<RowId, number>;
}

/**
 * The project as an outline: depth-first by position, numbered 1…n. With `filter`, only rows that
 * match it and their ancestors are shown, collapsed or not (search).
 */
export function outline(state: ProjectState, filter?: (row: Row) => boolean): Outline {
  const tree = buildTree(state);
  const visible: ListRow[] = [];
  const numbers = new Map<RowId, number>();
  const shown = filter ? matchesWithAncestors(state, filter) : null;
  const visit = (parentId: RowId | null, depth: number, hidden: boolean) => {
    for (const row of childrenOf(tree, parentId)) {
      numbers.set(row.id, numbers.size + 1);
      const hasChildren = childrenOf(tree, row.id).length > 0;
      const show = shown ? shown.has(row.id) : !hidden;
      if (show) visible.push({ row, number: numbers.size, depth, hasChildren, isParent: isParentTask(tree, row) });
      visit(row.id, depth + 1, hidden || row.collapsed);
    }
  };
  visit(null, 0, false);
  return { visible, numbers };
}

function matchesWithAncestors(state: ProjectState, filter: (row: Row) => boolean): Set<RowId> {
  const shown = new Set<RowId>();
  const limit = Object.keys(state.rows).length;
  for (const row of Object.values(state.rows)) {
    if (!filter(row)) continue;
    let current: Row | undefined = row;
    for (let steps = limit; current && !shown.has(current.id) && steps >= 0; steps--) {
      shown.add(current.id);
      current = current.parentId === null ? undefined : state.rows[current.parentId];
    }
  }
  return shown;
}
