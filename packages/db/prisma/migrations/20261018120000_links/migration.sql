-- Dependencies get their own table (several per task, three kinds, a delay each).
CREATE TABLE "Link" (
    "projectId" UUID NOT NULL,
    "predecessorId" UUID NOT NULL,
    "followerId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "lag" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("followerId","predecessorId","kind")
);

CREATE INDEX "Link_projectId_idx" ON "Link"("projectId");

CREATE INDEX "Link_predecessorId_idx" ON "Link"("predecessorId");

ALTER TABLE "Link" ADD CONSTRAINT "Link_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Link" ADD CONSTRAINT "Link_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "Row"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Link" ADD CONSTRAINT "Link_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "Row"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every predecessor that exists in the same project becomes a finish-to-start link; a dangling id is left out.
INSERT INTO "Link" ("projectId", "predecessorId", "followerId", "kind", "lag")
SELECT r."projectId", r."predecessorId", r."id", 'FS', r."offset"
FROM "Row" r
JOIN "Row" p ON p."id" = r."predecessorId" AND p."projectId" = r."projectId"
WHERE r."predecessorId" IS NOT NULL;

ALTER TABLE "Row" DROP COLUMN "predecessorId", DROP COLUMN "offset";
