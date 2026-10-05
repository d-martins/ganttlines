-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "setupCodeHash" TEXT;

-- CreateTable
CREATE TABLE "UndoEntry" (
    "id" SERIAL NOT NULL,
    "projectId" UUID NOT NULL,
    "actorKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,

    CONSTRAINT "UndoEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCounter" (
    "key" TEXT NOT NULL,
    "windowStart" BIGINT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateCounter_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE INDEX "UndoEntry_projectId_actorKey_kind_id_idx" ON "UndoEntry"("projectId", "actorKey", "kind", "id");

-- AddForeignKey
ALTER TABLE "UndoEntry" ADD CONSTRAINT "UndoEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
