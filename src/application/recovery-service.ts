import type { JobQueue } from "./job-queue.js";
import type { JobService } from "./job-service.js";
import type { JobRepository } from "./ports.js";
import type { JobStatus } from "../domain/job.js";

const productionStatuses: JobStatus[] = [
  "brief_ready",
  "script_generating",
  "script_review",
  "audio_generating",
  "avatar_generating",
  "rendering",
  "quality_check",
];

export interface RecoveryResult {
  productionRequeued: number;
  publicationsStopped: number;
}

export class RecoveryService {
  constructor(
    private readonly repository: JobRepository,
    private readonly jobs: JobService,
    private readonly queue: JobQueue,
  ) {}

  async recover(): Promise<RecoveryResult> {
    const interrupted = await this.repository.listByStatuses([...productionStatuses, "publishing"]);
    let productionRequeued = 0;
    let publicationsStopped = 0;

    for (const job of interrupted) {
      if (job.status === "publishing") {
        await this.jobs.fail(job.userId, job.id, "Публикация была прервана. Повторите её вручную, чтобы избежать дублей");
        publicationsStopped += 1;
        continue;
      }
      const reset = await this.jobs.resetProductionAfterRestart(job.userId, job.id);
      if (reset.status === "brief_ready" && this.queue.enqueue("produce", job.userId, job.id)) {
        productionRequeued += 1;
      }
    }
    return { productionRequeued, publicationsStopped };
  }
}
