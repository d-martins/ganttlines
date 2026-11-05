-- A task's own pauses, and the tasks that interrupt it. No foreign key: the engine clears what stops applying.
ALTER TABLE "Row" ADD COLUMN "breaks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Row" ADD COLUMN "interruptedBy" UUID[] DEFAULT ARRAY[]::UUID[];
