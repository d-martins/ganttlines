import type { Project } from "@ganttlines/db";
import type { ResourceDto } from "@ganttlines/protocol";

/** A problem the AI can fix by asking differently; shown to it as the tool's error. */
export class ToolProblem extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds one item by id or by name: an exact (case-insensitive) name first, then a unique partial
 * match. Unknown or ambiguous names are errors that list the candidates.
 */
export function pickOne<T>(items: readonly T[], ref: string, idOf: (item: T) => string, nameOf: (item: T) => string, kind: string): T {
  const wanted = ref.trim();
  if (UUID.test(wanted)) {
    const byId = items.find((item) => idOf(item) === wanted.toLowerCase());
    if (byId) return byId;
  }
  const lower = wanted.toLocaleLowerCase();
  const exact = items.filter((item) => nameOf(item).toLocaleLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : items.filter((item) => nameOf(item).toLocaleLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  const list = (found: readonly T[]) => found.slice(0, 10).map((item) => `“${nameOf(item)}” (${idOf(item)})`).join(", ");
  if (partial.length > 1) throw new ToolProblem(`More than one ${kind} matches “${wanted}”: ${list(partial)}. Use the id.`);
  throw new ToolProblem(`No ${kind} called “${wanted}”.${items.length ? ` Known: ${list(items)}${items.length > 10 ? " …" : ""}.` : ""}`);
}

export const pickProject = (projects: readonly Project[], ref: string) => pickOne(projects, ref, (p) => p.id, (p) => p.name, "project");
export const pickPerson = (people: readonly ResourceDto[], ref: string) => pickOne(people, ref, (p) => p.id, (p) => p.name, "team member");
