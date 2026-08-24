import OpenAI from "openai";
import type { ScriptGenerator } from "../application/ports.js";
import { createFallbackMontagePlan, MontagePlanSchema, productImageIds, ScriptSchema, type Brief, type Script } from "../domain/job.js";
import { TelegramFileClient } from "./telegram-file-client.js";
import type { VideoContextProvider } from "./telegram-video-context.js";

export interface OpenRouterScriptOptions {
  apiKey: string;
  model: string;
  telegramFiles?: TelegramFileClient;
  imageLoadTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  allowFallback?: boolean;
  videoContext?: VideoContextProvider;
}

async function within<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const scriptJsonSchema = {
  name: "reel_script",
  strict: true,
  schema: {
    type: "object",
    properties: {
      hook: { type: "string", minLength: 1, description: "Короткий хук без приветствия" },
      body: { type: "string", minLength: 1, description: "Основная часть сценария" },
      callToAction: { type: "string", minLength: 0, description: "Явный призыв к действию или пустая строка" },
      montagePlan: {
        type: "object",
        properties: {
        style: { type: "string", enum: ["dynamic", "clean", "premium", "energetic"] },
        subtitleStyle: { type: "string", enum: ["bold", "highlight", "minimal"] },
        musicMood: { type: "string", enum: ["energetic", "modern", "premium", "calm"] },
        scenes: {
          type: "array",
          minItems: 3,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["product_fullscreen", "avatar_product_card", "split_product", "generated_scene", "avatar"] },
              beat: { type: "string", minLength: 3, maxLength: 160 },
              productIndex: { type: "integer", minimum: 0, maximum: 5 },
              background: { type: "string", enum: ["none", "generated_1", "generated_2"] },
              motion: { type: "string", enum: ["zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "drift", "pulse", "fly_from_bottom", "fly_from_top", "slide_left", "slide_right", "pop", "none"] },
              transition: { type: "string", enum: ["cut", "fade", "whip_left", "whip_right", "push_up", "push_down", "zoom", "circle", "reveal", "pixelize"] },
              durationWeight: { type: "integer", minimum: 1, maximum: 5 },
            },
            required: ["kind", "beat", "productIndex", "background", "motion", "transition", "durationWeight"],
            additionalProperties: false,
          },
        },
        generatedVisuals: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              id: { type: "string", enum: ["generated_1", "generated_2"] },
              purpose: { type: "string", enum: ["background", "reference_scene", "texture"] },
              productIndex: { type: "integer", minimum: 0, maximum: 5 },
              prompt: { type: "string", minLength: 10, maxLength: 500 },
            },
            required: ["id", "purpose", "productIndex", "prompt"],
            additionalProperties: false,
          },
        },
      },
        required: ["style", "subtitleStyle", "musicMood", "scenes", "generatedVisuals"],
        additionalProperties: false,
      },
    },
    required: ["hook", "body", "callToAction", "montagePlan"],
    additionalProperties: false,
  },
} as const;

