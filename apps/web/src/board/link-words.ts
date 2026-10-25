/** Words for a link's delay, shared by the links panel and the history. */

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** A delay on its own: "2 days", "overlapping 1 day". */
export const lagWords = (lag: number) => (lag < 0 ? `overlapping ${days(-lag)}` : days(lag));

/** A link's delay after its kind: ", 2 days later", ", overlapping 1 day", or nothing. */
export function delayWords(lag: number): string {
  return lag > 0 ? `, ${days(lag)} later` : lag < 0 ? `, overlapping ${days(-lag)}` : "";
}
