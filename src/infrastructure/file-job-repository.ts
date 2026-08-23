import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JobRepository } from "../application/ports.js";
import { ArtifactSchema, BriefSchema, JobStatusSchema, PublicationSchema, ScriptSchema, type ContentJob, type JobStatus } from "../domain/job.js";

interface StoredJob extends Omit<ContentJob, "createdAt" | "updatedAt" | "artifacts"> {
  createdAt: string;
  updatedAt: string;
  artifacts: Array<Omit<ContentJob["artifacts"][number], "createdAt"> & { createdAt: string }>;
}

function decode(value: unknown): ContentJob[] {
  if (!Array.isArray(value)) throw new Error("Invalid jobs data file: expected an array");
  return value.map((raw) => {
    const row = raw as Record<string, unknown>;
    const job: ContentJob = {
      id: String(row.id),
      userId: String(row.userId),
      status: JobStatusSchema.parse(row.status),
      brief: BriefSchema.parse(row.brief),
      artifacts: ArtifactSchema.array().parse(row.artifacts),
      publications: PublicationSchema.array().parse(row.publications),
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    };
    if (row.script) job.script = ScriptSchema.parse(row.script);
    if (row.error) job.error = String(row.error);
    return job;
  });
}

export class FileJobRepository implements JobRepository {
  private readonly path: string;
  private operation: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async nextId(): Promise<string> {
    return randomUUID().replaceAll("-", "").slice(0, 10);
  }

  async save(job: ContentJob): Promise<void> {
    await this.exclusive(async () => {
      const jobs = await this.readAll();
      const index = jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) jobs[index] = structuredClone(job);
      else jobs.push(structuredClone(job));
      await this.writeAll(jobs);
    });
  }

  async findById(id: string): Promise<ContentJob | undefined> {
    await this.operation;
    return structuredClone((await this.readAll()).find((job) => job.id === id));
  }

  async listByUser(userId: string): Promise<ContentJob[]> {
    await this.operation;
    return (await this.readAll())
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((job) => structuredClone(job));
  }

  async listByStatuses(statuses: JobStatus[]): Promise<ContentJob[]> {
    await this.operation;
    return (await this.readAll())
      .filter((job) => statuses.includes(job.status))
      .map((job) => structuredClone(job));
  }

  private async readAll(): Promise<ContentJob[]> {
    try {
      return decode(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(jobs: ContentJob[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const stored = jobs satisfies ContentJob[] as unknown as StoredJob[];
    await writeFile(temporaryPath, JSON.stringify(stored, null, 2), "utf8");
    await rename(temporaryPath, this.path);
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    await next;
  }
}
