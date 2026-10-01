import type { Prisma } from "@ganttlines/db";
import {
  CALENDAR_LIMITS,
  CreateResourceBody,
  HolidayBody,
  TimeOffBody,
  UpdateResourceBody,
  WorkingWeekdaysBody,
} from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { HolidayDto } from "@ganttlines/protocol";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { requireInstanceRead } from "../auth/request-access";
import { toResourceDto } from "../calendar/instance-service";
import { badRequest, conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

type Tx = Prisma.TransactionClient;
type ParsedHoliday = z.output<typeof HolidayBody>;

/**
 * Team members and the team calendar. Editors manage people, holidays and time off; only admins
 * change the working weekdays. Every change bumps the instance version (see InstanceService).
 */
export function calendarRoutes(app: FastifyInstance, context: RouteContext): void {
  const { instance } = context;
  app.get("/api/calendar", async (request) => {
    const reader = await requireInstanceRead(request, context);
    const calendar = (await instance.current()).dto;
    // Share-link visitors see when people are away, not why (time-off notes are personal).
    return reader === "link" ? { ...calendar, timeOff: calendar.timeOff.map((entry) => ({ ...entry, note: "" })) } : calendar;
  });

  app.get("/api/resources", async (request) => {
    await requireInstanceRead(request, context);
    return { resources: await instance.resources() };
  });

  app.post("/api/resources", async (request, reply) => {
    const user = requireUser(request, "editor");
    const body = parseBody(CreateResourceBody, request.body);
    return reply.status(201).send({ resource: await instance.createResource(actorOf(user), body) });
  });

  app.patch<{ Params: { id: string } }>("/api/resources/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Team member");
    const body = parseBody(UpdateResourceBody, request.body);
    const resource = await instance.mutate(actorOf(user), "updateResource", { id, ...body }, async (tx) => {
      await mustExist(tx.resource.findUnique({ where: { id } }), "Team member");
      if (body.locationId) await assertLocationsExist(tx, [body.locationId]);
      return tx.resource.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.avatarColor ? { avatarColor: body.avatarColor } : {}),
          ...(body.inactive === undefined ? {} : { inactive: body.inactive }),
          ...(body.locationId === undefined ? {} : { locationId: body.locationId }),
        },
      });
    });
    return { resource: toResourceDto(resource) };
  });

  app.put("/api/calendar/working-weekdays", async (request) => {
    const user = requireUser(request, "admin");
    const body = parseBody(WorkingWeekdaysBody, request.body);
    await instance.mutate(actorOf(user), "setWorkingWeekdays", body, (tx) =>
      tx.settings.upsert({
        where: { id: 1 },
        create: { id: 1, workingWeekdays: body.workingWeekdays },
        update: { workingWeekdays: body.workingWeekdays },
      }),
    );
    return (await instance.current()).dto;
  });

  app.post("/api/holidays", async (request, reply) => {
    const user = requireUser(request, "editor");
    const body = parseBody(HolidayBody, request.body);
    const holiday = await instance.mutate(actorOf(user), "createHoliday", body, async (tx) => {
      if ((await tx.holiday.count()) >= CALENDAR_LIMITS.holidays) throw conflict(`At most ${CALENDAR_LIMITS.holidays} holidays`);
      await assertResourcesExist(tx, body.appliesTo);
      await assertLocationsExist(tx, body.locationIds);
      return tx.holiday.create({ data: holidayColumns(body) });
    });
    return reply.status(201).send({ holiday: await holidayDto(context, holiday.id) });
  });

  app.put<{ Params: { id: string } }>("/api/holidays/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Holiday");
    const body = parseBody(HolidayBody, request.body);
    await instance.mutate(actorOf(user), "updateHoliday", { id, ...body }, async (tx) => {
      await mustExist(tx.holiday.findUnique({ where: { id } }), "Holiday");
      await assertResourcesExist(tx, body.appliesTo);
      await assertLocationsExist(tx, body.locationIds);
      await tx.holiday.update({ where: { id }, data: holidayColumns(body) });
    });
    return { holiday: await holidayDto(context, id) };
  });

  app.delete<{ Params: { id: string } }>("/api/holidays/:id", async (request, reply) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Holiday");
    await instance.mutate(actorOf(user), "deleteHoliday", { id }, async (tx) => {
      await mustExist(tx.holiday.findUnique({ where: { id } }), "Holiday");
      await tx.holiday.delete({ where: { id } });
    });
    return reply.status(204).send();
  });

  app.post("/api/time-off", async (request, reply) => {
    const user = requireUser(request, "editor");
    const body = parseBody(TimeOffBody, request.body);
    const entry = await instance.mutate(actorOf(user), "createTimeOff", body, async (tx) => {
      if ((await tx.timeOff.count()) >= CALENDAR_LIMITS.timeOff) throw conflict(`At most ${CALENDAR_LIMITS.timeOff} time-off entries`);
      await assertResourcesExist(tx, [body.resourceId]);
      return tx.timeOff.create({ data: body });
    });
    return reply.status(201).send({ timeOff: { id: entry.id, ...body } });
  });

  app.put<{ Params: { id: string } }>("/api/time-off/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Time off");
    const body = parseBody(TimeOffBody, request.body);
    await instance.mutate(actorOf(user), "updateTimeOff", { id, ...body }, async (tx) => {
      await mustExist(tx.timeOff.findUnique({ where: { id } }), "Time off");
      await assertResourcesExist(tx, [body.resourceId]);
      await tx.timeOff.update({ where: { id }, data: body });
    });
    return { timeOff: { id, ...body } };
  });

  app.delete<{ Params: { id: string } }>("/api/time-off/:id", async (request, reply) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Time off");
    await instance.mutate(actorOf(user), "deleteTimeOff", { id }, async (tx) => {
      await mustExist(tx.timeOff.findUnique({ where: { id } }), "Time off");
      await tx.timeOff.delete({ where: { id } });
    });
    return reply.status(204).send();
  });
}

/** The holiday as the calendar now has it (with its location members resolved). */
async function holidayDto(context: RouteContext, id: string): Promise<HolidayDto> {
  return (await context.instance.current()).dto.holidays.find((holiday) => holiday.id === id)!;
}

function holidayColumns(body: ParsedHoliday) {
  const appliesToAll = body.appliesTo === "all";
  return {
    name: body.name,
    startDate: body.startDate,
    endDate: body.endDate,
    appliesToAll,
    resourceIds: appliesToAll ? [] : [...new Set(body.appliesTo)],
    locationIds: appliesToAll ? [] : [...new Set(body.locationIds)],
  };
}

async function assertLocationsExist(tx: Tx, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if ((await tx.location.count({ where: { id: { in: unique } } })) !== unique.length) throw badRequest("Unknown location");
}

async function assertResourcesExist(tx: Tx, ids: "all" | string[]): Promise<void> {
  if (ids === "all") return;
  const unique = [...new Set(ids)];
  if ((await tx.resource.count({ where: { id: { in: unique } } })) !== unique.length) {
    throw badRequest("Unknown team member");
  }
}

async function mustExist<T>(lookup: Promise<T | null>, what: string): Promise<T> {
  const found = await lookup;
  if (!found) throw notFound(what);
  return found;
}
