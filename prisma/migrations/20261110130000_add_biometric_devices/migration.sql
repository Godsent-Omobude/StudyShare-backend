-- CreateTable
CREATE TABLE "BiometricDevice" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "secretHash" TEXT NOT NULL,
    "prevSecretHash" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "BiometricDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BiometricDevice_userId_idx" ON "BiometricDevice"("userId");

-- AddForeignKey
ALTER TABLE "BiometricDevice" ADD CONSTRAINT "BiometricDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
