-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "workingWeekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "instanceVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "appliesToAll" BOOLEAN NOT NULL,
    "resourceIds" UUID[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeOff" (
    "id" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeOff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandLog" (
    "id" SERIAL NOT NULL,
    "projectId" UUID,
    "version" INTEGER NOT NULL,
    "commandId" UUID NOT NULL,
    "actorUserId" UUID,
    "actorLabel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeOff_resourceId_idx" ON "TimeOff"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandLog_commandId_key" ON "CommandLog"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "CommandLog_projectId_version_key" ON "CommandLog"("projectId", "version");

-- AddForeignKey
ALTER TABLE "TimeOff" ADD CONSTRAINT "TimeOff_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandLog" ADD CONSTRAINT "CommandLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandLog" ADD CONSTRAINT "CommandLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
