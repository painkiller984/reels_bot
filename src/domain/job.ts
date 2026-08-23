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
  avatarMode: z.enum(["generated", "photo"]).default("generated"),
  avatarPrompt: z.string().trim().min(3).max(1_000).optional(),
  avatarImageFileId: z.string().min(1).optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

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

export const ScriptSchema = z.object({
  hook: z.string().min(1),
  body: z.string().min(1),
  callToAction: z.string().min(1),
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
