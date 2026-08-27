-- AlterTable
ALTER TABLE "User" ADD COLUMN "notifyCircleMessages" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyCircleInvitations" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyMentions" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyCircleActivity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyFlashcardActivity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyAccountSecurity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyAnnouncements" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PushRegistration" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceInfo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PushRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushRegistration_token_key" ON "PushRegistration"("token");

-- CreateIndex
CREATE INDEX "PushRegistration_userId_idx" ON "PushRegistration"("userId");

-- CreateIndex
CREATE INDEX "PushRegistration_userId_active_idx" ON "PushRegistration"("userId", "active");

-- AddForeignKey
ALTER TABLE "PushRegistration" ADD CONSTRAINT "PushRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
