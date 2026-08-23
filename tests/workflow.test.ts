import { describe, expect, it } from "vitest";
import { createContainer } from "../src/container.js";
import { InvalidTransitionError, assertTransition } from "../src/domain/workflow.js";
import type { MediaPipeline } from "../src/application/ports.js";

describe("content workflow", () => {
  const productImageFileId = "telegram-product-image";
  it("produces and publishes a reel", async () => {
    const { jobService } = createContainer();
    const job = await jobService.create("user-1", {
      topic: "Три способа улучшить хук",
      productImageFileId,
      platforms: ["youtube", "tiktok"],
    });

    const ready = await jobService.produce("user-1", job.id);
    expect(ready.status).toBe("ready_for_approval");
    expect(ready.script?.hook).toContain("Три способа улучшить хук");
    expect(ready.artifacts).toHaveLength(4);

    const published = await jobService.publish("user-1", job.id);
    expect(published.status).toBe("published");
    expect(published.publications.every((item) => item.status === "published")).toBe(true);
    expect(published.publications.every((item) => item.metrics?.views === 0)).toBe(true);
  });

  it("does not persist HeyGen integrated TTS control URIs as files", async () => {
    const media: MediaPipeline = {
      synthesizeSpeech: async () => "heygen://tts/integrated",
      createAvatar: async () => "avatar.mp4",
      render: async () => "final.mp4",
      validate: async () => "quality.json",
    };
    const persisted: string[] = [];
    const { jobService } = createContainer(undefined, undefined, media, undefined, undefined, {
      name: "test",
      persist: async (_jobId, artifact) => {
        persisted.push(artifact.uri);
        return artifact.uri;
      },
      materialize: async (uri) => uri,
      createDownloadUrl: async () => undefined,
    });
    const job = await jobService.create("heygen-user", { topic: "Интегрированная озвучка", productImageFileId });

    const ready = await jobService.produce("heygen-user", job.id);

    expect(ready.status).toBe("ready_for_approval");
    expect(ready.artifacts.some((artifact) => artifact.uri.startsWith("heygen://"))).toBe(false);
    expect(persisted).toEqual(["avatar.mp4", "final.mp4", "quality.json"]);
  });

  it("rejects an invalid transition", () => {
    expect(() => assertTransition("draft", "published")).toThrow(InvalidTransitionError);
  });

  it("runs production outside the command lifecycle", async () => {
    const { jobService, queue } = createContainer();
    const job = await jobService.create("user-2", { topic: "Фоновая генерация видео", productImageFileId });

    expect(queue.enqueue("produce", "user-2", job.id)).toBe(true);
    expect(queue.enqueue("produce", "user-2", job.id)).toBe(false);
    expect(queue.pendingCount()).toBe(1);

    await queue.drain();
    expect((await jobService.get("user-2", job.id)).status).toBe("ready_for_approval");
    expect(queue.pendingCount()).toBe(0);
  });

  it("recovers interrupted production after restart", async () => {
    const { repository, jobService, queue, recovery } = createContainer();
    const job = await jobService.create("user-3", { topic: "Восстановление очереди", productImageFileId });
    job.status = "audio_generating";
    await repository.save(job);

    const result = await recovery.recover();
    expect(result.productionRequeued).toBe(1);
    await queue.drain();
    expect((await jobService.get("user-3", job.id)).status).toBe("ready_for_approval");
  });

  it("resumes from persisted expensive artifacts instead of paying for them again", async () => {
    const calls = { script: 0, audio: 0, avatar: 0, render: 0, validate: 0 };
    const media: MediaPipeline = {
      synthesizeSpeech: async () => { calls.audio += 1; return "new-audio.mp3"; },
      createAvatar: async () => { calls.avatar += 1; return "new-avatar.mp4"; },
      render: async () => { calls.render += 1; return "new-render.mp4"; },
      validate: async () => { calls.validate += 1; return "new-quality.json"; },
    };
    const { repository, jobService } = createContainer(undefined, undefined, media, {
      generate: async () => { calls.script += 1; throw new Error("script must be reused"); },
    }, undefined, {
      name: "durable-test",
      persist: async (jobId, artifact) => `r2://bucket/${jobId}/${artifact.kind}`,
      materialize: async (uri) => `materialized-${uri.split("/").at(-1)}`,
      createDownloadUrl: async () => undefined,
    });
    const job = await jobService.create("durable-user", { topic: "Возобновляемый ролик", productImageFileId });
    job.script = {
      hook: "Готовый хук.",
      body: "Готовый основной текст сценария.",
      callToAction: "Посмотрите подробнее.",
    };
    job.artifacts = [
      { kind: "audio", uri: "r2://bucket/job/audio", createdAt: new Date() },
      { kind: "avatar_video", uri: "r2://bucket/job/avatar", createdAt: new Date() },
    ];
    await repository.save(job);

    const ready = await jobService.produce("durable-user", job.id);

    expect(ready.status).toBe("ready_for_approval");
    expect(calls).toEqual({ script: 0, audio: 0, avatar: 0, render: 1, validate: 1 });
    expect(ready.artifacts.every((artifact) => artifact.uri.startsWith("r2://"))).toBe(true);
  });

  it("does not endlessly recover the same crashing production", async () => {
    const { repository, jobService } = createContainer();
    const job = await jobService.create("user-recovery-loop", { topic: "Защита от цикла", productImageFileId });
    job.status = "rendering";
    await repository.save(job);

    const first = await jobService.resetProductionAfterRestart("user-recovery-loop", job.id);
    expect(first.status).toBe("brief_ready");
    expect(first.error).toContain("automatic-recovery-attempted");

    const second = await jobService.resetProductionAfterRestart("user-recovery-loop", job.id);
    expect(second.status).toBe("failed");
    expect(second.error).toContain("Автоматическое восстановление уже выполнялось");
  });

  it("can stop interrupted jobs instead of restarting them on a small cloud instance", async () => {
    const { repository, jobService, recovery } = createContainer(undefined, undefined, undefined, undefined, undefined, undefined, false);
    const job = await jobService.create("user-safe-recovery", { topic: "Ручное восстановление", productImageFileId });
    job.status = "rendering";
    await repository.save(job);

    const result = await recovery.recover();
    expect(result.productionRequeued).toBe(0);
    expect((await jobService.get("user-safe-recovery", job.id)).status).toBe("failed");
  });

  it("retries a failed production from the beginning", async () => {
    const { repository, jobService, queue } = createContainer();
    const job = await jobService.create("user-4", { topic: "Повтор после ошибки", productImageFileId });
    job.status = "failed";
    job.error = "temporary provider failure";
    await repository.save(job);

    await jobService.retryFailedProduction("user-4", job.id);
    queue.enqueue("produce", "user-4", job.id);
    await queue.drain();

    const completed = await jobService.get("user-4", job.id);
    expect(completed.status).toBe("ready_for_approval");
    expect(completed.error).toBeUndefined();
  });

  it("cancels a task before expensive production starts", async () => {
    const { jobService } = createContainer();
    const job = await jobService.create("user-5", { topic: "Отмена задачи", productImageFileId });
    expect((await jobService.cancel("user-5", job.id)).status).toBe("cancelled");
  });

  it("keeps several supplied product images in one brief", async () => {
    const { jobService } = createContainer();
    const job = await jobService.create("user-6", {
      topic: "Три ракурса продукта",
      productImageFileId,
      productImageFileIds: [productImageFileId, "second", "third"],
    });
    expect(job.brief.productImageFileIds).toEqual([productImageFileId, "second", "third"]);
  });
});
