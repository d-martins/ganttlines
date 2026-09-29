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

/** The project as an outline: depth-first by position, numbered 1…n. */
export function outline(state: ProjectState): Outline {
  const tree = buildTree(state);
  const visible: ListRow[] = [];
  const numbers = new Map<RowId, number>();
  const visit = (parentId: RowId | null, depth: number, hidden: boolean) => {
    for (const row of childrenOf(tree, parentId)) {
      numbers.set(row.id, numbers.size + 1);
      const hasChildren = childrenOf(tree, row.id).length > 0;
      if (!hidden) visible.push({ row, number: numbers.size, depth, hasChildren, isParent: isParentTask(tree, row) });
      visit(row.id, depth + 1, hidden || row.collapsed);
    }
  };
  visit(null, 0, false);
  return { visible, numbers };
}
