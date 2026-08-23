import { resolve } from "node:path";
import { createContainer } from "./container.js";
import { FileJobRepository } from "./infrastructure/file-job-repository.js";
import { LocalMediaPipeline } from "./infrastructure/local-media-pipeline.js";
import { formatJob } from "./presentation/formatters.js";
import { resolveExecutable } from "./infrastructure/executable-resolver.js";

const repository = new FileJobRepository(".data/local-demo-jobs.json");
const media = new LocalMediaPipeline({
  artifactsDir: "artifacts",
  ffmpegPath: resolveExecutable(process.env.FFMPEG_PATH ?? "ffmpeg", "ffmpeg"),
  ffprobePath: resolveExecutable(process.env.FFPROBE_PATH ?? "ffprobe", "ffprobe"),
});
const { jobService, queue } = createContainer(repository, undefined, media);
const job = await jobService.create("local-demo", {
  topic: "Рабочая локальная проверка Reels Bot",
  productImageFileId: "local-demo-product-image",
  durationSec: 10,
  platforms: ["youtube"],
});
queue.enqueue("produce", "local-demo", job.id);
await queue.drain();
const completed = await jobService.get("local-demo", job.id);
console.log(formatJob(completed));
const render = completed.artifacts.find((artifact) => artifact.kind === "render");
if (!render) throw new Error("Local render was not created");
console.log(`Готовый MP4: ${resolve(render.uri)}`);
