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

/**
 * Parent links must point to rows of the same project and never loop; sections never sit inside
 * tasks; predecessors must be tasks of the same project.
 */
export function findTreeProblem(rows: readonly Row[]): string | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.kind === "task" && row.predecessorId !== null && byId.get(row.predecessorId)?.kind !== "task") {
      return `task ${row.id} has a missing predecessor ${row.predecessorId}`;
    }
    if (row.parentId === null) continue;
    const parent = byId.get(row.parentId);
    if (!parent) return `row ${row.id} has a missing parent ${row.parentId}`;
    if (row.kind === "section" && parent.kind === "task") return `section ${row.id} is inside task ${parent.id}`;
    const seen = new Set([row.id]);
    for (let current: Row | undefined = parent; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
      if (seen.has(current.id)) return `row ${row.id} is part of a parent loop`;
      seen.add(current.id);
    }
  }
  return null;
}
