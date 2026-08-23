import { describe, expect, it } from "vitest";
import { createContainer } from "../src/container.js";
import { InvalidTransitionError, assertTransition } from "../src/domain/workflow.js";

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
