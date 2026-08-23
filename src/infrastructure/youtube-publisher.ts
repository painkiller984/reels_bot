import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { ArtifactStore, SocialPublisher } from "../application/ports.js";
import type { ContentJob, Platform } from "../domain/job.js";
import { YoutubeAuthService } from "./youtube-auth.js";

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
    if (!result.data.id) throw new Error("YouTube did not return a video ID");
    const metrics = await this.getMetrics(job.userId, platform, result.data.id);
    return {
      url: `https://www.youtube.com/watch?v=${result.data.id}`,
      externalId: result.data.id,
      ...(metrics ? { metrics } : {}),
    };
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
