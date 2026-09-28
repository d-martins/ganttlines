import { CreateUserBody, UpdateUserBody } from "@ganttlines/protocol";
import type { Prisma } from "@ganttlines/db";
import type { FastifyInstance } from "fastify";
import { actorOf } from "../actor";
import { requireUser } from "../auth/guard";
import { generateTemporaryPassword, hashPassword } from "../auth/passwords";
import { toUserDto } from "../dto";
import { conflict, notFound } from "../errors";
import { parseBody, parseId } from "../validation";
import type { RouteContext } from "./context";

/** Admin-only user management. New users get a temporary password they must change. */
export function userRoutes(app: FastifyInstance, { db, sessions, instance }: RouteContext): void {
  app.get("/api/users", async (request) => {
    requireUser(request, "admin");
    const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
    return { users: users.map(toUserDto) };
  });

  app.post("/api/users", async (request, reply) => {
    const admin = requireUser(request, "admin");
    const body = parseBody(CreateUserBody, request.body);
    if (await db.user.findUnique({ where: { email: body.email } })) throw conflict("A user with that email already exists");
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = await db.user.create({
      data: { email: body.email, name: body.name, role: body.role, passwordHash, mustChangePassword: true },
    });
    if (body.createResource) await instance.createResource(actorOf(admin), { name: user.name, userId: user.id });
    return reply.status(201).send({ user: toUserDto(user), temporaryPassword });
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (request) => {
    requireUser(request, "admin");
    const id = parseId(request.params.id, "User");
    const body = parseBody(UpdateUserBody, request.body);
    const updated = await withUserTableLocked(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw notFound("User");
      if (user.role === "admin" && body.role && body.role !== "admin") await assertAnotherAdmin(tx, id);
      return tx.user.update({
        where: { id },
        data: { ...(body.name ? { name: body.name } : {}), ...(body.role ? { role: body.role } : {}) },
      });
    });
    return { user: toUserDto(updated) };
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-password", async (request) => {
    requireUser(request, "admin");
    const id = parseId(request.params.id, "User");
    if (!(await db.user.findUnique({ where: { id } }))) throw notFound("User");
    const temporaryPassword = generateTemporaryPassword();
    await db.user.update({ where: { id }, data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true } });
    await sessions.revokeAllForUser(id);
    return { temporaryPassword };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (request, reply) => {
    const admin = requireUser(request, "admin");
    const id = parseId(request.params.id, "User");
    if (id === admin.id) throw conflict("You cannot delete your own account");
    await withUserTableLocked(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw notFound("User");
      if (user.role === "admin") await assertAnotherAdmin(tx, id);
      await tx.user.delete({ where: { id } });
    });
    return reply.status(204).send();
  });

  /**
   * Runs `work` while holding a lock that serialises role changes and deletions, so two admins
   * demoting/deleting each other at the same time can never leave the instance without an admin.
   */
  function withUserTableLocked<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`;
      return work(tx);
    });
  }

  async function assertAnotherAdmin(tx: Prisma.TransactionClient, exceptId: string): Promise<void> {
    const others = await tx.user.count({ where: { role: "admin", NOT: { id: exceptId } } });
    if (others === 0) throw conflict("There must always be at least one admin");
  }
}
