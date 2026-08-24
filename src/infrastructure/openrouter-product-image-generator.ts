import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { productImageIds, type ContentJob, type GeneratedVisualRequest } from "../domain/job.js";
import { TelegramFileClient } from "./telegram-file-client.js";

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
  telegramFiles?: TelegramFileClient;
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
    const references = this.options.telegramFiles
      ? await Promise.all(productImageIds(job.brief).map((fileId) => this.options.telegramFiles!.dataUrl(fileId, 30_000)))
      : [];
    const results = await Promise.allSettled(selected.map(async (request) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await this.generateOne(job, request, outputDirectory, references);
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        }
      }
      throw lastError;
    }));
    return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  private async generateOne(job: ContentJob, request: GeneratedVisualRequest, outputDirectory: string, references: string[]): Promise<GeneratedBackground | undefined> {
    const isReferenceScene = request.purpose === "reference_scene" || request.purpose === "lifestyle";
    const reference = isReferenceScene
      ? references[Math.min(references.length - 1, Math.max(0, request.productIndex ?? 0))]
      : undefined;
    if (isReferenceScene && !reference) {
      throw new Error("Reference scene requested without a source image");
    }
    const prompt = isReferenceScene
      ? `Create one premium realistic vertical advertising shot for this exact moment of a short video about: ${job.brief.topic}. ` +
        `Scene direction: ${request.prompt}. Use the supplied image as the authoritative visual reference. ` +
        `Preserve the referenced object's identity: silhouette, proportions, colors, materials, distinctive details, packaging and existing logo. ` +
        `Do not invent or replace branding, labels, claims, UI or small text. Do not default to a person holding the object unless the scene direction explicitly requires it. ` +
        `Make a coherent full-frame 9:16 composition with natural perspective and lighting; add no captions or advertising text.`
      : `Create a premium realistic vertical advertising ${request.purpose.toUpperCase()} for a short video about: ${job.brief.topic}. ` +
        `Creative direction: ${request.prompt}. ` +
        `The source image will be composited later, so do not draw, imitate or alter the product itself or the advertised object. ` +
        `Do not add packaging, devices, app screens, UI, labels, logos, claims or text. Leave a clean display area for the exact source image.`;
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
        prompt,
        ...(reference ? { input_references: [{ type: "image_url", image_url: { url: reference } }] } : {}),
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
