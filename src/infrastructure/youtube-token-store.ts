import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Auth } from "googleapis";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

export interface YoutubeTokenStore {
  get(userId: string): Promise<Auth.Credentials | undefined>;
  set(userId: string, tokens: Auth.Credentials): Promise<void>;
}

type StoredTokens = Record<string, Auth.Credentials>;

export class FileYoutubeTokenStore implements YoutubeTokenStore {
  constructor(private readonly filename: string) {}

  async get(userId: string): Promise<Auth.Credentials | undefined> {
    return (await this.read())[userId];
  }

  async set(userId: string, tokens: Auth.Credentials): Promise<void> {
    const all = await this.read();
    all[userId] = { ...all[userId], ...tokens };
    await mkdir(dirname(this.filename), { recursive: true });
    await writeFile(this.filename, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private async read(): Promise<StoredTokens> {
    try { return JSON.parse(await readFile(this.filename, "utf8")) as StoredTokens; } catch { return {}; }
  }
}

export class PrismaYoutubeTokenStore implements YoutubeTokenStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<Auth.Credentials | undefined> {
    const row = await this.prisma.oAuthCredential.findUnique({ where: { provider_userId: { provider: "youtube", userId } } });
    return row?.credentials as Auth.Credentials | undefined;
  }

  async set(userId: string, tokens: Auth.Credentials): Promise<void> {
    const existing = await this.get(userId);
    const credentials = JSON.parse(JSON.stringify({ ...existing, ...tokens })) as Prisma.InputJsonValue;
    await this.prisma.oAuthCredential.upsert({
      where: { provider_userId: { provider: "youtube", userId } },
      create: { provider: "youtube", userId, credentials },
      update: { credentials },
    });
  }
}
