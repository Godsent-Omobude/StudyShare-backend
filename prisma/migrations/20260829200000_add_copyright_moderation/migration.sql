-- CreateEnum
CREATE TYPE "CopyrightStatus" AS ENUM ('PENDING', 'CLEARED', 'REVIEW_REQUIRED', 'RESTRICTED', 'REMOVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CopyrightRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "CopyrightReportStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'ACTION_TAKEN', 'REJECTED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CopyrightReportOutcome" AS ENUM ('LEGITIMATE', 'UNFOUNDED', 'INSUFFICIENT_INFORMATION', 'FALSE_OR_MISLEADING');

-- CreateEnum
CREATE TYPE "CopyrightDisputeStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'UPHELD', 'RESTORED', 'CLOSED');

-- AlterTable: User (account enforcement)
ALTER TABLE "User" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "suspendedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "suspendedReason" TEXT;
ALTER TABLE "User" ADD COLUMN "terminatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "terminatedReason" TEXT;
ALTER TABLE "User" ADD COLUMN "copyrightWarnings" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: File (moderation lifecycle)
-- Existing rows default to CLEARED (not PENDING) so nothing already
-- published silently disappears from the site the moment this migration
-- runs; only new uploads start at PENDING via application code.
ALTER TABLE "File" ADD COLUMN "copyrightStatus" "CopyrightStatus" NOT NULL DEFAULT 'CLEARED';
ALTER TABLE "File" ADD COLUMN "copyrightRisk" "CopyrightRisk";
ALTER TABLE "File" ADD COLUMN "copyrightScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "File" ADD COLUMN "copyrightCheckedAt" TIMESTAMP(3);
ALTER TABLE "File" ADD COLUMN "textFingerprint" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "File" ADD COLUMN "similarityScore" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "File" ADD COLUMN "duplicateOfId" INTEGER;
ALTER TABLE "File" ADD COLUMN "webMatchFound" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "File" ADD COLUMN "sourceReferences" JSONB;
ALTER TABLE "File" ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "File" ADD COLUMN "reviewReason" TEXT;
ALTER TABLE "File" ADD COLUMN "reviewedByUserId" INTEGER;
ALTER TABLE "File" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "File" ADD COLUMN "restrictionReason" TEXT;
ALTER TABLE "File" ADD COLUMN "removalReason" TEXT;
ALTER TABLE "File" ADD COLUMN "uploaderNotifiedAt" TIMESTAMP(3);
ALTER TABLE "File" ADD COLUMN "reportCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "File" ADD COLUMN "internalNotesCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows from the legacy scan status so the new column is
-- actually meaningful immediately, not just for future uploads.
UPDATE "File" SET "copyrightStatus" = 'CLEARED' WHERE "copyrightScanStatus" = 'APPROVED';
UPDATE "File" SET "copyrightStatus" = 'REVIEW_REQUIRED', "reviewRequired" = true WHERE "copyrightScanStatus" = 'REVIEW';
UPDATE "File" SET "copyrightStatus" = 'REVIEW_REQUIRED', "reviewRequired" = true WHERE "copyrightScanStatus" = 'BLOCKED';
UPDATE "File" SET "copyrightScore" = "copyrightRiskScore";
UPDATE "File" SET "copyrightCheckedAt" = "copyrightScanCheckedAt";
UPDATE "File" SET "copyrightRisk" = CASE
  WHEN "copyrightRiskScore" >= 60 THEN 'HIGH'::"CopyrightRisk"
  WHEN "copyrightRiskScore" >= 35 THEN 'MEDIUM'::"CopyrightRisk"
  ELSE 'LOW'::"CopyrightRisk"
END;

-- CreateTable
CREATE TABLE "CopyrightReport" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "complainantUserId" INTEGER,
    "complainantName" TEXT NOT NULL,
    "complainantEmail" TEXT NOT NULL,
    "complainantPhone" TEXT,
    "copyrightedWork" TEXT NOT NULL,
    "infringingLocation" TEXT,
    "explanation" TEXT NOT NULL,
    "ownershipEvidence" TEXT,
    "supportingInfo" TEXT,
    "declarationAccepted" BOOLEAN NOT NULL DEFAULT false,
    "status" "CopyrightReportStatus" NOT NULL DEFAULT 'PENDING',
    "outcome" "CopyrightReportOutcome",
    "reason" TEXT,
    "decision" TEXT,
    "actionTaken" TEXT,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyrightReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyrightDispute" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "uploaderId" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "ownsWork" BOOLEAN NOT NULL DEFAULT false,
    "hasPermission" BOOLEAN NOT NULL DEFAULT false,
    "otherLawfulBasis" TEXT,
    "status" "CopyrightDisputeStatus" NOT NULL DEFAULT 'PENDING',
    "adminResponse" TEXT,
    "reviewedByUserId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyrightDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyrightNote" (
    "id" SERIAL NOT NULL,
    "fileId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyrightNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyrightAuditLog" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetFileId" INTEGER,
    "targetUserId" INTEGER,
    "reportId" INTEGER,
    "disputeId" INTEGER,
    "reason" TEXT,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyrightAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "File_copyrightStatus_idx" ON "File"("copyrightStatus");
CREATE INDEX "File_copyrightRisk_idx" ON "File"("copyrightRisk");
CREATE INDEX "File_duplicateOfId_idx" ON "File"("duplicateOfId");

CREATE INDEX "CopyrightReport_fileId_idx" ON "CopyrightReport"("fileId");
CREATE INDEX "CopyrightReport_status_idx" ON "CopyrightReport"("status");
CREATE INDEX "CopyrightReport_createdAt_idx" ON "CopyrightReport"("createdAt");

CREATE INDEX "CopyrightDispute_fileId_idx" ON "CopyrightDispute"("fileId");
CREATE INDEX "CopyrightDispute_uploaderId_idx" ON "CopyrightDispute"("uploaderId");
CREATE INDEX "CopyrightDispute_status_idx" ON "CopyrightDispute"("status");

CREATE INDEX "CopyrightNote_fileId_createdAt_idx" ON "CopyrightNote"("fileId", "createdAt");

CREATE INDEX "CopyrightAuditLog_targetFileId_idx" ON "CopyrightAuditLog"("targetFileId");
CREATE INDEX "CopyrightAuditLog_targetUserId_idx" ON "CopyrightAuditLog"("targetUserId");
CREATE INDEX "CopyrightAuditLog_createdAt_idx" ON "CopyrightAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "File" ADD CONSTRAINT "File_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CopyrightReport" ADD CONSTRAINT "CopyrightReport_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyrightReport" ADD CONSTRAINT "CopyrightReport_complainantUserId_fkey" FOREIGN KEY ("complainantUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CopyrightReport" ADD CONSTRAINT "CopyrightReport_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CopyrightDispute" ADD CONSTRAINT "CopyrightDispute_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyrightDispute" ADD CONSTRAINT "CopyrightDispute_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyrightDispute" ADD CONSTRAINT "CopyrightDispute_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CopyrightNote" ADD CONSTRAINT "CopyrightNote_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyrightNote" ADD CONSTRAINT "CopyrightNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CopyrightAuditLog" ADD CONSTRAINT "CopyrightAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CopyrightAuditLog" ADD CONSTRAINT "CopyrightAuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
