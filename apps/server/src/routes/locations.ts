import { CALENDAR_LIMITS, ImportHolidaysBody, LocationBody, type PublicHolidayDto } from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { toLocationDto } from "../calendar/instance-service";
import { countries, publicHolidays, regions } from "../calendar/public-holidays";
import { badRequest, conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

/**
 * Locations (offices, countries) that team members belong to. Holidays can target them, and a
 * country's public holidays can be added to one from a suggested list (then edited like any other).
 */
export function locationRoutes(app: FastifyInstance, { db, instance }: RouteContext): void {
  const mustExist = async (id: string) => {
    const location = await db.location.findUnique({ where: { id } });
    if (!location) throw notFound("Location");
    return location;
  };
  const checkRegion = (body: { country: string | null; region: string | null }) => {
    if (body.region && !body.country) throw badRequest("Choose the country of that region");
    if (body.country && !countries().some((entry) => entry.code === body.country)) throw badRequest("No public holiday data for that country");
    if (body.country && body.region && !regions(body.country).some((entry) => entry.code === body.region)) throw badRequest("Unknown region for that country");
  };

  app.post("/api/locations", async (request, reply) => {
    const user = requireUser(request, "editor");
    const body = parseBody(LocationBody, request.body);
    checkRegion(body);
    const location = await instance.mutate(actorOf(user), "createLocation", body, (tx) => tx.location.create({ data: body }));
    return reply.status(201).send({ location: toLocationDto(location) });
  });

  app.put<{ Params: { id: string } }>("/api/locations/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Location");
    const body = parseBody(LocationBody, request.body);
    checkRegion(body);
    await mustExist(id);
    const location = await instance.mutate(actorOf(user), "updateLocation", { id, ...body }, (tx) => tx.location.update({ where: { id }, data: body }));
    return { location: toLocationDto(location) };
  });

  /** Its members lose the location; holidays only for it go too; holidays also for others just drop it. */
  app.delete<{ Params: { id: string } }>("/api/locations/:id", async (request, reply) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Location");
    await mustExist(id);
    await instance.mutate(actorOf(user), "deleteLocation", { id }, async (tx) => {
      const affected = await tx.holiday.findMany({ where: { locationIds: { has: id } } });
      for (const holiday of affected) {
        const locationIds = holiday.locationIds.filter((other) => other !== id);
        if (locationIds.length === 0 && holiday.resourceIds.length === 0) await tx.holiday.delete({ where: { id: holiday.id } });
        else await tx.holiday.update({ where: { id: holiday.id }, data: { locationIds } });
      }
      await tx.location.delete({ where: { id } });
    });
    return reply.status(204).send();
  });

  app.get("/api/public-holidays/countries", async (request) => {
    requireUser(request, "editor");
    return { countries: countries() };
  });

  app.get<{ Params: { country: string } }>("/api/public-holidays/countries/:country/regions", async (request) => {
    requireUser(request, "editor");
    return { regions: regions(request.params.country.toUpperCase()) };
  });

  /** The public holidays of the location's country (and region) for a year, marking those already added. */
  app.get<{ Params: { id: string }; Querystring: { year?: string } }>("/api/locations/:id/public-holidays", async (request) => {
    requireUser(request, "editor");
    const location = await mustExist(parseId(request.params.id, "Location"));
    if (!location.country) throw badRequest("Set the location's country first");
    const year = Number(request.query.year ?? new Date().getFullYear());
    if (!Number.isInteger(year) || year < 1970 || year > 2199) throw badRequest("Choose a year between 1970 and 2199");
    const existing = await db.holiday.findMany({ where: { locationIds: { has: location.id } }, select: { name: true, startDate: true } });
    const added = new Set(existing.map((holiday) => `${holiday.name}|${holiday.startDate}`));
    const holidays: PublicHolidayDto[] = publicHolidays(location.country, location.region, year).map((holiday) => ({
      ...holiday,
      added: added.has(`${holiday.name}|${holiday.startDate}`),
    }));
    return { holidays };
  });

  /** Adds the chosen holidays to the location (one change; ones already there are skipped). */
  app.post<{ Params: { id: string } }>("/api/locations/:id/holidays", async (request, reply) => {
    const user = requireUser(request, "editor");
    const location = await mustExist(parseId(request.params.id, "Location"));
    const body = parseBody(ImportHolidaysBody, request.body);
    const created = await instance.mutate(actorOf(user), "importHolidays", { locationId: location.id, count: body.holidays.length }, async (tx) => {
      const existing = await tx.holiday.findMany({ where: { locationIds: { has: location.id } }, select: { name: true, startDate: true } });
      const have = new Set(existing.map((holiday) => `${holiday.name}|${holiday.startDate}`));
      const fresh = body.holidays.filter((holiday) => !have.has(`${holiday.name}|${holiday.startDate}`));
      if ((await tx.holiday.count()) + fresh.length > CALENDAR_LIMITS.holidays) throw conflict(`At most ${CALENDAR_LIMITS.holidays} holidays`);
      await tx.holiday.createMany({ data: fresh.map((holiday) => ({ ...holiday, appliesToAll: false, resourceIds: [], locationIds: [location.id] })) });
      return fresh.length;
    });
    return reply.status(201).send({ added: created });
  });
}
