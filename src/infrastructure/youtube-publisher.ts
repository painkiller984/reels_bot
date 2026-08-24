import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { ArtifactStore, SocialPublisher } from "../application/ports.js";
import type { ContentJob, Platform } from "../domain/job.js";
import { YoutubeAuthService } from "./youtube-auth.js";

function youtubeApiError(error: unknown): Error {
  const candidate = error as {
    message?: string;
    response?: {
      data?: {
        error?: {
          message?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
    };
  };
  const apiError = candidate.response?.data?.error;
  const reasons = apiError?.errors
    ?.map((item) => [item.reason, item.message].filter(Boolean).join(" — "))
    .filter(Boolean)
    .join("; ");
  const detail = [apiError?.message, reasons, candidate.message]
    .filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index)
    .join(": ");
  return new Error(`YouTube API: ${detail || "неизвестная ошибка"}`);
}

export class YoutubePublisher implements SocialPublisher {
  constructor(
    private readonly auth: YoutubeAuthService,
    private readonly privacyStatus: "private" | "unlisted" | "public",
    private readonly artifactStore: ArtifactStore,
  ) {}

  async publish(job: ContentJob, platform: Platform) {
    if (platform !== "youtube") throw new Error(`${platform}: публикация ещё не подключена`);
    const videoUri = job.artifacts.find((artifact) => artifact.kind === "render")?.uri;
    if (!videoUri) throw new Error("Не найден готовый MP4 для публикации");
    try {
      const video = await this.artifactStore.materialize(videoUri);
      const youtube = google.youtube({ version: "v3", auth: await this.auth.getAuthorizedClient(job.userId) });
      const result = await youtube.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title: job.brief.topic.slice(0, 100), description: [job.script?.hook, job.script?.body, job.script?.callToAction, "#Shorts"].filter(Boolean).join("\n\n") },
          status: { privacyStatus: this.privacyStatus, selfDeclaredMadeForKids: false },
        },
        media: { body: createReadStream(video) },
      });
      if (!result.data.id) throw new Error("YouTube не вернул идентификатор загруженного видео");
      let metrics: Awaited<ReturnType<YoutubePublisher["getMetrics"]>>;
      try {
        // A token limited to youtube.upload can create the video but may not
        // read its statistics. Analytics must never turn a completed upload
        // into a failed publication.
        metrics = await this.getMetrics(job.userId, platform, result.data.id);
      } catch (error) {
        const detail = youtubeApiError(error).message;
        console.warn(JSON.stringify({ event: "youtube_metrics_unavailable", jobId: job.id, videoId: result.data.id, error: detail }));
      }
      return {
        url: `https://www.youtube.com/watch?v=${result.data.id}`,
        externalId: result.data.id,
        ...(metrics ? { metrics } : {}),
      };
    } catch (error) {
      throw youtubeApiError(error);
    }
  }

  async getMetrics(userId: string, platform: Platform, externalId: string) {
    if (platform !== "youtube") return undefined;
    const youtube = google.youtube({ version: "v3", auth: await this.auth.getAuthorizedClient(userId) });
    const result = await youtube.videos.list({ part: ["statistics"], id: [externalId] });
    const statistics = result.data.items?.[0]?.statistics;
    if (!statistics) return undefined;
    return {
      views: Number(statistics.viewCount ?? 0),
      likes: Number(statistics.likeCount ?? 0),
      comments: Number(statistics.commentCount ?? 0),
      capturedAt: new Date(),
    };
  }
}
