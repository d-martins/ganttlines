import type { Db, Prisma } from "@ganttlines/db";
import { Calendar, type CalendarData } from "@ganttlines/engine";
import type { CalendarDto, ResourceDto, TimeOffDto } from "@ganttlines/protocol";
import { randomUUID } from "node:crypto";
import type { Actor } from "../actor";
import { badRequest } from "../errors";
import { KeyedQueue } from "../queue";

type Tx = Prisma.TransactionClient;

export const AVATAR_COLORS = ["#4f8cff", "#a66cff", "#ff6fae", "#ff8a4c", "#2fbf71", "#1fb5c9", "#f5b82e", "#8a94a6"];

export interface InstanceSnapshot {
  version: number;
  calendar: Calendar;
  dto: CalendarDto;
}

/**
 * Instance-scope state shared by every project: team members (resources) and the team calendar.
 * Mutations run one at a time, bump the instance version and are recorded in the command log.
 */
export class InstanceService {
  private snapshot: Promise<InstanceSnapshot> | undefined;
  private readonly queue = new KeyedQueue();

  constructor(private readonly db: Db) {}

  /** The current calendar (loaded from the database on first use). */
  current(): Promise<InstanceSnapshot> {
    this.snapshot ??= this.load().catch((error: unknown) => {
      this.snapshot = undefined;
      throw error;
    });
    return this.snapshot;
  }

  async resources(): Promise<ResourceDto[]> {
    const resources = await this.db.resource.findMany({ orderBy: { createdAt: "asc" } });
    return resources.map(({ id, name, avatarColor, inactive, userId }) => ({ id, name, avatarColor, inactive, userId }));
  }

  /**
   * Runs `work` in a transaction, then validates the resulting calendar, bumps the instance version
   * and logs the command. Invalid calendars roll everything back with a 400.
   */
  mutate<T>(actor: Actor, name: string, payload: unknown, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.queue.run("instance", async () => {
      const { result, snapshot } = await this.db.$transaction(async (tx) => {
        const result = await work(tx);
        const settings = await tx.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
        const version = settings.instanceVersion + 1;
        const snapshot = build(await readCalendar(tx), version);
        await tx.settings.update({ where: { id: 1 }, data: { instanceVersion: version } });
        await tx.commandLog.create({
          data: {
            projectId: null,
            version,
            commandId: randomUUID(),
            actorUserId: actor.userId,
            actorLabel: actor.label,
            name,
            payload: payload as Prisma.InputJsonValue,
            changes: [],
          },
        });
        return { result, snapshot };
      });
      this.snapshot = Promise.resolve(snapshot);
      return result;
    });
  }

  /** Creates a team member; the avatar color cycles through the palette unless one is given. */
  createResource(actor: Actor, input: { name: string; avatarColor?: string | undefined; userId?: string | null }): Promise<ResourceDto> {
    return this.mutate(actor, "createResource", input, async (tx) => {
      const avatarColor = input.avatarColor ?? AVATAR_COLORS[(await tx.resource.count()) % AVATAR_COLORS.length]!;
      const resource = await tx.resource.create({ data: { name: input.name, avatarColor, userId: input.userId ?? null } });
      return { id: resource.id, name: resource.name, avatarColor: resource.avatarColor, inactive: resource.inactive, userId: resource.userId };
    });
  }

  private async load(): Promise<InstanceSnapshot> {
    const settings = await this.db.settings.findUnique({ where: { id: 1 } });
    return build(await readCalendar(this.db), settings?.instanceVersion ?? 0);
  }
}

async function readCalendar(db: Db | Tx): Promise<CalendarDto & { instanceVersion: 0 }> {
  const [settings, holidays, timeOff] = await Promise.all([
    db.settings.findUnique({ where: { id: 1 } }),
    db.holiday.findMany({ orderBy: [{ startDate: "asc" }, { id: "asc" }] }),
    db.timeOff.findMany({ orderBy: [{ startDate: "asc" }, { id: "asc" }] }),
  ]);
  return {
    instanceVersion: 0,
    workingWeekdays: settings?.workingWeekdays ?? [1, 2, 3, 4, 5],
    holidays: holidays.map((h) => ({
      id: h.id,
      name: h.name,
      startDate: h.startDate,
      endDate: h.endDate,
      appliesTo: h.appliesToAll ? "all" : h.resourceIds,
    })),
    timeOff: timeOff.map(
      (t): TimeOffDto => ({ id: t.id, resourceId: t.resourceId, startDate: t.startDate, endDate: t.endDate, note: t.note }),
    ),
  };
}

function build(data: CalendarDto, version: number): InstanceSnapshot {
  const calendarData: CalendarData = { workingWeekdays: data.workingWeekdays, holidays: data.holidays, timeOff: data.timeOff };
  let calendar: Calendar;
  try {
    calendar = new Calendar(calendarData);
  } catch (error) {
    throw badRequest((error as Error).message);
  }
  return { version, calendar, dto: { ...data, instanceVersion: version } };
}
