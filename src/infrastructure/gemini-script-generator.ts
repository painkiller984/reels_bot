import type { ScriptGenerator } from "../application/ports.js";
import { productImageIds, ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { createFallbackScript, normalizeMontagePlan, parseScriptResponse, scriptJsonSchema } from "./openrouter-script-generator.js";
import { TelegramFileClient } from "./telegram-file-client.js";

export interface GeminiScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

function inlineImage(dataUrl: string): { inlineData: { mimeType: string; data: string } } {
  const match = /^data:([^;]+);base64,(.+)$/su.exec(dataUrl);
  if (!match) throw new Error("Некорректное изображение для Gemini");
  return { inlineData: { mimeType: match[1]!, data: match[2]! } };
}

export class GeminiScriptGenerator implements ScriptGenerator {
  constructor(private readonly options: GeminiScriptOptions) {}

  async generate(brief: Brief): Promise<Script> {
    const productImages = this.options.telegramFiles
      ? await Promise.all(productImageIds(brief).map((fileId) => this.options.telegramFiles!.dataUrl(fileId)))
      : [];
    const requestedWords = Math.max(15, Math.round(brief.durationSec * 2.05));
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
          signal: AbortSignal.timeout(25_000),
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                {
                  text:
                    "Ты режиссёр коротких вертикальных рекламных видео. Проанализируй все приложенные изображения " +
                    "как материалы одного продукта или приложения. Верни сценарий и динамичный монтажный план с 4–7 сценами. " +
                    "Чередуй аватара, полноэкранный товар и карточки, выбирай разные разрешённые motion/transition. " +
                    "generatedVisuals добавляй только для недостающих фонов, максимум два, без товара, логотипов, текста и вымышленных интерфейсов. " +
                    "Сценарий должен быть без приветствия и непроверяемых обещаний. " +
                    `Язык: ${brief.language}. Примерный объём: ${requestedWords} слов. Бриф: ${JSON.stringify(brief)}`,
                },
                ...productImages.map(inlineImage),
              ],
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: scriptJsonSchema.schema,
              thinkingConfig: { thinkingLevel: "minimal" },
            },
          }),
        });
        const body = await response.json() as GeminiResponse;
        if (!response.ok) throw new Error(body.error?.message ?? `Gemini HTTP ${response.status}`);
        const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
        if (!text) throw new Error("Gemini не вернул сценарий");
        return normalizeMontagePlan(brief, parseScriptResponse(text, brief.durationSec));
      } catch {
        if (attempt === 3) return createFallbackScript(brief);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    }
    return ScriptSchema.parse(createFallbackScript(brief));
  }
}
