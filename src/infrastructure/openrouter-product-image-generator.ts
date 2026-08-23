import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ContentJob, GeneratedVisualRequest } from "../domain/job.js";

export interface GeneratedBackground {
  id: GeneratedVisualRequest["id"];
  path: string;
}

export interface BrollBackgroundGenerator {
  readonly model: string;
  readonly estimatedCostPerImageUsd: number;
  generate(job: ContentJob, requests: GeneratedVisualRequest[], outputDirectory: string): Promise<GeneratedBackground[]>;
}

export interface OpenRouterProductImageOptions {
  apiKey: string;
  model: string;
  imageCount: number;
  estimatedCostPerImageUsd?: number;
}

interface ImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: { message?: string };
}

export class OpenRouterBrollBackgroundGenerator implements BrollBackgroundGenerator {
  readonly model: string;
  readonly estimatedCostPerImageUsd: number;

  constructor(private readonly options: OpenRouterProductImageOptions) {
    this.model = options.model;
    this.estimatedCostPerImageUsd = options.estimatedCostPerImageUsd ?? 0.0336;
  }

  async generate(job: ContentJob, requests: GeneratedVisualRequest[], outputDirectory: string): Promise<GeneratedBackground[]> {
    const selected = requests.slice(0, this.options.imageCount);
    const results = await Promise.allSettled(selected.map((request) => this.generateOne(job, request, outputDirectory)));
    return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  private async generateOne(job: ContentJob, request: GeneratedVisualRequest, outputDirectory: string): Promise<GeneratedBackground | undefined> {
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
          `Create a premium realistic vertical advertising ${request.purpose.toUpperCase()} for a short video about: ${job.brief.topic}. ` +
          `Creative direction: ${request.prompt}. ` +
          `The real product photograph will be composited later, so do not draw, imitate or alter the product itself. ` +
          `Do not add packaging, devices, app screens, UI, labels, logos, claims or text. Leave a clean foreground display area for the real product or screenshot. ` +
          `A person may naturally point toward the empty display area, but must not hold or cover a generated product.`,
        n: 1,
        resolution: "1K",
        aspect_ratio: "9:16",
        output_format: "png",
      }),
    });
    const body = await response.json() as ImageResponse;
    if (!response.ok) throw new Error(body.error?.message ?? `OpenRouter image HTTP ${response.status}`);
    const image = body.data?.find((item) => item.b64_json);
    if (!image?.b64_json) return undefined;
    const extension = image.media_type === "image/webp" ? "webp" : image.media_type === "image/jpeg" ? "jpg" : "png";
    const destination = resolve(outputDirectory, `${request.id}.${extension}`);
    await writeFile(destination, Buffer.from(image.b64_json, "base64"));
    return { id: request.id, path: destination };
  }
}
