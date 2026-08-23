import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { ArtifactSchema, BriefSchema, JobStatusSchema, PublicationSchema, ScriptSchema, type ContentJob, type JobStatus } from "../domain/job.js";
import type { JobRepository } from "../application/ports.js";

interface StoredJob {
  id: string;
  userId: string;
  status: string;
  brief: unknown;
  script: unknown | null;
  artifacts: unknown;
  publications: unknown;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toDomain(row: StoredJob): ContentJob {
  const base: ContentJob = {
    id: row.id,
    userId: row.userId,
    status: JobStatusSchema.parse(row.status),
    brief: BriefSchema.parse(row.brief),
    artifacts: ArtifactSchema.array().parse(row.artifacts),
    publications: PublicationSchema.array().parse(row.publications),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.script) base.script = ScriptSchema.parse(row.script);
  if (row.error) base.error = row.error;
  return base;
}

export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async nextId(): Promise<string> {
    return randomUUID().replaceAll("-", "").slice(0, 10);
  }

  async save(job: ContentJob): Promise<void> {
    const data = {
      userId: job.userId,
      status: job.status,
      brief: jsonValue(job.brief),
      script: job.script ? jsonValue(job.script) : Prisma.DbNull,
      artifacts: jsonValue(job.artifacts),
      publications: jsonValue(job.publications),
      error: job.error ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    } satisfies Prisma.ContentJobUpdateInput;
    await this.prisma.contentJob.upsert({
      where: { id: job.id },
      create: { id: job.id, ...data },
      update: data,
    });
  }

  async findById(id: string): Promise<ContentJob | undefined> {
    const row = await this.prisma.contentJob.findUnique({ where: { id } });
    return row ? toDomain(row) : undefined;
  }

  async listByUser(userId: string): Promise<ContentJob[]> {
    const rows = await this.prisma.contentJob.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map(toDomain);
  }

  async listByStatuses(statuses: JobStatus[]): Promise<ContentJob[]> {
    const rows = await this.prisma.contentJob.findMany({
      where: { status: { in: statuses } },
      orderBy: { updatedAt: "asc" },
      take: 1_000,
    });
    return rows.map(toDomain);
  }
}