export const sourceVideoScriptJsonSchema = {
  name: "source_video_reel_script",
  strict: true,
  schema: {
    type: "object",
    properties: {
      hook: { type: "string", minLength: 1, description: "Короткий хук без приветствия" },
      body: { type: "string", minLength: 1, description: "Точный обзор содержания исходного видео" },
      callToAction: { type: "string", minLength: 0, description: "Призыв из брифа или пустая строка" },
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
  // HeyGen speaks roughly two Russian words per second. A much shorter script
  // produces a technically valid avatar video that fails the duration gate.
  const minimumWords = Math.max(12, Math.floor(durationSec * 1.45));
  const maximumWords = Math.ceil(durationSec * 2.8);
  if (words < minimumWords || words > maximumWords) {
    throw new Error(`OpenRouter script length is unsuitable: ${words} words for ${durationSec} seconds`);
  }
  return script;
}

export function createFallbackScript(brief: Brief): Script {
  const topic = brief.topic.replace(/\s+/gu, " ").trim().replace(/[.!?]+$/u, "").slice(0, 60);
  const suppliedCallToAction = brief.callToAction?.trim().split(/\s+/u).slice(0, 12).join(" ");
  const callToAction = suppliedCallToAction ?? "";
  const bodySentences = [
    "Сначала оцените внешний вид продукта и то, насколько удобно им будет пользоваться каждый день.",
    "Обратите внимание на основные функции, материалы и детали, которые важны именно для вашей задачи.",
    "Сравните ключевые характеристики с альтернативами и проверьте, какие возможности пригодятся вам чаще всего.",
    "Посмотрите на продукт с разных сторон, чтобы заранее понять его сильные стороны и ограничения.",
    "Уточните совместимость, комплектацию и условия использования перед тем, как принимать окончательное решение.",
    "Практический сценарий помогает понять, насколько продукт экономит время и упрощает привычные действия.",
    "Не ориентируйтесь только на внешний вид: проверьте реальные параметры и отзывы пользователей.",
    "Так вы сможете выбрать подходящий вариант без лишних компромиссов и неожиданных расходов.",
  ];
  const targetWords = Math.max(24, Math.round(brief.durationSec * 1.8));
  const hook = `${topic}: главное за несколько секунд.`;
  const selectedBody: string[] = [];
  let wordCount = `${hook} ${callToAction}`.trim().split(/\s+/u).length;
  for (let index = 0; wordCount < targetWords; index += 1) {
    const sentence = bodySentences[index % bodySentences.length]!;
    selectedBody.push(sentence);
    wordCount += sentence.split(/\s+/u).length;
  }
  return ScriptSchema.parse({
    hook,
    body: selectedBody.join(" "),
    callToAction,
    montagePlan: createFallbackMontagePlan(brief),
  });
}

export function normalizeMontagePlan(brief: Brief, script: Script): Script {
  const fallback = createFallbackMontagePlan(brief);
  // Source-video mode renders the supplied clip itself. It must never carry
  // legacy AI scenes or generated visuals into status, billing or rendering.
  if (brief.sourceVideoFileId) {
    const { montagePlan: _unused, ...sourceVideoScript } = script;
    return sourceVideoScript;
  }
  if (!script.montagePlan) return { ...script, montagePlan: fallback };
  const productCount = productImageIds(brief).length;
  let scenes = script.montagePlan.scenes.map((scene) => ({
    ...scene,
    productIndex: Math.min(productCount - 1, Math.max(0, scene.productIndex ?? 0)),
  }));
  if (!scenes.some((scene) => scene.kind !== "avatar")) {
    scenes = [{ ...fallback.scenes[0]!, productIndex: 0 }, ...scenes.slice(1)];
  }
  // At least one scene must show an original source asset exactly. Reference
  // generation is creative B-roll, never the only proof of the advertised object.
  if (!scenes.some((scene) => ["product_fullscreen", "avatar_product_card", "split_product"].includes(scene.kind))) {
    scenes = [{ ...fallback.scenes[0]!, productIndex: 0 }, ...scenes.slice(1)];
  }
  if (new Set(scenes.map((scene) => scene.kind)).size < 2 && scenes.length > 1) {
    scenes[1] = { ...fallback.scenes[1]!, productIndex: Math.min(productCount - 1, 1) };
  }
  if (new Set(scenes.map((scene) => scene.motion)).size < 2) {
    scenes = scenes.map((scene, index) => ({ ...scene, motion: fallback.scenes[index % fallback.scenes.length]!.motion }));
  }
  if (new Set(scenes.map((scene) => scene.transition)).size < 2) {
    scenes = scenes.map((scene, index) => ({ ...scene, transition: fallback.scenes[index % fallback.scenes.length]!.transition }));
  }
  const requestedVisuals = [...new Map(script.montagePlan.generatedVisuals.map((visual) => [visual.id, visual])).values()].slice(0, 2);
  const usedIds = new Set<"generated_1" | "generated_2">(scenes.flatMap((scene) =>
    ["product_fullscreen", "generated_scene"].includes(scene.kind) && scene.background !== "none" ? [scene.background] : [],
  ));
  const generatedVisuals = requestedVisuals
    .filter((visual) => usedIds.has(visual.id))
    .map((visual) => ({ ...visual, productIndex: Math.min(productCount - 1, Math.max(0, visual.productIndex ?? 0)) }));
  const generatedIds = new Set(generatedVisuals.map((visual) => visual.id));
  scenes = scenes.map((scene) => {
    const hasGeneratedVisual = scene.background !== "none" && generatedIds.has(scene.background);
    return {
      ...scene,
      kind: scene.kind === "generated_scene" && !hasGeneratedVisual ? "product_fullscreen" as const : scene.kind,
      background: ["product_fullscreen", "generated_scene"].includes(scene.kind) && hasGeneratedVisual
        ? scene.background
        : "none" as const,
    };
  });
  return { ...script, montagePlan: MontagePlanSchema.parse({ ...script.montagePlan, scenes, generatedVisuals }) };
}

export class OpenRouterScriptGenerator implements ScriptGenerator {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenRouterScriptOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      timeout: options.requestTimeoutMs ?? 12_000,
      maxRetries: 0,
      defaultHeaders: { "X-OpenRouter-Title": "AI Reels Telegram Bot" },
    });
  }

  async generate(brief: Brief): Promise<Script> {
    let productImages: string[] = [];
    let videoFrames: string[] = [];
    let videoTranscript: string | undefined;
    if (brief.sourceVideoFileId && this.options.videoContext) {
      try {
        videoFrames = await within(
          this.options.videoContext.analyze(brief.sourceVideoFileId, brief.sourceVideoDurationSec ?? brief.durationSec),
          55_000,
          "Video context extraction",
        ).then((analysis) => { videoTranscript = analysis.transcript; return analysis.frames; });
      } catch (error) {
        console.warn(JSON.stringify({ event: "script_video_context_unavailable", message: error instanceof Error ? error.message.slice(0, 300) : "unknown error" }));
        if (this.options.allowFallback === false) throw new Error(`Не удалось проанализировать исходное видео до создания сценария: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (videoFrames.length === 0 && this.options.allowFallback === false) throw new Error("Не удалось получить кадры исходного видео; HeyGen не запускался");
    }
    if (this.options.telegramFiles) {
      try {
        const imageLoadTimeoutMs = this.options.imageLoadTimeoutMs ?? 10_000;
        productImages = await within(
          Promise.all(productImageIds(brief).map((fileId) => this.options.telegramFiles!.dataUrl(fileId, imageLoadTimeoutMs))),
          imageLoadTimeoutMs,
          "Telegram product image loading",
        );
      } catch (error) {
        console.warn(JSON.stringify({
          event: "script_image_context_unavailable",
          message: error instanceof Error ? error.message.slice(0, 300) : "unknown error",
        }));
        if (this.options.allowFallback === false) {
          throw new Error(`Не удалось загрузить обязательное изображение продукта для анализа: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const requestedWords = Math.max(15, Math.round(brief.durationSec * 2.05));
    const maxAttempts = this.options.maxAttempts ?? 3;
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 12_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const strictStructuredOutput = attempt === 1;
        const response = await within(this.client.chat.completions.create({
          model: this.options.model,
          temperature: 0.65,
          ...(strictStructuredOutput ? {
            response_format: { type: "json_schema", json_schema: brief.sourceVideoFileId ? sourceVideoScriptJsonSchema : scriptJsonSchema },
            provider: { require_parameters: true },
          } : {}),
          messages: [
            {
              role: "system",
              content:
                `Ты сценарист коротких вертикальных видео. Верни строго JSON ${brief.sourceVideoFileId ? "только со сценарием обзора" : "со сценарием и монтажным планом"}. ` +
                "Текст должен естественно звучать вслух, начинаться без приветствия, не содержать непроверяемых обещаний, " +
                `содержать от ${Math.floor(brief.durationSec * 1.45)} до ${Math.ceil(brief.durationSec * 2.5)} слов (цель — ${requestedWords}) и быть написан на языке ${brief.language}. ` +
                (attempt > 1 ? "Предыдущий вариант не прошёл проверку; точно соблюди объём и JSON-схему. " : "") +
                (brief.sourceVideoFileId
                  ? "Визуальная основа — всё присланное пользователем видео. Сценарий должен быть комментарием/обзором именно показанного и сказанного; не выдумывай продукт, не создавай монтажный план, сцены или AI-фоны. Если в брифе есть callToAction, сохрани его смысл и поставь в конце; если его нет, верни пустую строку и закончи body естественным выводом по финалу видео. "
                  : "Создай 4–7 быстрых сцен как уникальный режиссёрский план именно для смысла сценария. Для каждой сцены заполни beat, композицию, исходник, движение, переход и длительность. generatedVisuals добавляй только при необходимости, максимум два. Для generated_scene укажи generated_N в background. Хотя бы одна сцена обязана показывать исходник без генеративного изменения. Сохраняй физический товар узнаваемым, а интерфейсы и мелкий текст не перерисовывай. ") +
                "creativeSeed используй как источник вариативности. Не добавляй Markdown и пояснения.",
            },
            {
              role: "user",
              content: productImages.length > 0 || videoFrames.length > 0
                ? [
                    { type: "text", text: brief.sourceVideoFileId
                      ? `Это ключевые кадры и расшифровка речи исходного видео. Сначала пойми, что реально показано и сказано, затем напиши точный обзор/комментарий по брифу. Не выдумывай функции, предметы или события, которых нет в кадрах или расшифровке. Тема задаёт угол обзора. Расшифровка: ${videoTranscript ?? "В исходном видео не обнаружена речь."}. Бриф: ${JSON.stringify(brief)}`
                      : `Распознай объект ролика по всем исходным изображениям и создай единый сценарий и уникальную режиссуру по брифу: ${JSON.stringify(brief)}` },
                    ...videoFrames.map((frame) => ({ type: "image_url" as const, image_url: { url: frame } })),
                    ...productImages.map((productImage) => ({ type: "image_url" as const, image_url: { url: productImage } })),
                  ]
                : JSON.stringify(brief),
            },
          ],
        } as never), requestTimeoutMs, "OpenRouter script generation");
        const text = response.choices[0]?.message.content;
        if (!text) throw new Error("OpenRouter did not return a script");
        return normalizeMontagePlan(brief, parseScriptResponse(text, brief.durationSec));
      } catch (error) {
        if (attempt === maxAttempts) {
          if (this.options.allowFallback !== false) return createFallbackScript(brief);
          throw new Error(`Не удалось создать корректный сценарий после ${maxAttempts} попыток: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
      }
    }
    return createFallbackScript(brief);
  }
}
