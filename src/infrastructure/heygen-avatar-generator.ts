import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ContentJob } from "../domain/job.js";
import type { AvatarGenerator } from "./local-media-pipeline.js";
import { TelegramFileClient } from "./telegram-file-client.js";

interface HeyGenResponse<T> { data?: T; error?: { message?: string }; message?: string }

export interface HeyGenAvatarOptions {
  apiKey: string;
  resolution: "720p" | "1080p";
  aspectRatio: "9:16" | "16:9";
  defaultAvatarId?: string;
  voiceId?: string;
  maxEstimatedJobCostUsd: number;
  telegramFiles: TelegramFileClient;
}

export class HeyGenAvatarGenerator implements AvatarGenerator {
  constructor(private readonly options: HeyGenAvatarOptions) {}

  async generate(job: ContentJob, audioFile: string, outputFile: string): Promise<void> {
    const createsAvatar = Boolean(job.brief.avatarImageFileId || job.brief.avatarPrompt);
    const estimatedCostUsd = job.brief.durationSec * 0.05 + (createsAvatar ? 1 : 0);
    if (estimatedCostUsd > this.options.maxEstimatedJobCostUsd) {
      throw new Error(
        `HeyGen safety limit: estimated $${estimatedCostUsd.toFixed(2)} exceeds $${this.options.maxEstimatedJobCostUsd.toFixed(2)}`,
      );
    }
    const avatarId = job.brief.avatarImageFileId
      ? await this.createPhotoAvatar(job, dirname(outputFile))
      : await this.createGeneratedAvatar(job);
    const usesIntegratedVoice = audioFile.startsWith("heygen://");
    const audioAssetId = usesIntegratedVoice ? undefined : await this.uploadAsset(audioFile, "audio/mpeg");
    const narration = [job.script?.hook, job.script?.body, job.script?.callToAction].filter(Boolean).join(" ");
    const created = await this.request<{ video_id?: string }>("/v3/videos", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `video-${job.id}` },
      body: JSON.stringify({
        type: "avatar",
        avatar_id: avatarId,
        title: job.brief.topic.slice(0, 100),
        resolution: this.options.resolution,
        aspect_ratio: this.options.aspectRatio,
        fit: "cover",
        ...(usesIntegratedVoice ? { script: narration, ...(this.options.voiceId ? { voice_id: this.options.voiceId } : {}) } : { audio_asset_id: audioAssetId }),
        ...(usesIntegratedVoice ? { voice_settings: { locale: job.brief.language === "ru" ? "ru-RU" : job.brief.language } } : {}),
        output_format: "mp4",
        caption: { file_format: "srt" },
        motion_prompt: "Natural presenter gestures, looking into the camera",
        expressiveness: "medium",
      }),
    });
    if (!created.video_id) throw new Error("HeyGen did not return video_id");
    const completed = await this.waitForVideo(created.video_id);
    const video = await fetch(completed.videoUrl);
    if (!video.ok) throw new Error(`HeyGen video download failed: ${video.status}`);
    await writeFile(outputFile, Buffer.from(await video.arrayBuffer()));
    if (completed.subtitleUrl) {
      const subtitles = await fetch(completed.subtitleUrl);
      if (subtitles.ok) {
        await writeFile(resolve(dirname(outputFile), "heygen-captions.srt"), await subtitles.text(), "utf8");
      }
    }
  }

  private async createPhotoAvatar(job: ContentJob, jobDirectory: string): Promise<string> {
    const imageFile = resolve(jobDirectory, "avatar-source.jpg");
    await this.options.telegramFiles.download(job.brief.avatarImageFileId!, imageFile);
    const imageAssetId = await this.uploadAsset(imageFile, "image/jpeg");
    const result = await this.request<{ avatar_item?: { id?: string; status?: string }; avatar_group?: { id?: string } }>("/v3/avatars", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `avatar-${job.id}` },
      body: JSON.stringify({
        type: "photo",
        name: `Telegram ${job.id}`,
        file: { type: "asset_id", asset_id: imageAssetId },
      }),
    });
    return this.resolveCreatedAvatar(result);
  }

  private async createGeneratedAvatar(job: ContentJob): Promise<string> {
    if (this.options.defaultAvatarId && !job.brief.avatarPrompt) return this.options.defaultAvatarId;
    if (!job.brief.avatarPrompt) {
      throw new Error("HEYGEN_DEFAULT_AVATAR_ID is required for the cost-safe reusable avatar mode");
    }
    const prompt = job.brief.avatarPrompt;
    const result = await this.request<{ avatar_item?: { id?: string; status?: string }; avatar_group?: { id?: string } }>("/v3/avatars", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `generated-avatar-${job.id}` },
      body: JSON.stringify({ type: "prompt", name: `Generated ${job.id}`, prompt }),
    });
    return this.resolveCreatedAvatar(result);
  }

  private async resolveCreatedAvatar(result: { avatar_item?: { id?: string; status?: string }; avatar_group?: { id?: string } }): Promise<string> {
    const lookId = result.avatar_item?.id;
    if (!lookId) throw new Error("HeyGen did not return avatar ID");
    if (result.avatar_item?.status === "completed") return lookId;
    const groupId = result.avatar_group?.id;
    if (!groupId) return lookId;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const group = await this.request<{ status?: string; error?: { message?: string } }>(`/v3/avatars/${encodeURIComponent(groupId)}`);
      if (group.status === "completed") {
        const looks = await this.request<Array<{ id?: string; status?: string }>>(`/v3/avatars/looks?group_id=${encodeURIComponent(groupId)}&limit=20`);
        const completed = looks.find((look) => look.status === "completed" && look.id)?.id ?? looks.find((look) => look.id)?.id;
        if (completed) return completed;
      }
      if (group.status === "failed") throw new Error(`HeyGen avatar generation failed: ${group.error?.message ?? "unknown error"}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
    throw new Error("HeyGen avatar generation timed out");
  }

  private async uploadAsset(file: string, contentType: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([await readFile(file)], { type: contentType }), basename(file));
    const result = await this.request<{ asset_id?: string; id?: string }>("/v3/assets", { method: "POST", body: form });
    const id = result.asset_id ?? result.id;
    if (!id) throw new Error("HeyGen did not return asset_id");
    return id;
  }

  private async waitForVideo(videoId: string): Promise<{ videoUrl: string; subtitleUrl?: string }> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const result = await this.request<{ status?: string; video_url?: string; subtitle_url?: string; failure_message?: string }>(`/v3/videos/${encodeURIComponent(videoId)}`);
      if (result.status === "completed" && result.video_url) {
        return {
          videoUrl: result.video_url,
          ...(result.subtitle_url ? { subtitleUrl: result.subtitle_url } : {}),
        };
      }
      if (result.status === "failed") throw new Error(`HeyGen rendering failed: ${result.failure_message ?? "unknown error"}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
    }
    throw new Error("HeyGen rendering timed out");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`https://api.heygen.com${path}`, {
      ...init,
      headers: { "x-api-key": this.options.apiKey, ...(init.headers ?? {}) },
    });
    const payload = await response.json() as HeyGenResponse<T>;
    if (!response.ok || !payload.data) throw new Error(`HeyGen API: ${response.status} ${payload.error?.message ?? payload.message ?? "request failed"}`);
    return payload.data;
  }
}
