-- Tasks carry an ordered list of tags; sections keep it empty.
ALTER TABLE "Row" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "Row_tags_idx" ON "Row" USING GIN ("tags");
