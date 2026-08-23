import type { Brief, Platform } from "../domain/job.js";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

export type DraftStage = "topic" | "product_image" | "avatar_mode" | "avatar_prompt" | "avatar_image" | "goal" | "audience" | "tone" | "duration" | "platforms" | "cta" | "confirm";

export interface BriefDraft {
  stage: DraftStage;
  topic?: string;
  goal?: Brief["goal"];
  audience?: string;
  tone?: string;
  durationSec?: number;
  platforms?: Platform[];
  callToAction?: string;
  productImageFileId?: string;
  productImageFileIds?: string[];
  avatarMode?: "generated" | "photo";
  avatarPrompt?: string;
  avatarImageFileId?: string;
}

export class DraftStore {
  private readonly drafts = new Map<string, BriefDraft>();

  constructor(private readonly prisma?: PrismaClient) {}

  async start(userId: string, topic?: string): Promise<BriefDraft> {
    const draft: BriefDraft = topic ? { stage: "product_image", topic } : { stage: "topic" };
    await this.save(userId, draft);
    return draft;
  }

  async get(userId: string): Promise<BriefDraft | undefined> {
    if (this.prisma) {
      const row = await this.prisma.oAuthCredential.findUnique({
        where: { provider_userId: { provider: "telegram_brief_draft", userId } },
      });
      return row?.credentials as BriefDraft | undefined;
    }
    return this.drafts.get(userId);
  }

  async update(userId: string, values: Partial<BriefDraft>): Promise<BriefDraft | undefined> {
    const current = await this.get(userId);
    if (!current) return undefined;
    const updated = { ...current, ...values };
    await this.save(userId, updated);
    return updated;
  }

  async delete(userId: string): Promise<void> {
    if (this.prisma) {
      await this.prisma.oAuthCredential.deleteMany({ where: { provider: "telegram_brief_draft", userId } });
      return;
    }
    this.drafts.delete(userId);
  }

  private async save(userId: string, draft: BriefDraft): Promise<void> {
    if (this.prisma) {
      const credentials = JSON.parse(JSON.stringify(draft)) as Prisma.InputJsonValue;
      await this.prisma.oAuthCredential.upsert({
        where: { provider_userId: { provider: "telegram_brief_draft", userId } },
        create: { provider: "telegram_brief_draft", userId, credentials },
        update: { credentials },
      });
      return;
    }
    this.drafts.set(userId, draft);
  }
}
