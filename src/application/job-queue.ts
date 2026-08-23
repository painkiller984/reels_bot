import type { JobService } from "./job-service.js";

export type BackgroundTaskKind = "produce" | "publish";

export interface JobQueue {
  enqueue(kind: BackgroundTaskKind, userId: string, jobId: string): boolean;
  pendingCount(): number;
  drain(): Promise<void>;
  onCompleted(handler: (kind: BackgroundTaskKind, userId: string, jobId: string) => void | Promise<void>): void;
}

export type QueueErrorHandler = (kind: BackgroundTaskKind, jobId: string, error: unknown) => void;

export class InProcessJobQueue implements JobQueue {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly completedHandlers: Array<(kind: BackgroundTaskKind, userId: string, jobId: string) => void | Promise<void>> = [];

  constructor(
    private readonly jobs: JobService,
    private readonly onError: QueueErrorHandler = () => undefined,
  ) {}

  enqueue(kind: BackgroundTaskKind, userId: string, jobId: string): boolean {
    const key = `${kind}:${jobId}`;
    if (this.pending.has(key)) return false;

    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        if (kind === "produce") await this.jobs.produce(userId, jobId);
        else await this.jobs.publish(userId, jobId);
        await Promise.allSettled(this.completedHandlers.map((handler) => handler(kind, userId, jobId)));
      })
      .catch(async (error: unknown) => {
        this.onError(kind, jobId, error);
        try {
          await this.jobs.fail(userId, jobId, error);
        } catch (markFailedError) {
          this.onError(kind, jobId, markFailedError);
        }
      })
      .finally(() => this.pending.delete(key));

    this.pending.set(key, task);
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending.values());
  }

  onCompleted(handler: (kind: BackgroundTaskKind, userId: string, jobId: string) => void | Promise<void>): void {
    this.completedHandlers.push(handler);
  }
}
