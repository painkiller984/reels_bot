import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContentJob } from "../domain/job.js";

export interface BrollBackgroundGenerator {
  generate(job: ContentJob, referenceFile: string, outputDirectory: string): Promise<string[]>;
}

export interface OpenRouterProductImageOptions {
  apiKey: string;
  model: string;
  imageCount: number;
}

interface ImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: { message?: string };
}

function looksLikeSoftware(topic: string): boolean {
  return /(?:приложени|сервис|сайт|интерфейс|software|\bapp\b|dashboard|saas)/iu.test(topic);
}

export class OpenRouterBrollBackgroundGenerator implements BrollBackgroundGenerator {
  constructor(private readonly options: OpenRouterProductImageOptions) {}

  async generate(job: ContentJob, _referenceFile: string, outputDirectory: string): Promise<string[]> {
    if (looksLikeSoftware(job.brief.topic)) return [];
    const response = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        "X-OpenRouter-Title": "AI Reels Telegram Bot",
      },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: this.options.model,
        prompt:
          `Create a premium realistic vertical advertising BACKGROUND for a short video about: ${job.brief.topic}. ` +
          `The real product photograph will be composited later, so do not draw, imitate or alter the product itself. ` +
          `Do not add packaging, labels, logos, claims or text. Leave a clean foreground display area for the real product. ` +
          `A person may naturally point toward the empty display area, but must not hold or cover a generated product.`,
        n: this.options.imageCount,
        resolution: "1K",
        aspect_ratio: "9:16",
        output_format: "png",
      }),
    });
    const body = await response.json() as ImageResponse;
    if (!response.ok) throw new Error(body.error?.message ?? `OpenRouter image HTTP ${response.status}`);
    const outputs: string[] = [];
    for (const [index, image] of (body.data ?? []).entries()) {
      if (!image.b64_json) continue;
      const extension = image.media_type === "image/webp" ? "webp" : image.media_type === "image/jpeg" ? "jpg" : "png";
      const destination = resolve(outputDirectory, `generated-broll-${index + 1}.${extension}`);
      await writeFile(destination, Buffer.from(image.b64_json, "base64"));
      outputs.push(destination);
    }
    return outputs;
  }
}
