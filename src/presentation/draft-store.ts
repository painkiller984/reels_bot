import type { Brief, Platform } from "../domain/job.js";

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

  start(userId: string, topic?: string): BriefDraft {
    const draft: BriefDraft = topic ? { stage: "product_image", topic } : { stage: "topic" };
    this.drafts.set(userId, draft);
    return draft;
  }

  get(userId: string): BriefDraft | undefined {
    return this.drafts.get(userId);
  }

  update(userId: string, values: Partial<BriefDraft>): BriefDraft | undefined {
    const current = this.drafts.get(userId);
    if (!current) return undefined;
    const updated = { ...current, ...values };
    this.drafts.set(userId, updated);
    return updated;
  }

  delete(userId: string): void {
    this.drafts.delete(userId);
  }
}
