import { createReadStream } from "node:fs";
import { google } from "googleapis";
import type { SocialPublisher } from "../application/ports.js";
import type { ContentJob, Platform } from "../domain/job.js";
import { YoutubeAuthService } from "./youtube-auth.js";

export class YoutubePublisher implements SocialPublisher {
  constructor(private readonly auth: YoutubeAuthService, private readonly privacyStatus: "private" | "unlisted" | "public") {}

  async publish(job: ContentJob, platform: Platform): Promise<string> {
    if (platform !== "youtube") throw new Error(`${platform}: публикация ещё не подключена`);
    const video = job.artifacts.find((artifact) => artifact.kind === "render")?.uri;
    if (!video) throw new Error("Не найден готовый MP4 для публикации");
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
    return `https://www.youtube.com/watch?v=${result.data.id}`;
  }
}
