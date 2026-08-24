import type { AvatarProfile, AvatarProfileStore } from "../application/avatar-profiles.js";
import type { PrismaClient } from "../generated/prisma/client.js";

export class PrismaAvatarProfileStore implements AvatarProfileStore {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<AvatarProfile[]> {
    return this.prisma.avatarProfile.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async get(userId: string, id: string): Promise<AvatarProfile | undefined> {
    return (await this.prisma.avatarProfile.findFirst({ where: { id, userId } })) ?? undefined;
  }

  async create(input: Omit<AvatarProfile, "id" | "createdAt" | "updatedAt">): Promise<AvatarProfile> {
    return this.prisma.avatarProfile.upsert({
      where: { userId_heygenAvatarId: { userId: input.userId, heygenAvatarId: input.heygenAvatarId } },
      create: input,
      update: { name: input.name, ...(input.sourceFileId !== undefined ? { sourceFileId: input.sourceFileId } : {}) },
    });
  }
}
