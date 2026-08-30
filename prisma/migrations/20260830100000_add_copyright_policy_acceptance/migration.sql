-- AlterTable: User (mandatory Copyright Policy acceptance)
-- Both columns are nullable so this migration itself does not lock out
-- existing accounts; enforcement is done in application code (see
-- backend/routes/auth.js and backend/middleware/auth.js), which treats a
-- null copyrightPolicyAcceptedAt (or a stale copyrightPolicyVersion) as
-- "must accept before continuing".
ALTER TABLE "User" ADD COLUMN "copyrightPolicyAcceptedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "copyrightPolicyVersion" TEXT;
