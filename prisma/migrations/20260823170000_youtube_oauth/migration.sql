CREATE TABLE "oauth_credentials" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "credentials" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "oauth_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_credentials_provider_userId_key" ON "oauth_credentials"("provider", "userId");
