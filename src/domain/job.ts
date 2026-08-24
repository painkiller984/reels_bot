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
  // Legacy image-driven montage remains supported for existing jobs. New jobs
  // use sourceVideoFileId: the video is the primary visual material.
  productImageFileId: z.string().min(1).optional(),
  productImageFileIds: z.array(z.string().min(1)).min(1).max(6).optional(),
  sourceVideoFileId: z.string().min(1).optional(),
  sourceVideoDurationSec: z.number().int().min(10).max(180).optional(),
  avatarMode: z.enum(["generated", "photo", "saved"]).default("generated"),
  avatarId: z.string().min(1).optional(),
  avatarName: z.string().trim().min(2).max(80).optional(),
  avatarPrompt: z.string().trim().min(3).max(1_000).optional(),
  avatarImageFileId: z.string().min(1).optional(),
  creativeSeed: z.number().int().min(1).max(2_147_483_647).optional(),
}).superRefine((brief, context) => {
  if (!brief.sourceVideoFileId && !brief.productImageFileId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Нужно исходное видео или изображение" });
  }
});

export type Brief = z.infer<typeof BriefSchema>;

export function productImageIds(brief: Brief): string[] {
  return [...new Set([brief.productImageFileId, ...(brief.productImageFileIds ?? [])].filter((id): id is string => Boolean(id)))].slice(0, 6);
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
  kind: z.enum(["product_fullscreen", "avatar_product_card", "split_product", "generated_scene", "avatar"]),
  beat: z.string().trim().min(3).max(160).optional(),
  productIndex: z.number().int().min(0).max(5).optional(),
  background: z.enum(["none", "generated_1", "generated_2"]).default("none"),
  motion: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "drift", "pulse", "fly_from_bottom", "fly_from_top", "slide_left", "slide_right", "pop", "none"]).default("none"),
  transition: z.enum(["cut", "fade", "whip_left", "whip_right", "push_up", "push_down", "zoom", "circle", "reveal", "pixelize"]).default("fade"),
  durationWeight: z.number().int().min(1).max(5).default(2),
});
export type MontageScene = z.infer<typeof MontageSceneSchema>;

export const GeneratedVisualRequestSchema = z.object({
  id: z.enum(["generated_1", "generated_2"]),
  purpose: z.enum(["background", "reference_scene", "lifestyle", "texture"]),
  productIndex: z.number().int().min(0).max(5).optional(),
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
  const count = Math.max(1, productImageIds(brief).length);
  const seed = brief.creativeSeed ?? [...brief.topic].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 17);
  const motions = ["zoom_in", "pan_left", "fly_from_bottom", "slide_right", "zoom_out", "pan_right", "pop", "fly_from_top", "pan_up", "drift", "pulse"] as const;
  const transitions = ["zoom", "whip_left", "push_up", "fade", "whip_right", "push_down", "circle", "reveal", "pixelize", "cut"] as const;
  const offset = seed % motions.length;
  const sceneKinds = seed % 3 === 0
    ? ["product_fullscreen", "avatar_product_card", "split_product", "avatar_product_card", "product_fullscreen"] as const
    : seed % 3 === 1
      ? ["split_product", "product_fullscreen", "avatar_product_card", "avatar", "product_fullscreen"] as const
      : ["avatar_product_card", "product_fullscreen", "split_product", "product_fullscreen", "avatar_product_card"] as const;
  return MontagePlanSchema.parse({
    style: brief.tone.toLowerCase().includes("эксперт") ? "clean" : "dynamic",
    subtitleStyle: "bold",
    musicMood: brief.goal === "sales" ? "energetic" : "modern",
    generatedVisuals: [],
    scenes: sceneKinds.map((kind, index) => ({
      kind,
      beat: ["хук", "контекст", "ключевая мысль", "демонстрация", "призыв к действию"][index],
      productIndex: Math.min(index % count, count - 1),
      motion: motions[(offset + index) % motions.length],
      transition: transitions[(offset + index * 2) % transitions.length],
      durationWeight: 2 + ((seed + index) % 2),
    })),
  });
}

export const ScriptSchema = z.object({
  hook: z.string().min(1),
  body: z.string().min(1),
  // A CTA is optional: a commentary may simply conclude with the final
  // retained part of the source video.
  callToAction: z.string().max(500).default(""),
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
  externalId: z.string().min(1).optional(),
  metrics: z.object({
    views: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative(),
    capturedAt: z.coerce.date(),
  }).optional(),
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
