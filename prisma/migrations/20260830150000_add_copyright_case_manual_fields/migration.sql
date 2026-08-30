-- CreateEnum
CREATE TYPE "CopyrightCaseSource" AS ENUM ('USER_SUBMITTED', 'MANUAL');

-- Drop the old cascade-delete FK: a case record must survive the
-- underlying File being deleted (it's a compliance/audit artifact).
ALTER TABLE "CopyrightReport" DROP CONSTRAINT "CopyrightReport_fileId_fkey";

-- fileId becomes optional
ALTER TABLE "CopyrightReport" ALTER COLUMN "fileId" DROP NOT NULL;

-- Re-add the FK as SET NULL instead of CASCADE
ALTER TABLE "CopyrightReport" ADD CONSTRAINT "CopyrightReport_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New columns
ALTER TABLE "CopyrightReport" ADD COLUMN "caseNumber" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "source" "CopyrightCaseSource" NOT NULL DEFAULT 'USER_SUBMITTED';
ALTER TABLE "CopyrightReport" ADD COLUMN "fileTitleSnapshot" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "fileFilenameSnapshot" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "fileHashSnapshot" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "uploaderId" INTEGER;
ALTER TABLE "CopyrightReport" ADD COLUMN "uploaderNameSnapshot" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "uploaderUsernameSnapshot" TEXT;
ALTER TABLE "CopyrightReport" ADD COLUMN "uploaderNotifiedAt" TIMESTAMP(3);
ALTER TABLE "CopyrightReport" ADD COLUMN "uploaderResponse" TEXT;

-- Backfill snapshots + case numbers for existing rows, oldest first, so
-- pre-existing reports get a sensible sequential case number and don't
-- go blank on the new record view.
DO $$
DECLARE
  r RECORD;
  seq INTEGER;
  yr TEXT;
  cur_year TEXT := '';
BEGIN
  FOR r IN
    SELECT cr.id, cr."fileId", cr."createdAt", f.title, f.filename, f."contentHash", f."uploadedBy", u."fullName", u.username
    FROM "CopyrightReport" cr
    LEFT JOIN "File" f ON f.id = cr."fileId"
    LEFT JOIN "User" u ON u.id = f."uploadedBy"
    ORDER BY cr."createdAt" ASC, cr.id ASC
  LOOP
    yr := to_char(r."createdAt", 'YYYY');
    IF yr <> cur_year THEN
      cur_year := yr;
      seq := 1;
    ELSE
      seq := seq + 1;
    END IF;

    UPDATE "CopyrightReport" SET
      "caseNumber" = 'CR-' || yr || '-' || lpad(seq::text, 4, '0'),
      "fileTitleSnapshot" = COALESCE(r.title, '(file no longer available)'),
      "fileFilenameSnapshot" = COALESCE(r.filename, ''),
      "fileHashSnapshot" = r."contentHash",
      "uploaderId" = r."uploadedBy",
      "uploaderNameSnapshot" = r."fullName",
      "uploaderUsernameSnapshot" = r.username
    WHERE id = r.id;
  END LOOP;
END $$;

-- Now that every row has been backfilled, enforce NOT NULL / uniqueness.
ALTER TABLE "CopyrightReport" ALTER COLUMN "caseNumber" SET NOT NULL;
ALTER TABLE "CopyrightReport" ALTER COLUMN "fileTitleSnapshot" SET NOT NULL;
ALTER TABLE "CopyrightReport" ALTER COLUMN "fileFilenameSnapshot" SET NOT NULL;
CREATE UNIQUE INDEX "CopyrightReport_caseNumber_key" ON "CopyrightReport"("caseNumber");
CREATE INDEX "CopyrightReport_caseNumber_idx" ON "CopyrightReport"("caseNumber");
