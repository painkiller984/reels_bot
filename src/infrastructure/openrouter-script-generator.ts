import OpenAI from "openai";
import type { ScriptGenerator } from "../application/ports.js";
import { ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { TelegramFileClient } from "./telegram-file-client.js";

export interface OpenRouterScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
}

const scriptJsonSchema = {
  name: "reel_script",
  strict: true,
  schema: {
    type: "object",
    properties: {
      hook: { type: "string", minLength: 1, description: "Короткий хук без приветствия" },
      body: { type: "string", minLength: 1, description: "Основная часть сценария" },
      callToAction: { type: "string", minLength: 1, description: "Призыв к действию" },
    },
    required: ["hook", "body", "callToAction"],
    additionalProperties: false,
  },
} as const;

function spokenWordCount(script: Script): number {
  return [script.hook, script.body, script.callToAction]
    .join(" ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

export function parseScriptResponse(text: string, durationSec: number): Script {
  const withoutFence = text.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error("OpenRouter response does not contain JSON");
  const script = ScriptSchema.parse(JSON.parse(withoutFence.slice(objectStart, objectEnd + 1)));
  const words = spokenWordCount(script);
  const minimumWords = Math.max(10, Math.floor(durationSec * 0.65));
  const maximumWords = Math.ceil(durationSec * 2.8);
  if (words < minimumWords || words > maximumWords) {
    throw new Error(`OpenRouter script length is unsuitable: ${words} words for ${durationSec} seconds`);
  }
  return script;
}

export function createFallbackScript(brief: Brief): Script {
  const topic = brief.topic.replace(/\s+/gu, " ").trim().replace(/[.!?]+$/u, "").slice(0, 60);
  const suppliedCallToAction = brief.callToAction?.trim().split(/\s+/u).slice(0, 12).join(" ");
  const callToAction = suppliedCallToAction
    || (brief.goal === "sales" ? "Посмотрите детали перед выбором." : "Сохраните ролик, чтобы не потерять.");
  return ScriptSchema.parse({
    hook: `${topic}: главное за несколько секунд.`,
    body: brief.durationSec <= 15
      ? "Посмотрите на продукт: оцените его назначение, основные функции и удобство для вашей задачи."
      : "На изображении показан продукт для поставленной задачи. Оцените его основные функции, удобство и соответствие вашим требованиям. Перед выбором проверьте характеристики и условия использования.",
    callToAction,
  });
}

export class OpenRouterScriptGenerator implements ScriptGenerator {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenRouterScriptOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 25_000,
      maxRetries: 0,
      defaultHeaders: { "X-OpenRouter-Title": "AI Reels Telegram Bot" },
    });
  }

  async generate(brief: Brief): Promise<Script> {
    const productImage = this.options.telegramFiles
      ? await this.options.telegramFiles.dataUrl(brief.productImageFileId)
      : undefined;
    const requestedWords = Math.max(15, Math.round(brief.durationSec * 2.05));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const strictStructuredOutput = attempt === 1;
        const response = await this.client.chat.completions.create({
          model: this.options.model,
          temperature: 0.35,
          ...(strictStructuredOutput ? {
            response_format: { type: "json_schema", json_schema: scriptJsonSchema },
            provider: { require_parameters: true },
          } : {}),
          messages: [
            {
              role: "system",
              content:
                "Ты редактор коротких вертикальных видео. Верни строго JSON-объект с полями hook, body и callToAction. " +
                "Текст должен естественно звучать вслух, начинаться без приветствия, не содержать непроверяемых обещаний, " +
                `состоять примерно из ${requestedWords} слов и быть написан на языке ${brief.language}. ` +
                "Не добавляй служебные пометки, Markdown и пояснения.",
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
        } as never);
        const text = response.choices[0]?.message.content;
        if (!text) throw new Error("OpenRouter did not return a script");
        return parseScriptResponse(text, brief.durationSec);
      } catch (error) {
        if (attempt === 3) return createFallbackScript(brief);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    }
    return createFallbackScript(brief);
  }
}
