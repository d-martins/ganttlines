import Holidays from "date-holidays";
import { fromDay, toDay } from "@ganttlines/engine";

/**
 * Public holidays per country (and region), from the date-holidays data (code ISC; holiday data
 * CC BY-SA 3.0). Offline: nothing is fetched. Names are in English where the data has them.
 */
export interface PublicHoliday {
  name: string;
  startDate: string;
  endDate: string;
  /** "public" (days off by law), "bank", "optional", "school" or "observance" */
  type: string;
}

const sorted = (names: Record<string, string>) =>
  Object.entries(names)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const countries = () => sorted(new Holidays().getCountries("en"));

export function regions(country: string): { code: string; name: string }[] {
  return sorted(new Holidays().getStates(country, "en") ?? {});
}

export function publicHolidays(country: string, region: string | null, year: number): PublicHoliday[] {
  const calendar = region ? new Holidays(country, region) : new Holidays(country);
  const seen = new Set<string>();
  return calendar.getHolidays(year, "en").flatMap((holiday) => {
    const startDate = holiday.date.slice(0, 10);
    const days = Math.max(1, Math.round((holiday.end.getTime() - holiday.start.getTime()) / 86_400_000));
    const endDate = fromDay(toDay(startDate) + days - 1);
    const key = `${holiday.name}|${startDate}`;
    if (seen.has(key)) return []; // the data sometimes lists a day twice (e.g. substitutes)
    seen.add(key);
    return [{ name: holiday.name, startDate, endDate, type: holiday.type }];
  });
}
