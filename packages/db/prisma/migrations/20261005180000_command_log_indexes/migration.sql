-- Team-calendar entries (no project) get unique versions too: NULL projectIds never clash in "CommandLog_projectId_version_key".
CREATE UNIQUE INDEX "CommandLog_instance_version_key" ON "CommandLog"("version") WHERE "projectId" IS NULL;

-- CreateIndex
CREATE INDEX "CommandLog_changes_idx" ON "CommandLog" USING GIN ("changes" jsonb_path_ops);
