import type { ProjectState, Row, RowId, TaskRow } from "./model";

export interface Tree {
  /** Children per parent id (null = root), sorted by position. */
  children: ReadonlyMap<RowId | null, readonly Row[]>;
}

export function buildTree(state: ProjectState): Tree {
  const children = new Map<RowId | null, Row[]>();
  for (const row of Object.values(state.rows)) {
    const siblings = children.get(row.parentId);
    if (siblings) siblings.push(row);
    else children.set(row.parentId, [row]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1));
  }
  return { children };
}

export function childrenOf(tree: Tree, parentId: RowId | null): readonly Row[] {
  return tree.children.get(parentId) ?? [];
}

/** A parent task is a task with at least one child task; its dates roll up from its children. */
export function isParentTask(tree: Tree, row: Row): boolean {
  return row.kind === "task" && childrenOf(tree, row.id).some((child) => child.kind === "task");
}

/** The row and all its descendants, depth first. */
export function subtreeIds(tree: Tree, id: RowId): RowId[] {
  const ids = [id];
  for (const child of childrenOf(tree, id)) ids.push(...subtreeIds(tree, child.id));
  return ids;
}

/** Leaf tasks (tasks without child tasks) in the subtree below `id`, excluding `id` itself. */
export function descendantLeafTasks(tree: Tree, id: RowId): TaskRow[] {
  const leaves: TaskRow[] = [];
  for (const child of childrenOf(tree, id)) {
    if (child.kind === "task" && !isParentTask(tree, child)) leaves.push(child);
    else leaves.push(...descendantLeafTasks(tree, child.id));
  }
  return leaves;
}

export function isAncestor(state: ProjectState, ancestorId: RowId, id: RowId): boolean {
  // Bounded by the row count so corrupted parent links can never loop forever.
  let current = state.rows[id]?.parentId ?? null;
  for (let steps = Object.keys(state.rows).length; current !== null && steps > 0; steps--) {
    if (current === ancestorId) return true;
    current = state.rows[current]?.parentId ?? null;
  }
  return false;
}
