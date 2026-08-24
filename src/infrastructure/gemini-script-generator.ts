import type { ScriptGenerator } from "../application/ports.js";
import { productImageIds, ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { createFallbackScript, normalizeMontagePlan, parseScriptResponse, scriptJsonSchema, sourceVideoScriptJsonSchema } from "./openrouter-script-generator.js";
import { TelegramFileClient } from "./telegram-file-client.js";
import type { VideoContextProvider } from "./telegram-video-context.js";

export interface GeminiScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
  allowFallback?: boolean;
  videoContext?: VideoContextProvider;
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
    const videoAnalysis = brief.sourceVideoFileId && this.options.videoContext
      ? await this.options.videoContext.analyze(brief.sourceVideoFileId, brief.sourceVideoDurationSec ?? brief.durationSec)
      : undefined;
    const videoFrames = videoAnalysis?.frames ?? [];
    if (brief.sourceVideoFileId && videoFrames.length === 0 && this.options.allowFallback === false) {
      throw new Error("Не удалось получить кадры исходного видео; HeyGen не запускался");
    }
    const productImages = this.options.telegramFiles
      ? await Promise.all(productImageIds(brief).map((fileId) => this.options.telegramFiles!.dataUrl(fileId)))
      : [];
    const requestedWords = Math.max(15, Math.round(brief.durationSec * (brief.sourceVideoFileId ? 1.65 : 2.05)));
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
                    "Ты сценарист коротких вертикальных видео. Поле title — короткое естественное название из 4–8 слов по фактическому содержанию. Оно является только метаданными и не произносится. Пользовательский topic — инструкция для сценария, а не готовое название. " +
                    (brief.sourceVideoFileId
                      ? `Верни только сценарий точного обзора без монтажного плана, сцен и generatedVisuals. После текста приложены ключевые кадры и расшифровка всего исходного видео. Количество последовательных кадров от начала к концу: ${videoAnalysis?.chronologicalFrameCount ?? videoFrames.length}; остальные изображения являются дополнительными кадрами смен сцен и не продолжают хронологию. Пиши комментарий именно к показанному и сказанному материалу, не выдумывай товар, функции и события. Расшифровка: ${videoAnalysis?.transcript ?? "речь не обнаружена"}. Если в брифе есть callToAction, сохрани его смысл и поставь в конце; если его нет, верни пустую строку и закончи основной текст естественным выводом по финалу видео. `
                      : "Верни сценарий и уникальный монтажный план с 4–7 сценами по смыслу текста. Для каждой сцены выбери композицию, исходник, движение и переход. generatedVisuals добавляй только при необходимости, максимум два. Физический объект должен оставаться узнаваемым, интерфейсы и мелкий текст не перерисовывай. Хотя бы одна сцена показывает исходник без генеративного изменения. ") +
                    "Сценарий должен быть без приветствия и непроверяемых обещаний. " +
                    `Язык: ${brief.language}. Строгий объём: от ${Math.floor(brief.durationSec * (brief.sourceVideoFileId ? 1.25 : 1.45))} до ${Math.ceil(brief.durationSec * (brief.sourceVideoFileId ? 1.9 : 2.5))} слов, цель — ${requestedWords}. ` +
                    (attempt > 1 ? "Предыдущий ответ не прошёл проверку: исправь объём и сохрани факты брифа. " : "") +
                    `Бриф: ${JSON.stringify(brief)}`,
                },
                ...videoFrames.map(inlineImage),
                ...productImages.map(inlineImage),
              ],
            }],
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: brief.sourceVideoFileId ? sourceVideoScriptJsonSchema.schema : scriptJsonSchema.schema,
              thinkingConfig: { thinkingLevel: "minimal" },
            },
          }),
        });
        const body = await response.json() as GeminiResponse;
        if (!response.ok) throw new Error(body.error?.message ?? `Gemini HTTP ${response.status}`);
        const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
        if (!text) throw new Error("Gemini не вернул сценарий");
        return normalizeMontagePlan(brief, parseScriptResponse(text, brief.durationSec, Boolean(brief.sourceVideoFileId)));
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
