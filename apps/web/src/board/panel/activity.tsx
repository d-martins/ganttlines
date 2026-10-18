import { isLinkChange, LINK_KIND_WORDS, toDay, type Change, type LinkChange, type ProjectState, type RowId } from "@ganttlines/engine";
import type { ActivityEntryDto, ResourceDto } from "@ganttlines/protocol";
import { useInfiniteQuery } from "@tanstack/react-query";
import { errorMessage } from "../../api/client";
import { rowActivity } from "../../api/queries";
import { Button } from "../../ui/button";
import { formatDay, fullTime, timeAgo } from "../format";

interface Names {
  state: ProjectState;
  resources: ReadonlyMap<string, ResourceDto>;
}

const quote = (text: unknown) => `“${typeof text === "string" && text ? text : "Untitled"}”`;
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** A link's delay after its kind: ", 2 days later", ", overlapping 1 day", or nothing. */
export function delayWords(lag: number): string {
  return lag > 0 ? `, ${days(lag)} later` : lag < 0 ? `, overlapping ${days(-lag)}` : "";
}

/** A link change as seen from one of its two tasks (`rowId`); null to leave out. */
function describeLinkChange({ link, field, after }: LinkChange, names: Names, rowId: RowId): string | null {
  const asFollower = link.followerId === rowId;
  if (!asFollower && link.predecessorId !== rowId) return null;
  const otherRow = names.state.rows[asFollower ? link.predecessorId : link.followerId];
  const other = otherRow ? quote(otherRow.title) : "a deleted task";
  if (field === "lag") return asFollower && typeof after === "number" ? `changed the delay after ${other} to ${days(after)}` : null;
  if (after === null) return asFollower ? `no longer waits on ${other}` : `${other} no longer waits on it`;
  const phrase = LINK_KIND_WORDS[link.kind];
  if (!asFollower) return `${other} now waits on it, ${phrase}`;
  const lag = typeof after === "object" ? after.lag : 0;
  return `now waits on ${other}, ${phrase}${delayWords(lag)}`;
}

/**
 * One stored change, as a phrase seen from the row `rowId` ("renamed it to “Hooks”", "now waits on
 * “Design”, after it finishes"); null to leave out.
 */
export function describeChange(change: Change, names: Names, rowId: RowId): string | null {
  if (isLinkChange(change)) return describeLinkChange(change, names, rowId);
  const { field, before, after } = change;
  switch (field) {
    case "*":
      return before === null ? "created it" : after === null ? "deleted it" : "replaced it";
    case "title":
      return `renamed it to ${quote(after)}`;
    case "userStart":
      return typeof after === "string" ? `scheduled it for ${formatDay(toDay(after))}` : "unscheduled it";
    case "duration":
      if (after === 0) return "made it a milestone";
      if (before === 0) return `made it a task of ${String(after)} working days`;
      return `set it to ${String(after)} working ${after === 1 ? "day" : "days"}`;
    case "resourceId":
      return typeof after === "string" ? `assigned it to ${names.resources.get(after)?.name ?? "someone"}` : "unassigned it";
    case "color":
      return `colored it ${String(after)}`;
    case "locked":
      return after ? "locked its dates" : "unlocked its dates";
    case "predecessorId": // (older history: a task used to have one predecessor)
      return typeof after === "string" ? `made it follow ${names.state.rows[after] ? quote(names.state.rows[after]!.title) : "a deleted task"}` : "removed its predecessor";
    case "offset":
      return null; // (older history) offsets weren't shown anywhere (dragging a linked task recorded them)
    case "description":
      return "edited the description";
    case "actualDuration":
      return typeof after === "number" ? `recorded ${String(after)} actual work ${after === 1 ? "day" : "days"}` : "cleared its actual work days";
    case "parentId":
    case "position":
      return "moved it in the list";
    case "collapsed": // (older history: collapsing used to be stored)
      return null;
    default:
      return `changed ${field}`;
  }
}

/** What an entry did to this row, e.g. "moved it in the list, renamed it to “Hooks”". */
export function describeEntry(entry: ActivityEntryDto, names: Names, rowId: RowId): string {
  const phrases = [...new Set(entry.changes.map((change) => describeChange(change, names, rowId)).filter((phrase): phrase is string => phrase !== null))];
  const what = phrases.join(", ") || "changed it";
  return entry.name === "undo" ? `undid a change (${what})` : entry.name === "redo" ? `redid a change (${what})` : what;
}

/** A row's history: who changed what and when, newest first. */
export function Activity({ projectId, rowId, names }: { projectId: string; rowId: string; names: Names }) {
  const query = useInfiniteQuery(rowActivity(projectId, rowId));
  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.error) return <p className="text-sm text-danger">{errorMessage(query.error)}</p>;
  const entries = query.data.pages.flatMap((page) => page.entries);
  if (entries.length === 0) return <p className="text-sm text-muted">No changes yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2 text-sm">
        {entries.map((entry) => (
          <li key={entry.version}>
            <span className="font-medium">{entry.actor.label}</span>
            {entry.actor.linkId ? <span className="text-muted"> via share link</span> : null} {describeEntry(entry, names, rowId)}{" "}
            <time dateTime={entry.createdAt} title={fullTime(entry.createdAt)} className="text-xs text-muted">
              · {timeAgo(entry.createdAt)}
            </time>
          </li>
        ))}
      </ol>
      {query.hasNextPage ? (
        <Button variant="ghost" className="self-start text-xs" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Show older changes
        </Button>
      ) : null}
    </div>
  );
}
