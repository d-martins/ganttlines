import type { LinkKind } from "@ganttlines/engine";

/**
 * A link as a line read from one of its tasks: "this task [starts after] the other task [finished]".
 * Each of the eight lines is one kind and one direction.
 */
export const WHEN_WORDS = ["starts before", "starts after", "ends before", "ends after"] as const;
export const END_WORDS = ["finished", "started"] as const;

export interface LinkLine {
  /** what this task does */
  when: (typeof WHEN_WORDS)[number];
  /** the other task's end it is measured against */
  end: (typeof END_WORDS)[number];
}

export interface LinkShape {
  kind: LinkKind;
  /** this task is the follower (it waits on the other) */
  thisWaits: boolean;
}

const LINES: readonly (LinkLine & LinkShape)[] = [
  { when: "starts after", end: "finished", kind: "FS", thisWaits: true },
  { when: "starts after", end: "started", kind: "SS", thisWaits: true },
  { when: "ends after", end: "finished", kind: "FF", thisWaits: true },
  { when: "ends after", end: "started", kind: "SF", thisWaits: true },
  { when: "ends before", end: "started", kind: "FS", thisWaits: false },
  { when: "starts before", end: "started", kind: "SS", thisWaits: false },
  { when: "ends before", end: "finished", kind: "FF", thisWaits: false },
  { when: "starts before", end: "finished", kind: "SF", thisWaits: false },
];

/** The link a line means. */
export function linkOf({ when, end }: LinkLine): LinkShape {
  const line = LINES.find((candidate) => candidate.when === when && candidate.end === end)!;
  return { kind: line.kind, thisWaits: line.thisWaits };
}

/** The line a link reads as. */
export function lineOf({ kind, thisWaits }: LinkShape): LinkLine {
  const line = LINES.find((candidate) => candidate.kind === kind && candidate.thisWaits === thisWaits)!;
  return { when: line.when, end: line.end };
}
