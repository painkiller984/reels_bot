import { createContainer } from "./container.js";
import { formatJob } from "./presentation/formatters.js";

const { jobService, queue } = createContainer();
const userId = "demo-user";
const job = await jobService.create(userId, {
  topic: "Как автоматизация экономит время создателя контента",
  productImageFileId: "demo-product-image",
  platforms: ["youtube", "instagram", "tiktok"],
});
queue.enqueue("produce", userId, job.id);
await queue.drain();
queue.enqueue("publish", userId, job.id);
await queue.drain();
const published = await jobService.get(userId, job.id);
console.log(formatJob(published));
