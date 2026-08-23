import type { MediaPipeline, ScriptGenerator, SocialPublisher } from "../application/ports.js";
import type { Brief, ContentJob, Platform, Script } from "../domain/job.js";

export class MockScriptGenerator implements ScriptGenerator {
  async generate(brief: Brief): Promise<Script> {
    return {
      hook: `Вы знали самое важное про «${brief.topic}»?`,
      body: `За ${brief.durationSec} секунд разберём тему «${brief.topic}» простым языком для аудитории: ${brief.audience}.`,
      callToAction: brief.callToAction ?? "Сохраните ролик и подпишитесь, чтобы не пропустить продолжение.",
    };
  }
}

export class MockMediaPipeline implements MediaPipeline {
  async synthesizeSpeech(job: ContentJob): Promise<string> {
    return `mock://jobs/${job.id}/voice.mp3`;
  }

  async createAvatar(job: ContentJob): Promise<string> {
    return `mock://jobs/${job.id}/avatar.mp4`;
  }

  async render(job: ContentJob): Promise<string> {
    return `mock://jobs/${job.id}/final.mp4`;
  }

  async validate(job: ContentJob): Promise<string> {
    return `mock://jobs/${job.id}/quality.json`;
  }
}

export class MockSocialPublisher implements SocialPublisher {
  async publish(job: ContentJob, platform: Platform): Promise<string> {
    return `https://example.com/${platform}/mock-${job.id}`;
  }
}
