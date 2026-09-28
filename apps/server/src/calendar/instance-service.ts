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

export type InstanceListener = (snapshot: InstanceSnapshot) => void;

/**
 * Instance-scope state shared by every project: team members (resources) and the team calendar.
 * Mutations run one at a time, bump the instance version, are recorded in the command log and
 * are announced to listeners (the real-time hub) after they commit.
 */
export class InstanceService {
  private snapshot: Promise<InstanceSnapshot> | undefined;
  private readonly queue = new KeyedQueue();
  private readonly listeners = new Set<InstanceListener>();

  constructor(private readonly db: Db) {}

  /** The current calendar (loaded from the database on first use). */
  current(): Promise<InstanceSnapshot> {
    if (!this.snapshot) {
      // Loaded through the queue so it can never interleave with a mutation.
      const loading = this.queue.run("instance", () => this.load());
      this.snapshot = loading;
      loading.catch(() => {
        if (this.snapshot === loading) this.snapshot = undefined;
      });
    }
    return this.snapshot;
  }

  onChange(listener: InstanceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resources(): Promise<ResourceDto[]> {
    const resources = await this.db.resource.findMany({ orderBy: { createdAt: "asc" } });
    return resources.map(toResourceDto);
  }

  /**
   * Runs `work` in a transaction, then validates the resulting calendar, bumps the instance version
   * and logs the command. Invalid calendars roll everything back with a 400. `actor` may be derived
   * from the work's result (e.g. first-run setup, where the acting user is created by the work).
   */
  mutate<T>(actor: Actor | ((result: T) => Actor), name: string, payload: unknown, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.queue.run("instance", async () => {
      const { result, snapshot } = await this.db.$transaction(async (tx) => {
        const result = await work(tx);
        const settings = await tx.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
        const version = settings.instanceVersion + 1;
        const snapshot = build(await readCalendar(tx), version);
        const by = typeof actor === "function" ? actor(result) : actor;
        await tx.settings.update({ where: { id: 1 }, data: { instanceVersion: version } });
        await tx.commandLog.create({
          data: {
            projectId: null,
            version,
            commandId: randomUUID(),
            actorUserId: by.userId,
            actorLabel: by.label,
            name,
            payload: payload as Prisma.InputJsonValue,
            changes: [],
          },
        });
        return { result, snapshot };
      });
      this.snapshot = Promise.resolve(snapshot);
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch {
          // A failing listener must not undo a committed change.
        }
      }
      return result;
    });
  }

  /** Creates a team member; the avatar color cycles through the palette unless one is given. */
  createResource(actor: Actor, input: ResourceInput): Promise<ResourceDto> {
    return this.mutate(actor, "createResource", input, (tx) => insertResource(tx, input));
  }

  private load(): Promise<InstanceSnapshot> {
    return this.db.$transaction(
      async (tx) => {
        const settings = await tx.settings.findUnique({ where: { id: 1 } });
        return build(await readCalendar(tx), settings?.instanceVersion ?? 0);
      },
      { isolationLevel: "RepeatableRead" },
    );
  }
}

export interface ResourceInput {
  name: string;
  avatarColor?: string | undefined;
  userId?: string | null;
}

/** Inserts a team member inside a `mutate` transaction. */
export async function insertResource(tx: Tx, input: ResourceInput): Promise<ResourceDto> {
  const avatarColor = input.avatarColor ?? AVATAR_COLORS[(await tx.resource.count()) % AVATAR_COLORS.length]!;
  return toResourceDto(await tx.resource.create({ data: { name: input.name, avatarColor, userId: input.userId ?? null } }));
}

export function toResourceDto(resource: { id: string; name: string; avatarColor: string; inactive: boolean; userId: string | null }): ResourceDto {
  return { id: resource.id, name: resource.name, avatarColor: resource.avatarColor, inactive: resource.inactive, userId: resource.userId };
}

async function readCalendar(db: Db | Tx): Promise<Omit<CalendarDto, "instanceVersion">> {
  const [settings, holidays, timeOff] = await Promise.all([
    db.settings.findUnique({ where: { id: 1 } }),
    db.holiday.findMany({ orderBy: [{ startDate: "asc" }, { id: "asc" }] }),
    db.timeOff.findMany({ orderBy: [{ startDate: "asc" }, { id: "asc" }] }),
  ]);
  return {
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

function build(data: Omit<CalendarDto, "instanceVersion">, version: number): InstanceSnapshot {
  const calendarData: CalendarData = { workingWeekdays: data.workingWeekdays, holidays: data.holidays, timeOff: data.timeOff };
  let calendar: Calendar;
  try {
    calendar = new Calendar(calendarData);
  } catch (error) {
    throw badRequest((error as Error).message);
  }
  return { version, calendar, dto: { ...data, instanceVersion: version } };
}
