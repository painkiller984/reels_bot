import type { ScriptGenerator } from "../application/ports.js";
import { productImageIds, ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { createFallbackScript, normalizeMontagePlan, parseScriptResponse, scriptJsonSchema } from "./openrouter-script-generator.js";
import { TelegramFileClient } from "./telegram-file-client.js";

export interface GeminiScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
  allowFallback?: boolean;
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
                    "Ты режиссёр коротких вертикальных рекламных видео. Распознай объект ролика по всем исходным изображениям. " +
                    "Верни сценарий и уникальный монтажный план с 4–7 сценами, построенный по смыслу текста, а не по фиксированному шаблону. " +
                    "Для каждой сцены заполни beat — смысловой фрагмент сценария — и осознанно выбери под него композицию, исходник, движение и переход; соседние сцены должны различаться. " +
                    "generatedVisuals добавляй только когда сценарию нужен дополнительный кадр, максимум два. reference_scene — цельный новый кадр по выбранному исходнику; " +
                    "сам выбери уместный ракурс, окружение и действие, не своди всё к человеку с товаром. Физический объект должен оставаться узнаваемым. " +
                    "Скриншоты, интерфейсы и мелкий текст не перерисовывай. Хотя бы одна сцена показывает исходник без генеративного изменения. " +
                    "Сценарий должен быть без приветствия и непроверяемых обещаний. " +
                    `Язык: ${brief.language}. Строгий объём: от ${Math.floor(brief.durationSec * 1.45)} до ${Math.ceil(brief.durationSec * 2.5)} слов, цель — ${requestedWords}. ` +
                    (attempt > 1 ? "Предыдущий ответ не прошёл проверку: исправь объём и сохрани факты брифа. " : "") +
                    `Бриф: ${JSON.stringify(brief)}`,
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
        if (attempt === 3) {
          if (this.options.allowFallback !== false) return createFallbackScript(brief);
          throw new Error("Gemini не смог создать корректный сценарий после трёх попыток; платная генерация HeyGen не запускалась");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    }
    return ScriptSchema.parse(createFallbackScript(brief));
  }
}
