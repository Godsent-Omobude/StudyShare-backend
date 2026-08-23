-- PostgreSQL/Neon schema additions for Study2Gate Study Circles.
-- This file is provided as a safe SQL reference for an existing Neon database.
-- Prefer `npx prisma db push` for this supplied project because its historical
-- migration_lock.toml still records the older SQLite migration provider.

ALTER TABLE "StudyCircle"
  ADD COLUMN IF NOT EXISTS "joinCodeEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "joinCodeExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "joinCodeMaxUses" INTEGER,
  ADD COLUMN IF NOT EXISTS "joinCodeUses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "joinCodeVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "joinCodeRegeneratedAt" TIMESTAMP(3);

ALTER TABLE "CircleMessage"
  ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedByUserId" INTEGER;

CREATE TABLE IF NOT EXISTS "CirclePinnedMessage" (
  "id" SERIAL NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "circleId" INTEGER NOT NULL,
  "messageId" INTEGER NOT NULL,
  "pinnedByUserId" INTEGER NOT NULL,
  CONSTRAINT "CirclePinnedMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CirclePinnedMessage_messageId_key" UNIQUE ("messageId"),
  CONSTRAINT "CirclePinnedMessage_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "StudyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CirclePinnedMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CircleMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CirclePinnedMessage_pinnedByUserId_fkey" FOREIGN KEY ("pinnedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CircleInvitationLink" (
  "id" SERIAL NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "maxUses" INTEGER,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "joinCodeVersion" INTEGER NOT NULL,
  "circleId" INTEGER NOT NULL,
  CONSTRAINT "CircleInvitationLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CircleInvitationLink_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "CircleInvitationLink_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "StudyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" SERIAL NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "read" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" INTEGER NOT NULL,
  "actorUserId" INTEGER,
  "circleId" INTEGER,
  "messageId" INTEGER,
  "groupKey" TEXT,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Notification_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Notification_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "StudyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Notification_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "CircleMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Notification_groupKey_key" UNIQUE ("groupKey")
);

CREATE INDEX IF NOT EXISTS "CircleMember_userId_idx" ON "CircleMember"("userId");
CREATE INDEX IF NOT EXISTS "CircleJoinRequest_circleId_status_idx" ON "CircleJoinRequest"("circleId", "status");
CREATE INDEX IF NOT EXISTS "CircleInvite_invitedUserId_status_idx" ON "CircleInvite"("invitedUserId", "status");
CREATE INDEX IF NOT EXISTS "CircleMessage_circleId_createdAt_idx" ON "CircleMessage"("circleId", "createdAt");
CREATE INDEX IF NOT EXISTS "CircleMessage_circleId_id_idx" ON "CircleMessage"("circleId", "id");
CREATE INDEX IF NOT EXISTS "CirclePinnedMessage_circleId_createdAt_idx" ON "CirclePinnedMessage"("circleId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");


DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CircleMessage_deletedByUserId_fkey') THEN
    ALTER TABLE "CircleMessage"
      ADD CONSTRAINT "CircleMessage_deletedByUserId_fkey"
      FOREIGN KEY ("deletedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
