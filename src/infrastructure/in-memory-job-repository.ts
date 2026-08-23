import type { ContentJob, JobStatus } from "../domain/job.js";
import type { JobRepository } from "../application/ports.js";

export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, ContentJob>();
  private sequence = 0;

  async nextId(): Promise<string> {
    this.sequence += 1;
    return String(this.sequence);
  }

  async save(job: ContentJob): Promise<void> {
    this.jobs.set(job.id, structuredClone(job));
  }

  async findById(id: string): Promise<ContentJob | undefined> {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  async listByUser(userId: string): Promise<ContentJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((job) => structuredClone(job));
  }

  async listByStatuses(statuses: JobStatus[]): Promise<ContentJob[]> {
    return [...this.jobs.values()]
      .filter((job) => statuses.includes(job.status))
      .map((job) => structuredClone(job));
  }
}
