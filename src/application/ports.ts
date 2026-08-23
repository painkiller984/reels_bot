import type { Brief, ContentJob, JobStatus, Platform, Script } from "../domain/job.js";

export interface JobRepository {
  nextId(): Promise<string>;
  save(job: ContentJob): Promise<void>;
  findById(id: string): Promise<ContentJob | undefined>;
  listByUser(userId: string): Promise<ContentJob[]>;
  listByStatuses(statuses: JobStatus[]): Promise<ContentJob[]>;
}

export interface ScriptGenerator {
  generate(brief: Brief): Promise<Script>;
}

export interface MediaPipeline {
  synthesizeSpeech(job: ContentJob): Promise<string>;
  createAvatar(job: ContentJob, audioUri: string): Promise<string>;
  render(job: ContentJob, avatarUri: string): Promise<string>;
  validate(job: ContentJob, renderUri: string): Promise<string>;
}

export interface SocialPublisher {
  publish(job: ContentJob, platform: Platform): Promise<string>;
}
