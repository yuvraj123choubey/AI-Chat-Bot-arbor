-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentKind" ADD VALUE 'starter_code';
ALTER TYPE "DocumentKind" ADD VALUE 'screenshot';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "checkedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT,
ADD COLUMN     "extractedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AssignmentRequirement" ADD COLUMN     "checkNote" TEXT,
ADD COLUMN     "checkQuote" TEXT,
ADD COLUMN     "checkStatus" TEXT,
ADD COLUMN     "section" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "displayName" TEXT;

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "researchProjectId" TEXT,
    "assignmentId" TEXT,
    "projectId" TEXT,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_conversationId_key" ON "DocumentLink"("documentId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_researchProjectId_key" ON "DocumentLink"("documentId", "researchProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_assignmentId_key" ON "DocumentLink"("documentId", "assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_projectId_key" ON "DocumentLink"("documentId", "projectId");

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_researchProjectId_fkey" FOREIGN KEY ("researchProjectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
