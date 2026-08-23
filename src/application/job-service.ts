import { BriefSchema, type Brief, type ContentJob, type JobStatus } from "../domain/job.js";
import { assertTransition } from "../domain/workflow.js";
import { workflowTransitions } from "../domain/workflow.js";
import type { ArtifactStore, JobRepository, MediaPipeline, ScriptGenerator, SocialPublisher } from "./ports.js";

export class JobNotFoundError extends Error {}
export class JobAccessError extends Error {}
const automaticRecoveryMarker = "[automatic-recovery-attempted]";

export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly scripts: ScriptGenerator,
    private readonly media: MediaPipeline,
    private readonly publisher: SocialPublisher,
    private readonly artifactStore: ArtifactStore,
  ) {}

  async create(userId: string, input: unknown): Promise<ContentJob> {
    const brief = BriefSchema.parse(input);
    const now = new Date();
    const job: ContentJob = {
      id: await this.jobs.nextId(),
      userId,
      status: "draft",
      brief,
      artifacts: [],
      publications: brief.platforms.map((platform) => ({ platform, status: "pending" })),
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.save(job);
    await this.move(job, "brief_ready");
    return job;
  }

  async produce(userId: string, id: string): Promise<ContentJob> {
    const job = await this.ownedJob(userId, id);
    await this.move(job, "script_generating");
    job.script = await this.scripts.generate(job.brief);
    await this.move(job, "script_review");

    await this.move(job, "audio_generating");
    const audioUri = await this.media.synthesizeSpeech(job);
    job.artifacts.push({ kind: "audio", uri: audioUri, createdAt: new Date() });

    await this.move(job, "avatar_generating");
    const avatarUri = await this.media.createAvatar(job, audioUri);
    job.artifacts.push({ kind: "avatar_video", uri: avatarUri, createdAt: new Date() });

    await this.move(job, "rendering");
    const renderUri = await this.media.render(job, avatarUri);
    job.artifacts.push({ kind: "render", uri: renderUri, createdAt: new Date() });

    await this.move(job, "quality_check");
    const reportUri = await this.media.validate(job, renderUri);
    job.artifacts.push({ kind: "quality_report", uri: reportUri, createdAt: new Date() });
    for (const artifact of job.artifacts) {
      artifact.uri = await this.artifactStore.persist(job.id, artifact);
    }
    delete job.error;
    await this.jobs.save(job);
    await this.move(job, "ready_for_approval");
    return job;
  }

  async publish(userId: string, id: string): Promise<ContentJob> {
    const job = await this.ownedJob(userId, id);
    await this.move(job, "publishing");

    let successCount = 0;
    for (const publication of job.publications) {
      try {
        publication.url = await this.publisher.publish(job, publication.platform);
        publication.status = "published";
        successCount += 1;
      } catch (error) {
        publication.status = "failed";
        publication.error = error instanceof Error ? error.message : String(error);
      }
      job.updatedAt = new Date();
      await this.jobs.save(job);
    }

    if (successCount === 0) {
      job.error = "Не удалось опубликовать ролик ни на одной платформе";
      await this.move(job, "failed");
    } else {
      await this.move(job, "published");
    }
    return job;
  }

  async get(userId: string, id: string): Promise<ContentJob> {
    return this.ownedJob(userId, id);
  }

  async list(userId: string): Promise<ContentJob[]> {
    return this.jobs.listByUser(userId);
  }

  async fail(userId: string, id: string, error: unknown): Promise<ContentJob> {
    const job = await this.ownedJob(userId, id);
    job.error = error instanceof Error ? error.message : String(error);
    if (workflowTransitions[job.status].includes("failed")) {
      await this.move(job, "failed");
    } else {
      job.updatedAt = new Date();
      await this.jobs.save(job);
    }
    return job;
  }

  async resetProductionAfterRestart(userId: string, id: string): Promise<ContentJob> {
    let job = await this.ownedJob(userId, id);
    if (job.error?.includes(automaticRecoveryMarker)) {
      return this.fail(userId, id, "Автоматическое восстановление уже выполнялось. Используйте /retry после проверки настроек, чтобы избежать цикла перезапусков");
    }
    if (job.status !== "brief_ready") {
      job = await this.fail(userId, id, "Производство было прервано перезапуском и поставлено заново");
      if (job.status !== "failed") return job;
      await this.move(job, "brief_ready");
    }
    job.error = `${automaticRecoveryMarker} Производство один раз автоматически восстановлено после перезапуска`;
    delete job.script;
    job.artifacts = [];
    job.updatedAt = new Date();
    await this.jobs.save(job);
    return job;
  }

  async retryFailedProduction(userId: string, id: string): Promise<ContentJob> {
    const job = await this.ownedJob(userId, id);
    if (job.status !== "failed") {
      throw new Error(`Повтор доступен только для задачи со статусом failed, сейчас: ${job.status}`);
    }
    await this.move(job, "brief_ready");
    delete job.error;
    delete job.script;
    job.artifacts = [];
    job.publications = job.brief.platforms.map((platform) => ({ platform, status: "pending" }));
    job.updatedAt = new Date();
    await this.jobs.save(job);
    return job;
  }

  async cancel(userId: string, id: string): Promise<ContentJob> {
    const job = await this.ownedJob(userId, id);
    const cancellable: JobStatus[] = ["draft", "brief_ready", "needs_user_input", "ready_for_approval", "failed"];
    if (!cancellable.includes(job.status)) {
      throw new Error(`Задачу нельзя безопасно отменить в статусе ${job.status}`);
    }
    await this.move(job, "cancelled");
    return job;
  }

  private async ownedJob(userId: string, id: string): Promise<ContentJob> {
    const job = await this.jobs.findById(id);
    if (!job) throw new JobNotFoundError(`Задача ${id} не найдена`);
    if (job.userId !== userId) throw new JobAccessError(`Нет доступа к задаче ${id}`);
    return job;
  }

  private async move(job: ContentJob, status: JobStatus): Promise<void> {
    assertTransition(job.status, status);
    job.status = status;
    job.updatedAt = new Date();
    await this.jobs.save(job);
  }
}
