import type { Artifact, Brief, ContentJob, JobStatus, Platform, Script } from "../domain/job.js";

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
  publish(job: ContentJob, platform: Platform): Promise<{
    url: string;
    externalId: string;
    metrics?: { views: number; likes: number; comments: number; capturedAt: Date };
  }>;
  getMetrics(userId: string, platform: Platform, externalId: string): Promise<{
    views: number;
    likes: number;
    comments: number;
    capturedAt: Date;
  } | undefined>;
}

export interface ArtifactStore {
  readonly name: string;
  persist(jobId: string, artifact: Artifact): Promise<string>;
  materialize(uri: string): Promise<string>;
  createDownloadUrl(uri: string): Promise<string | undefined>;
}
