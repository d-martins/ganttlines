-- The milestone a task aims for. No foreign key: the engine clears it when that row stops being a milestone.
ALTER TABLE "Row" ADD COLUMN "targetId" UUID;
