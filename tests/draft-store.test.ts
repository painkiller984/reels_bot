import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { DraftStore } from "../src/presentation/draft-store.js";

describe("durable Telegram brief drafts", () => {
  it("keeps an in-memory draft across separate operations", async () => {
    const store = new DraftStore();
    await store.start("user", "Обзор телефона");
    await store.update("user", { sourceVideoFileId: "video", sourceVideoDurationSec: 30, stage: "avatar" });
    expect(await store.get("user")).toMatchObject({ topic: "Обзор телефона", stage: "avatar" });
  });

  it("loads a draft from PostgreSQL-compatible storage after recreating the store", async () => {
    const rows = new Map<string, unknown>();
    const prisma = {
      oAuthCredential: {
        findUnique: async ({ where }: { where: { provider_userId: { provider: string; userId: string } } }) => {
          const key = `${where.provider_userId.provider}:${where.provider_userId.userId}`;
          const credentials = rows.get(key);
          return credentials ? { credentials } : null;
        },
        upsert: async ({ where, create, update }: { where: { provider_userId: { provider: string; userId: string } }; create: { credentials: unknown }; update: { credentials: unknown } }) => {
          const key = `${where.provider_userId.provider}:${where.provider_userId.userId}`;
          rows.set(key, rows.has(key) ? update.credentials : create.credentials);
        },
        deleteMany: async ({ where }: { where: { provider: string; userId: string } }) => {
          rows.delete(`${where.provider}:${where.userId}`);
        },
      },
    } as unknown as PrismaClient;

    await new DraftStore(prisma).start("user", "Обзор приложения");
    const restored = await new DraftStore(prisma).get("user");
    expect(restored).toEqual({ stage: "source_video", topic: "Обзор приложения" });
  });
});
