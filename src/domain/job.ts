import { z } from "zod";

export const PlatformSchema = z.enum(["youtube", "instagram", "tiktok"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const BriefSchema = z.object({
  topic: z.string().trim().min(3).max(2_000),
  goal: z.enum(["reach", "sales", "education", "engagement"]).default("reach"),
  audience: z.string().trim().min(2).default("широкая аудитория"),
  tone: z.string().trim().min(2).default("живой и уверенный"),
  language: z.string().trim().min(2).default("ru"),
  durationSec: z.number().int().min(10).max(180).default(45),
  platforms: z.array(PlatformSchema).min(1).default(["youtube"]),
  callToAction: z.string().trim().max(500).optional(),
  productImageFileId: z.string().min(1),
  productImageFileIds: z.array(z.string().min(1)).min(1).max(6).optional(),
  avatarMode: z.enum(["generated", "photo"]).default("generated"),
  avatarPrompt: z.string().trim().min(3).max(1_000).optional(),
  avatarImageFileId: z.string().min(1).optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

export function productImageIds(brief: Brief): string[] {
  return [...new Set([brief.productImageFileId, ...(brief.productImageFileIds ?? [])])].slice(0, 6);
}

export const JobStatusSchema = z.enum([
  "draft",
  "brief_ready",
  "script_generating",
  "script_review",
  "audio_generating",
  "avatar_generating",
  "rendering",
  "quality_check",
  "ready_for_approval",
  "publishing",
  "published",
  "needs_user_input",
  "failed",
  "cancelled",
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MontageSceneSchema = z.object({
  kind: z.enum(["product_fullscreen", "avatar_product_card", "split_product", "avatar"]),
  productIndex: z.number().int().min(0).max(5).optional(),
  background: z.enum(["none", "generated_1", "generated_2"]).default("none"),
  motion: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "fly_from_bottom", "fly_from_top", "slide_left", "slide_right", "pop", "none"]).default("none"),
  transition: z.enum(["cut", "fade", "whip_left", "whip_right", "push_up", "push_down", "zoom"]).default("fade"),
  durationWeight: z.number().int().min(1).max(5).default(2),
});
export type MontageScene = z.infer<typeof MontageSceneSchema>;

export const GeneratedVisualRequestSchema = z.object({
  id: z.enum(["generated_1", "generated_2"]),
  purpose: z.enum(["background", "lifestyle", "texture"]),
  prompt: z.string().trim().min(10).max(500),
});
export type GeneratedVisualRequest = z.infer<typeof GeneratedVisualRequestSchema>;

export const MontagePlanSchema = z.object({
  style: z.enum(["dynamic", "clean", "premium", "energetic"]).default("dynamic"),
  subtitleStyle: z.enum(["bold", "highlight", "minimal"]).default("bold"),
  musicMood: z.enum(["energetic", "modern", "premium", "calm"]).default("modern"),
  scenes: z.array(MontageSceneSchema).min(3).max(8),
  generatedVisuals: z.array(GeneratedVisualRequestSchema).max(2).default([]),
});
export type MontagePlan = z.infer<typeof MontagePlanSchema>;

export function createFallbackMontagePlan(brief: Brief): MontagePlan {
  const count = productImageIds(brief).length;
  return MontagePlanSchema.parse({
    style: brief.tone.toLowerCase().includes("эксперт") ? "clean" : "dynamic",
    subtitleStyle: "bold",
    musicMood: brief.goal === "sales" ? "energetic" : "modern",
    generatedVisuals: [],
    scenes: [
      { kind: "product_fullscreen", productIndex: 0, motion: "zoom_in", transition: "zoom", durationWeight: 2 },
      { kind: "avatar_product_card", productIndex: 0, motion: "fly_from_bottom", transition: "whip_left", durationWeight: 3 },
      { kind: "split_product", productIndex: Math.min(1, count - 1), motion: "slide_right", transition: "push_up", durationWeight: 2 },
      { kind: "avatar_product_card", productIndex: Math.min(2, count - 1), motion: "pop", transition: "whip_right", durationWeight: 3 },
      { kind: "product_fullscreen", productIndex: count - 1, motion: "zoom_out", transition: "zoom", durationWeight: 2 },
    ],
  });
}

export const ScriptSchema = z.object({
  hook: z.string().min(1),
  body: z.string().min(1),
  callToAction: z.string().min(1),
  montagePlan: MontagePlanSchema.optional(),
});
export type Script = z.infer<typeof ScriptSchema>;

export const ArtifactSchema = z.object({
  kind: z.enum(["audio", "avatar_video", "render", "quality_report"]),
  uri: z.string().min(1),
  createdAt: z.coerce.date(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const PublicationSchema = z.object({
  platform: PlatformSchema,
  status: z.enum(["pending", "published", "failed"]),
  url: z.string().url().optional(),
  error: z.string().optional(),
});
export type Publication = z.infer<typeof PublicationSchema>;

export interface ContentJob {
  id: string;
  userId: string;
  status: JobStatus;
  brief: Brief;
  script?: Script;
  artifacts: Artifact[];
  publications: Publication[];
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
