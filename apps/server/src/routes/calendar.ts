import {
  CreateResourceBody,
  HolidayBody,
  TimeOffBody,
  UpdateResourceBody,
  WorkingWeekdaysBody,
} from "@ganttlines/protocol";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { requireInstanceRead } from "../auth/request-access";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

/**
 * Team members and the team calendar. Editors manage people, holidays and time off; only admins
 * change the working weekdays. Every change bumps the instance version (see InstanceService).
 */
export function calendarRoutes(app: FastifyInstance, context: RouteContext): void {
  const { instance, teamEdits } = context;
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
    return { resource: await teamEdits.updateResource(actorOf(user), id, body) };
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
    return reply.status(201).send({ holiday: await teamEdits.createHoliday(actorOf(user), body) });
  });

  app.put<{ Params: { id: string } }>("/api/holidays/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Holiday");
    const body = parseBody(HolidayBody, request.body);
    return { holiday: await teamEdits.updateHoliday(actorOf(user), id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/holidays/:id", async (request, reply) => {
    const user = requireUser(request, "editor");
    await teamEdits.deleteHoliday(actorOf(user), parseId(request.params.id, "Holiday"));
    return reply.status(204).send();
  });

  app.post("/api/time-off", async (request, reply) => {
    const user = requireUser(request, "editor");
    const body = parseBody(TimeOffBody, request.body);
    return reply.status(201).send({ timeOff: await teamEdits.createTimeOff(actorOf(user), body) });
  });

  app.put<{ Params: { id: string } }>("/api/time-off/:id", async (request) => {
    const user = requireUser(request, "editor");
    const id = parseId(request.params.id, "Time off");
    const body = parseBody(TimeOffBody, request.body);
    return { timeOff: await teamEdits.updateTimeOff(actorOf(user), id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/time-off/:id", async (request, reply) => {
    const user = requireUser(request, "editor");
    await teamEdits.deleteTimeOff(actorOf(user), parseId(request.params.id, "Time off"));
    return reply.status(204).send();
  });
}
