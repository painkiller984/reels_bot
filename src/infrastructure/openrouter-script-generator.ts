import OpenAI from "openai";
import type { ScriptGenerator } from "../application/ports.js";
import { ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { TelegramFileClient } from "./telegram-file-client.js";

export interface OpenRouterScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
}

export class OpenRouterScriptGenerator implements ScriptGenerator {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenRouterScriptOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "X-OpenRouter-Title": "AI Reels Telegram Bot" },
    });
  }

  async generate(brief: Brief): Promise<Script> {
    const productImage = this.options.telegramFiles
      ? await this.options.telegramFiles.dataUrl(brief.productImageFileId)
      : undefined;
    const response = await this.client.chat.completions.create({
      model: this.options.model,
      messages: [
        {
          role: "system",
          content:
            "Ты редактор коротких вертикальных видео. Сначала мысленно создай черновик, затем раскритикуй и исправь его. " +
            "Верни только JSON с полями hook, body, callToAction. Текст должен естественно звучать вслух, начинаться без приветствия, " +
            "соответствовать заданной длительности и не содержать непроверяемых обещаний.",
        },
        {
          role: "user",
          content: productImage
            ? [
                { type: "text", text: `Проанализируй изображение продукта и создай сценарий по брифу: ${JSON.stringify(brief)}` },
                { type: "image_url", image_url: { url: productImage } },
              ]
            : JSON.stringify(brief),
        },
      ],
    });
    const text = response.choices[0]?.message.content?.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (!text) throw new Error("OpenRouter did not return a script");
    return ScriptSchema.parse(JSON.parse(text));
  }
}
