import type { AvatarProfile, AvatarProfileStore } from "../application/avatar-profiles.js";
import type { PrismaClient } from "../generated/prisma/client.js";

const toAvatarProfile = (row: Omit<AvatarProfile, "voice"> & { voice: string | null }): AvatarProfile => ({
  ...row,
  voice: row.voice === "male" || row.voice === "female" ? row.voice : null,
});

export class PrismaAvatarProfileStore implements AvatarProfileStore {
  constructor(private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<AvatarProfile[]> {
    return (await this.prisma.avatarProfile.findMany({ where: { userId }, orderBy: { createdAt: "desc" } })).map(toAvatarProfile);
  }

  async get(userId: string, id: string): Promise<AvatarProfile | undefined> {
    const row = await this.prisma.avatarProfile.findFirst({ where: { id, userId } });
    return row ? toAvatarProfile(row) : undefined;
  }

  async create(input: Omit<AvatarProfile, "id" | "createdAt" | "updatedAt">): Promise<AvatarProfile> {
    return toAvatarProfile(await this.prisma.avatarProfile.upsert({
      where: { userId_heygenAvatarId: { userId: input.userId, heygenAvatarId: input.heygenAvatarId } },
      create: input,
      update: {
        name: input.name,
        ...(input.sourceFileId !== undefined ? { sourceFileId: input.sourceFileId } : {}),
        ...(input.voice !== undefined ? { voice: input.voice } : {}),
      },
    }));
  }

  async updateVoice(userId: string, id: string, voice: "male" | "female"): Promise<void> {
    await this.prisma.avatarProfile.updateMany({ where: { id, userId }, data: { voice } });
  }
}
