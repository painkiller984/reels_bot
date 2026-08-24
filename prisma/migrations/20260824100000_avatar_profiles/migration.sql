CREATE TABLE "avatar_profiles" (
  "id" TEXT NOT NULL,
  "userId" VARCHAR(64) NOT NULL,
  "heygenAvatarId" VARCHAR(128) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "sourceFileId" VARCHAR(256),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "avatar_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_profiles_userId_heygenAvatarId_key" ON "avatar_profiles"("userId", "heygenAvatarId");
CREATE INDEX "avatar_profiles_userId_createdAt_idx" ON "avatar_profiles"("userId", "createdAt" DESC);
