import { CreateResourceBody, HolidayBody, ImportHolidaysBody, LocationBody, TimeOffBody, UpdateResourceBody } from "@ganttlines/protocol";
import { z } from "zod";
import { aiActorOf } from "../actor";
import { publicHolidays } from "@ganttlines/holidays";
import { pickOne, pickPerson, ToolProblem } from "./lookup";
import { answer, guarded, type ToolGroup } from "./tools";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

/** Checks input against the same rules as the web app's; problems go back to the AI to fix. */
function valid<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ToolProblem(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Changing the team calendar: people, locations, holidays and time off. */
export const writeTeam: ToolGroup = (server, { context, caller }) => {
  const { instance, teamEdits } = context;
  const actor = () => aiActorOf(caller.user, caller.app, caller.connectionId);
  const snapshot = async () => {
    const [people, { dto }] = await Promise.all([instance.resources(), instance.current()]);
    return { people, ...dto };
  };
  const pickLocation = (locations: { id: string; name: string }[], ref: string) => pickOne(locations, ref, (l) => l.id, (l) => l.name, "location");

  server.registerTool(
    "add_team_member",
    {
      title: "Add a team member",
      description: "Adds someone tasks can be assigned to (they don't need an account), optionally in a location.",
      inputSchema: z.object({ name: z.string().min(1).max(100), location: z.string().optional().describe("a location's id or name") }),
    },
    ({ name, location }) =>
      guarded(async () => {
        const { locations } = await snapshot();
        const locationId = location ? pickLocation(locations, location).id : null;
        let person = await instance.createResource(actor(), valid(CreateResourceBody, { name }));
        if (locationId) person = await teamEdits.updateResource(actor(), person.id, { locationId });
        return answer(`Added ${person.name} to the team.`, { member: { id: person.id, name: person.name, locationId: person.locationId } });
      }),
  );

  server.registerTool(
    "update_team_member",
    {
      title: "Change a team member",
      description: "Renames a team member, moves them to another location (their holidays follow), or marks them inactive (people who left) or active again.",
      inputSchema: z.object({
        person: z.string().min(1).describe("their id or name"),
        name: z.string().min(1).max(100).optional(),
        location: z.string().nullable().optional().describe("a location's id or name; null for none"),
        active: z.boolean().optional(),
      }),
    },
    ({ person: ref, name, location, active }) =>
      guarded(async () => {
        const { people, locations } = await snapshot();
        const person = pickPerson(people, ref);
        const body = valid(UpdateResourceBody, {
          ...(name ? { name } : {}),
          ...(location === undefined ? {} : { locationId: location === null ? null : pickLocation(locations, location).id }),
          ...(active === undefined ? {} : { inactive: !active }),
        });
        const updated = await teamEdits.updateResource(actor(), person.id, body);
        return answer(`Updated ${updated.name}.`, { member: { id: updated.id, name: updated.name, active: !updated.inactive, locationId: updated.locationId } });
      }),
  );

  server.registerTool(
    "save_location",
    {
      title: "Add or change a location",
      description: "Adds a location (an office or country team members belong to), or changes one when `location` names it. Country (two letters, e.g. PT) and region codes enable import_public_holidays.",
      inputSchema: z.object({
        location: z.string().optional().describe("the location to change (id or name); leave out to add one"),
        name: z.string().min(1).max(100),
        country: z.string().nullable().optional().describe("ISO country code, e.g. PT, DE, US"),
        region: z.string().nullable().optional().describe("region code within the country, e.g. BY (Bavaria)"),
      }),
    },
    ({ location: ref, name, country, region }) =>
      guarded(async () => {
        const body = valid(LocationBody, { name, country: country?.toUpperCase() ?? null, region: region?.toUpperCase() ?? null });
        const saved = ref ? await teamEdits.updateLocation(actor(), pickLocation((await snapshot()).locations, ref).id, body) : await teamEdits.createLocation(actor(), body);
        return answer(`${ref ? "Updated" : "Added"} the location ${saved.name}.`, { location: saved });
      }),
  );

  server.registerTool(
    "save_holiday",
    {
      title: "Add or change a holiday",
      description:
        "Adds a holiday (days off), or changes one when `holiday` names it. It applies to everyone, or only to the given locations and/or people. Tasks of the people it applies to are rescheduled around it.",
      inputSchema: z.object({
        holiday: z.string().optional().describe("the holiday to change (id or name); leave out to add one"),
        name: z.string().min(1).max(100),
        start: ISO_DATE,
        end: ISO_DATE.optional().describe("last day (default: the start day)"),
        locations: z.array(z.string()).optional().describe("only for people in these locations (ids or names)"),
        people: z.array(z.string()).optional().describe("only for these people (ids or names)"),
      }),
    },
    ({ holiday: ref, name, start, end, locations: locationRefs = [], people: personRefs = [] }) =>
      guarded(async () => {
        const { people, locations, holidays } = await snapshot();
        const everyone = locationRefs.length === 0 && personRefs.length === 0;
        const body = valid(HolidayBody, {
          name,
          startDate: start,
          endDate: end ?? start,
          appliesTo: everyone ? "all" : personRefs.map((personRef) => pickPerson(people, personRef).id),
          locationIds: locationRefs.map((locationRef) => pickLocation(locations, locationRef).id),
        });
        const target = ref ? pickOne(holidays, ref, (h) => h.id, (h) => h.name, "holiday") : null;
        const saved = target ? await teamEdits.updateHoliday(actor(), target.id, body) : await teamEdits.createHoliday(actor(), body);
        return answer(`${target ? "Updated" : "Added"} the holiday ${saved.name} (${saved.startDate}${saved.endDate !== saved.startDate ? ` to ${saved.endDate}` : ""}).`, {
          holiday: { id: saved.id, name: saved.name, start: saved.startDate, end: saved.endDate, everyone: saved.target.all },
        });
      }),
  );

  server.registerTool(
    "delete_holiday",
    {
      title: "Delete a holiday",
      inputSchema: z.object({ holiday: z.string().min(1).describe("the holiday's id or name") }),
      annotations: { destructiveHint: true },
    },
    ({ holiday: ref }) =>
      guarded(async () => {
        const holiday = pickOne((await snapshot()).holidays, ref, (h) => h.id, (h) => h.name, "holiday");
        await teamEdits.deleteHoliday(actor(), holiday.id);
        return answer(`Deleted the holiday ${holiday.name} (${holiday.startDate}).`, { deleted: { id: holiday.id, name: holiday.name } });
      }),
  );

  server.registerTool(
    "save_time_off",
    {
      title: "Add or change time off",
      description: "Records someone's time off (vacation, leave …), or changes an entry when `timeOff` gives its id. Their tasks stretch around it.",
      inputSchema: z.object({
        timeOff: z.string().optional().describe("the id of the entry to change; leave out to add one"),
        person: z.string().min(1).describe("their id or name"),
        start: ISO_DATE,
        end: ISO_DATE.optional().describe("last day (default: the start day)"),
        note: z.string().max(500).optional().describe("only visible to the team"),
      }),
    },
    ({ timeOff: id, person: ref, start, end, note }) =>
      guarded(async () => {
        const { people, timeOff } = await snapshot();
        const person = pickPerson(people, ref);
        const body = valid(TimeOffBody, { resourceId: person.id, startDate: start, endDate: end ?? start, note: note ?? "" });
        if (id && !timeOff.some((entry) => entry.id === id)) throw new ToolProblem(`No time off with id ${id}.`);
        const saved = id ? await teamEdits.updateTimeOff(actor(), id, body) : await teamEdits.createTimeOff(actor(), body);
        return answer(`${id ? "Updated" : "Added"} time off for ${person.name}: ${saved.startDate} to ${saved.endDate}.`, {
          timeOff: { id: saved.id, person: person.name, start: saved.startDate, end: saved.endDate },
        });
      }),
  );

  server.registerTool(
    "delete_time_off",
    {
      title: "Delete time off",
      description: "Deletes a time-off entry (find ids with get_calendar… or by person and start day).",
      inputSchema: z.object({
        timeOff: z.string().optional().describe("the entry's id"),
        person: z.string().optional().describe("or: their id or name …"),
        start: ISO_DATE.optional().describe("… and the entry's first day"),
      }),
      annotations: { destructiveHint: true },
    },
    ({ timeOff: id, person: ref, start }) =>
      guarded(async () => {
        const { people, timeOff } = await snapshot();
        const personId = ref ? pickPerson(people, ref).id : null;
        const entry = timeOff.find((candidate) => (id ? candidate.id === id : candidate.resourceId === personId && candidate.startDate === start));
        if (!entry) throw new ToolProblem("No such time off — give its id, or the person and its first day.");
        await teamEdits.deleteTimeOff(actor(), entry.id);
        return answer(`Deleted the time off from ${entry.startDate} to ${entry.endDate}.`, { deleted: { id: entry.id } });
      }),
  );

  server.registerTool(
    "import_public_holidays",
    {
      title: "Add a location's public holidays",
      description: "Adds the official public holidays of a location's country (and region) for a year, from built-in data (check them against official sources). Ones already added are skipped.",
      inputSchema: z.object({
        location: z.string().min(1).describe("the location's id or name (it needs a country)"),
        year: z.number().int().min(1970).max(2199),
        includeOptional: z.boolean().optional().describe("also bank holidays, optional and observance days (default: only days off by law)"),
      }),
    },
    ({ location: ref, year, includeOptional }) =>
      guarded(async () => {
        const location = pickLocation((await snapshot()).locations, ref);
        const full = (await snapshot()).locations.find((candidate) => candidate.id === location.id)!;
        if (!full.country) throw new ToolProblem(`Set ${location.name}'s country first (save_location).`);
        const holidays = publicHolidays(full.country, full.region, year)
          .filter((holiday) => includeOptional || holiday.type === "public")
          .map(({ name, startDate, endDate }) => ({ name, startDate, endDate }));
        if (holidays.length === 0) throw new ToolProblem(`No public holidays found for ${full.country} in ${year}.`);
        const added = await teamEdits.importHolidays(actor(), location.id, valid(ImportHolidaysBody, { holidays }).holidays);
        return answer(`Added ${added} public ${added === 1 ? "holiday" : "holidays"} to ${location.name} (${holidays.length - added} were already there).`, {
          added,
          holidays: holidays.map((holiday) => `${holiday.startDate} ${holiday.name}`),
        });
      }),
  );
};
