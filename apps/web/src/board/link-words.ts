/** Words for a link's delay, shared by the links panel and the history. */

export const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;


/** A link's delay after its kind: ", 2 days later", ", overlapping 1 day", or nothing. */
export function delayWords(lag: number): string {
  return lag > 0 ? `, ${days(lag)} later` : lag < 0 ? `, overlapping ${days(-lag)}` : "";
}
