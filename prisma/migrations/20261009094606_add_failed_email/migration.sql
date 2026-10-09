-- CreateTable
CREATE TABLE "FailedEmail" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "relatedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedEmail_createdAt_idx" ON "FailedEmail"("createdAt");

-- CreateIndex
CREATE INDEX "FailedEmail_kind_createdAt_idx" ON "FailedEmail"("kind", "createdAt");
