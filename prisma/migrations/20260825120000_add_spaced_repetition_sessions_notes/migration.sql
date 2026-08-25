-- AlterTable: spaced repetition (SM-2) fields on Flashcard
ALTER TABLE "Flashcard" ADD COLUMN "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5;
ALTER TABLE "Flashcard" ADD COLUMN "intervalDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Flashcard" ADD COLUMN "repetitions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Flashcard" ADD COLUMN "dueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Flashcard" ADD COLUMN "lastReviewedAt" TIMESTAMP(3);
ALTER TABLE "Flashcard" ADD COLUMN "lastRating" TEXT;

-- CreateIndex
CREATE INDEX "Flashcard_flashcardSetId_idx" ON "Flashcard"("flashcardSetId");
CREATE INDEX "Flashcard_dueDate_idx" ON "Flashcard"("dueDate");

-- AlterTable: remembers the last "Study All" shuffle order (as a hash) so
-- a fresh shuffle can be checked against it and re-rolled on collision
ALTER TABLE "User" ADD COLUMN "lastShuffleHash" TEXT;

-- CreateTable
CREATE TABLE "StudySession" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "circleId" INTEGER NOT NULL,
    "createdByUserId" INTEGER NOT NULL,

    CONSTRAINT "StudySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudySessionRSVP" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GOING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "StudySessionRSVP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleNote" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "circleId" INTEGER NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "updatedByUserId" INTEGER,

    CONSTRAINT "CircleNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudySession_circleId_scheduledFor_idx" ON "StudySession"("circleId", "scheduledFor");
CREATE UNIQUE INDEX "StudySessionRSVP_sessionId_userId_key" ON "StudySessionRSVP"("sessionId", "userId");
CREATE INDEX "CircleNote_circleId_updatedAt_idx" ON "CircleNote"("circleId", "updatedAt");

-- AddForeignKey
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "StudyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudySession" ADD CONSTRAINT "StudySession_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudySessionRSVP" ADD CONSTRAINT "StudySessionRSVP_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "StudySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudySessionRSVP" ADD CONSTRAINT "StudySessionRSVP_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CircleNote" ADD CONSTRAINT "CircleNote_circleId_fkey" FOREIGN KEY ("circleId") REFERENCES "StudyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CircleNote" ADD CONSTRAINT "CircleNote_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CircleNote" ADD CONSTRAINT "CircleNote_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
