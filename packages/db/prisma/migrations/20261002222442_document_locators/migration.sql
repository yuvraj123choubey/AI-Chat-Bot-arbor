-- AlterTable
ALTER TABLE "DocumentChunk" ADD COLUMN     "lineEnd" INTEGER,
ADD COLUMN     "lineStart" INTEGER;

-- AlterTable
ALTER TABLE "MessageSource" ADD COLUMN     "locator" JSONB;
