import type { Prisma } from "@ganttlines/db";
import {
  CALENDAR_LIMITS,
  type HolidayBody,
  type HolidayDto,
  type ImportHolidaysBody,
  type LocationBody,
  type LocationDto,
  type ResourceDto,
  type TimeOffBody,
  type UpdateResourceBody,
} from "@ganttlines/protocol";
import type { z } from "zod";
import type { Actor } from "../actor";
import { badRequest, conflict, notFound } from "../errors";
import { toLocationDto, toResourceDto, type InstanceService } from "./instance-service";
import { countries, regions } from "@ganttlines/holidays";

type Tx = Prisma.TransactionClient;
type ParsedHoliday = z.output<typeof HolidayBody>;
type ParsedTimeOff = z.output<typeof TimeOffBody>;
type ParsedLocation = z.output<typeof LocationBody>;

/**
 * Changes to the team calendar — people, locations, holidays and time off — shared by the web API
 * and AI apps. Each is one instance change (versioned, logged, broadcast); inputs are already
 * validated against the protocol schemas.
 */
export class TeamEdits {
  constructor(private readonly instance: InstanceService) {}

  async updateResource(actor: Actor, id: string, body: UpdateResourceBody): Promise<ResourceDto> {
    const resource = await this.instance.mutate(actor, "updateResource", { id, ...body }, async (tx) => {
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
    return toResourceDto(resource);
  }

  async createHoliday(actor: Actor, body: ParsedHoliday): Promise<HolidayDto> {
    const holiday = await this.instance.mutate(actor, "createHoliday", body, async (tx) => {
      if ((await tx.holiday.count()) >= CALENDAR_LIMITS.holidays) throw conflict(`At most ${CALENDAR_LIMITS.holidays} holidays`);
      await assertResourcesExist(tx, body.appliesTo);
      await assertLocationsExist(tx, body.locationIds);
      return tx.holiday.create({ data: holidayColumns(body) });
    });
    return this.holidayDto(holiday.id);
  }

  async updateHoliday(actor: Actor, id: string, body: ParsedHoliday): Promise<HolidayDto> {
    await this.instance.mutate(actor, "updateHoliday", { id, ...body }, async (tx) => {
      await mustExist(tx.holiday.findUnique({ where: { id } }), "Holiday");
      await assertResourcesExist(tx, body.appliesTo);
      await assertLocationsExist(tx, body.locationIds);
      await tx.holiday.update({ where: { id }, data: holidayColumns(body) });
    });
    return this.holidayDto(id);
  }

  async deleteHoliday(actor: Actor, id: string): Promise<void> {
    await this.instance.mutate(actor, "deleteHoliday", { id }, async (tx) => {
      await mustExist(tx.holiday.findUnique({ where: { id } }), "Holiday");
      await tx.holiday.delete({ where: { id } });
    });
  }

  async createTimeOff(actor: Actor, body: ParsedTimeOff): Promise<{ id: string } & ParsedTimeOff> {
    const entry = await this.instance.mutate(actor, "createTimeOff", body, async (tx) => {
      if ((await tx.timeOff.count()) >= CALENDAR_LIMITS.timeOff) throw conflict(`At most ${CALENDAR_LIMITS.timeOff} time-off entries`);
      await assertResourcesExist(tx, [body.resourceId]);
      return tx.timeOff.create({ data: body });
    });
    return { id: entry.id, ...body };
  }

  async updateTimeOff(actor: Actor, id: string, body: ParsedTimeOff): Promise<{ id: string } & ParsedTimeOff> {
    await this.instance.mutate(actor, "updateTimeOff", { id, ...body }, async (tx) => {
      await mustExist(tx.timeOff.findUnique({ where: { id } }), "Time off");
      await assertResourcesExist(tx, [body.resourceId]);
      await tx.timeOff.update({ where: { id }, data: body });
    });
    return { id, ...body };
  }

  async deleteTimeOff(actor: Actor, id: string): Promise<void> {
    await this.instance.mutate(actor, "deleteTimeOff", { id }, async (tx) => {
      await mustExist(tx.timeOff.findUnique({ where: { id } }), "Time off");
      await tx.timeOff.delete({ where: { id } });
    });
  }

  async createLocation(actor: Actor, body: ParsedLocation): Promise<LocationDto> {
    checkRegion(body);
    return toLocationDto(await this.instance.mutate(actor, "createLocation", body, (tx) => tx.location.create({ data: body })));
  }

  async updateLocation(actor: Actor, id: string, body: ParsedLocation): Promise<LocationDto> {
    checkRegion(body);
    const location = await this.instance.mutate(actor, "updateLocation", { id, ...body }, async (tx) => {
      await mustExist(tx.location.findUnique({ where: { id } }), "Location");
      return tx.location.update({ where: { id }, data: body });
    });
    return toLocationDto(location);
  }

  /** Adds holidays to a location (one change); ones it already has (same name and day) are skipped. Returns how many were added. */
  async importHolidays(actor: Actor, locationId: string, holidays: ImportHolidaysBody["holidays"]): Promise<number> {
    return this.instance.mutate(actor, "importHolidays", { locationId, count: holidays.length }, async (tx) => {
      await mustExist(tx.location.findUnique({ where: { id: locationId } }), "Location");
      const existing = await tx.holiday.findMany({ where: { locationIds: { has: locationId } }, select: { name: true, startDate: true } });
      const have = new Set(existing.map((holiday) => `${holiday.name}|${holiday.startDate}`));
      const fresh = holidays.filter((holiday) => !have.has(`${holiday.name}|${holiday.startDate}`));
      if ((await tx.holiday.count()) + fresh.length > CALENDAR_LIMITS.holidays) throw conflict(`At most ${CALENDAR_LIMITS.holidays} holidays`);
      await tx.holiday.createMany({ data: fresh.map((holiday) => ({ ...holiday, appliesToAll: false, resourceIds: [], locationIds: [locationId] })) });
      return fresh.length;
    });
  }

  /** The holiday as the calendar now has it (with its location members resolved). */
  private async holidayDto(id: string): Promise<HolidayDto> {
    return (await this.instance.current()).dto.holidays.find((holiday) => holiday.id === id)!;
  }
}

/** A location's country and region must be ones we have public holiday data for. */
export function checkRegion(body: { country: string | null; region: string | null }): void {
  if (body.region && !body.country) throw badRequest("Choose the country of that region");
  if (body.country && !countries().some((entry) => entry.code === body.country)) throw badRequest("No public holiday data for that country");
  if (body.country && body.region && !regions(body.country).some((entry) => entry.code === body.region)) throw badRequest("Unknown region for that country");
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
