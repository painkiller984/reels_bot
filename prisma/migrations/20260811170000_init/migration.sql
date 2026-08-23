CREATE TABLE "content_jobs" (
  "id" VARCHAR(32) NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "brief" JSONB NOT NULL,
  "script" JSONB,
  "artifacts" JSONB NOT NULL,
  "publications" JSONB NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "content_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "content_jobs_userId_createdAt_idx" ON "content_jobs"("userId", "createdAt" DESC);
CREATE INDEX "content_jobs_status_updatedAt_idx" ON "content_jobs"("status", "updatedAt");
