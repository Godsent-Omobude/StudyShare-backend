-- Distinguishes "the scan ran and genuinely found no risk" (score 0,
-- copyrightScanFailed = false) from "the scan crashed and never produced a
-- real score" (copyrightScanFailed = true). Previously both looked
-- identical in the admin UI as "0 / 100".
ALTER TABLE "File" ADD COLUMN "copyrightScanFailed" BOOLEAN NOT NULL DEFAULT false;
