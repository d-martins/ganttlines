import { buildTree, childrenOf, isParentTask, type ProjectState, type Row, type RowId } from "@ganttlines/engine";
import { filterRows, type BoardFilters } from "./filters";

export interface ListRow {
  row: Row;
  /** 1-based number in the full outline (stable when rows above are collapsed) */
  number: number;
  depth: number;
  /** has child rows (shows the collapse chevron) */
  hasChildren: boolean;
  /** a task whose dates roll up from child tasks (drawn as a bracket) */
  isParent: boolean;
  /** its children are hidden in this browser (see collapse.ts); never while filtering */
  collapsed: boolean;
  /** shown only because a filter match is inside it (drawn dimmed) */
  context: boolean;
}

export interface Outline {
  /** rows to show, in order: descendants of collapsed rows are left out */
  visible: ListRow[];
  /** every row's number, including hidden ones */
  numbers: ReadonlyMap<RowId, number>;
}

/**
 * The project as an outline: depth-first by position, numbered 1…n. While `filters` narrow it, only
 * the matching tasks and their ancestors (as context) are shown, and nothing is collapsed.
 */
export function outline(
  state: ProjectState,
  filters?: BoardFilters,
  collapsed: ReadonlySet<RowId> = new Set(),
  /** resource ids of the team, to tell known people in `filters` */
  team?: ReadonlySet<string>,
  /** tasks shown as matches while filtering, even though they no longer match */
  keep?: ReadonlySet<RowId>,
): Outline {
  const tree = buildTree(state);
  const visible: ListRow[] = [];
  const numbers = new Map<RowId, number>();
  const filtered = filters ? filterRows(state, filters, team, keep) : null;
  const visit = (parentId: RowId | null, depth: number, hidden: boolean) => {
    for (const row of childrenOf(tree, parentId)) {
      numbers.set(row.id, numbers.size + 1);
      const hasChildren = childrenOf(tree, row.id).length > 0;
      const context = filtered?.context.has(row.id) ?? false;
      const show = filtered ? context || filtered.matches.has(row.id) : !hidden;
      // While filtering, collapsed rows open (and say so): no match is hidden.
      const isCollapsed = !filtered && hasChildren && collapsed.has(row.id);
      if (show) visible.push({ row, number: numbers.size, depth, hasChildren, isParent: isParentTask(tree, row), collapsed: isCollapsed, context });
      visit(row.id, depth + 1, hidden || isCollapsed);
    }
  };
  visit(null, 0, false);
  return { visible, numbers };
}
