import { JobService } from "./application/job-service.js";
import { InProcessJobQueue, type QueueErrorHandler } from "./application/job-queue.js";
import { RecoveryService } from "./application/recovery-service.js";
import type { ArtifactStore, JobRepository } from "./application/ports.js";
import type { MediaPipeline, ScriptGenerator, SocialPublisher } from "./application/ports.js";
import { InMemoryJobRepository } from "./infrastructure/in-memory-job-repository.js";
import { MockMediaPipeline, MockScriptGenerator, MockSocialPublisher } from "./infrastructure/mock-providers.js";
import { LocalArtifactStore } from "./infrastructure/artifact-store.js";

export function createContainer(
  repository: JobRepository = new InMemoryJobRepository(),
  onQueueError?: QueueErrorHandler,
  media: MediaPipeline = new MockMediaPipeline(),
  scripts: ScriptGenerator = new MockScriptGenerator(),
  publisher: SocialPublisher = new MockSocialPublisher(),
  artifactStore: ArtifactStore = new LocalArtifactStore(),
) {
  const jobService = new JobService(
    repository,
    scripts,
    media,
    publisher,
    artifactStore,
  );
  const queue = new InProcessJobQueue(jobService, onQueueError);
  const recovery = new RecoveryService(repository, jobService, queue);
  return { repository, jobService, queue, recovery };
}
