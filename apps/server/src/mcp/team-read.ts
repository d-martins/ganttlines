import { z } from "zod";
import { ToolProblem } from "./lookup";
import { answer, guarded, type ToolGroup } from "./tools";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reading the team calendar: who is on the team, and the days off that shape every schedule. */
export const readTeam: ToolGroup = (server, { context }) => {
  server.registerTool(
    "list_team",
    {
      title: "List the team",
      description: "Lists the team members tasks can be assigned to (with their location, and whether they're still active) and the locations.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const [people, { dto }] = await Promise.all([context.instance.resources(), context.instance.current()]);
        const locations = new Map(dto.locations.map((location) => [location.id, location]));
        const members = people.map((person) => ({
          id: person.id,
          name: person.name,
          active: !person.inactive,
          location: person.locationId ? { id: person.locationId, name: locations.get(person.locationId)?.name ?? "Unknown" } : null,
        }));
        return answer(`${members.filter((member) => member.active).length} active team members, ${dto.locations.length} locations.`, {
          members,
          locations: dto.locations,
        });
      }),
  );

  server.registerTool(
    "get_calendar",
    {
      title: "Read the team calendar",
      description:
        "Reads the working weekdays, and the holidays and time off between two dates (default: the next 90 days). Tasks are only scheduled on working days; holidays and time off stretch the tasks of the people they apply to.",
      inputSchema: z.object({
        from: ISO_DATE.optional().describe("first day (default today)"),
        to: ISO_DATE.optional().describe("last day (default 90 days after from; at most a year after it)"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ from, to }) =>
      guarded(async () => {
        const start = from ?? new Date().toISOString().slice(0, 10);
        const end = to ?? new Date(Date.parse(start) + 90 * DAY_MS).toISOString().slice(0, 10);
        if (end < start) throw new ToolProblem("“to” is before “from”.");
        if (Date.parse(end) - Date.parse(start) > 366 * DAY_MS) throw new ToolProblem("Ask for at most a year at a time.");
        const [people, { dto }] = await Promise.all([context.instance.resources(), context.instance.current()]);
        const personName = new Map(people.map((person) => [person.id, person.name]));
        const locationName = new Map(dto.locations.map((location) => [location.id, location.name]));
        const overlaps = (entry: { startDate: string; endDate: string }) => entry.endDate >= start && entry.startDate <= end;
        const holidays = dto.holidays.filter(overlaps).map((holiday) => ({
          name: holiday.name,
          start: holiday.startDate,
          end: holiday.endDate,
          for: holiday.target.all
            ? "everyone"
            : [
                ...holiday.target.locationIds.map((id) => `${locationName.get(id) ?? "Unknown location"} (location)`),
                ...holiday.target.resourceIds.map((id) => personName.get(id) ?? "Unknown"),
              ],
        }));
        const timeOff = dto.timeOff.filter(overlaps).map((entry) => ({
          person: personName.get(entry.resourceId) ?? "Unknown",
          start: entry.startDate,
          end: entry.endDate,
          ...(entry.note ? { note: entry.note } : {}),
        }));
        return answer(`${start} to ${end}: ${holidays.length} holidays, ${timeOff.length} time off.`, {
          from: start,
          to: end,
          workingWeekdays: dto.workingWeekdays.map((day) => WEEKDAY_NAMES[day]),
          holidays,
          timeOff,
        });
      }),
  );
};
