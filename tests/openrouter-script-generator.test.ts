import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackScript, normalizeMontagePlan, OpenRouterScriptGenerator, parseScriptResponse } from "../src/infrastructure/openrouter-script-generator.js";
import { TelegramFileClient } from "../src/infrastructure/telegram-file-client.js";

afterEach(() => vi.restoreAllMocks());

describe("OpenRouter script safety", () => {
  it("sends extracted source-video frames to the model before writing a review", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        title: "Что изменилось в новом смартфоне",
        hook: "Новая модель сразу заметна в кадре.",
        body: "На видео видны корпус, экран и камера. Разберём, что изменилось и кому новая модель будет полезна каждый день.",
        callToAction: "Смотрите обзор до конца.",
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const generator = new OpenRouterScriptGenerator({
      apiKey: "test", model: "test", allowFallback: false,
      videoContext: { analyze: vi.fn().mockResolvedValue({ frames: ["data:image/jpeg;base64,Zmlyc3Q=", "data:image/jpeg;base64,c2Vjb25k", "data:image/jpeg;base64,dGhpcmQ="], chronologicalFrameCount: 2, transcript: "В кадре показан смартфон." }) },
    });
    const script = await generator.generate({
      topic: "Обзор новой модели смартфона", goal: "education", audience: "покупатели", tone: "живой", language: "ru",
      durationSec: 15, platforms: ["youtube"], sourceVideoFileId: "video", sourceVideoDurationSec: 15, avatarMode: "generated",
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const parts = request.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(3);
    expect(parts[0]?.type).toBe("text");
    expect((parts[0] as unknown as { text: string }).text).toContain("Количество последовательных кадров от начала к концу: 2");
    expect(request.response_format.json_schema.schema.properties.montagePlan).toBeUndefined();
    expect(request.response_format.json_schema.schema.required).toContain("title");
    expect(script.title).toBe("Что изменилось в новом смартфоне");
    expect(script.montagePlan).toBeUndefined();
  });

  it("removes legacy AI scenes from source-video scripts", () => {
    const script = normalizeMontagePlan({
      topic: "Обзор видео", goal: "education", audience: "зрители", tone: "живой", language: "ru",
      durationSec: 15, platforms: ["youtube"], sourceVideoFileId: "video", sourceVideoDurationSec: 15,
      avatarMode: "generated",
    }, createFallbackScript({
      topic: "Обзор видео", goal: "education", audience: "зрители", tone: "живой", language: "ru",
      durationSec: 15, platforms: ["youtube"], sourceVideoFileId: "video", sourceVideoDurationSec: 15,
      avatarMode: "generated",
    }));
    expect(script.montagePlan).toBeUndefined();
  });

  it("extracts schema JSON even when a free model adds a safety prefix", () => {
    const script = parseScriptResponse(
      'User Safety: safe\n{"hook":"Смотрите внимательно.","body":"Этот продукт помогает быстрее выполнить привычную задачу, экономит время каждый день и упрощает основные рабочие процессы.","callToAction":"Сохраните ролик и изучите детали."}',
      15,
    );
    expect(script.hook).toBe("Смотрите внимательно.");
  });

  it("keeps a generated title separate from spoken narration", () => {
    const script = parseScriptResponse(
      '{"title":"Рыбы большого океанариума","hook":"Посмотрите вокруг.","body":"В прозрачном тоннеле рядом проплывают скаты, акулы и яркие рифовые рыбы, которые хорошо видны в кадре.","callToAction":""}',
      15,
      true,
    );
    expect(script.title).toBe("Рыбы большого океанариума");
    expect([script.hook, script.body, script.callToAction].join(" ")).not.toContain(script.title!);
  });

  it("rejects a script that cannot fit the requested duration", () => {
    const body = Array.from({ length: 100 }, () => "слово").join(" ");
    expect(() => parseScriptResponse(
      JSON.stringify({ hook: "Хук", body, callToAction: "Действуйте" }),
      15,
    )).toThrow(/length is unsuitable/u);
  });

  it("rejects an underlength script that would make HeyGen end too early", () => {
    expect(() => parseScriptResponse(JSON.stringify({
      hook: "Мощный смартфон.",
      body: "Быстрый экран и хорошая камера.",
      callToAction: "Посмотрите подробнее.",
    }), 30)).toThrow(/length is unsuitable/u);
  });

  it("creates a usable deterministic fallback", () => {
    const script = createFallbackScript({
      topic: "Обзор приложения",
      goal: "reach",
      audience: "пользователи Telegram",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube"],
      productImageFileId: "image",
      avatarMode: "generated",
    });
    expect(script.hook).toContain("Обзор приложения");
    expect(script.callToAction).toBe("");
    expect(script.montagePlan?.scenes.length).toBeGreaterThanOrEqual(4);
  });

  it("scales the deterministic fallback to the selected duration", () => {
    const script = createFallbackScript({
      topic: "Обзор смартфона",
      goal: "reach",
      audience: "покупатели",
      tone: "живой",
      language: "ru",
      durationSec: 60,
      platforms: ["youtube"],
      productImageFileId: "image",
      avatarMode: "generated",
    });
    const words = [script.hook, script.body, script.callToAction].join(" ").split(/\s+/u).length;
    expect(words).toBeGreaterThanOrEqual(108);
  });

  it("sanitizes the AI montage plan and avoids paying for unused backgrounds", () => {
    const brief = {
      topic: "Обзор товара",
      goal: "sales" as const,
      audience: "покупатели",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube" as const],
      productImageFileId: "image",
      avatarMode: "generated" as const,
    };
    const script = normalizeMontagePlan(brief, {
      hook: "Хук",
      body: "Основной текст ролика.",
      callToAction: "Призыв к действию.",
      montagePlan: {
        style: "dynamic",
        subtitleStyle: "bold",
        musicMood: "modern",
        scenes: [
          { kind: "avatar", productIndex: 5, background: "generated_1", motion: "none", transition: "fade", durationWeight: 2 },
          { kind: "avatar", productIndex: 5, background: "generated_2", motion: "none", transition: "fade", durationWeight: 2 },
          { kind: "avatar", productIndex: 5, background: "none", motion: "none", transition: "fade", durationWeight: 2 },
        ],
        generatedVisuals: [
          { id: "generated_1", purpose: "background", prompt: "Неиспользуемый светлый рекламный фон" },
          { id: "generated_2", purpose: "texture", prompt: "Неиспользуемая динамичная текстура фона" },
        ],
      },
    });
    expect(script.montagePlan?.scenes.some((scene) => scene.kind !== "avatar")).toBe(true);
    expect(script.montagePlan?.generatedVisuals).toEqual([]);
    expect(script.montagePlan?.scenes.every((scene) => scene.productIndex === 0)).toBe(true);
  });

  it("does not let a stalled Telegram image block script generation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("api.telegram.org")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({
        id: "completion",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
          hook: "Учёт без лишней рутины.",
          body: "Приложение помогает собирать данные, видеть изменения и быстрее готовить понятные отчёты для ежедневной работы.",
          callToAction: "Посмотрите возможности приложения.",
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const generator = new OpenRouterScriptGenerator({
      apiKey: "test",
      model: "test",
      telegramFiles: new TelegramFileClient("test"),
      imageLoadTimeoutMs: 20,
      requestTimeoutMs: 100,
      maxAttempts: 1,
    });

    const script = await generator.generate({
      topic: "Приложение для учёта данных",
      goal: "sales",
      audience: "предприниматели",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube"],
      productImageFileId: "telegram-image",
      avatarMode: "generated",
    });

    expect(script.hook).toBe("Учёт без лишней рутины.");
  });

  it("does not create a production script without the mandatory product image", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const generator = new OpenRouterScriptGenerator({
      apiKey: "test",
      model: "test",
      telegramFiles: new TelegramFileClient("test"),
      imageLoadTimeoutMs: 20,
      requestTimeoutMs: 100,
      maxAttempts: 1,
      allowFallback: false,
    });

    await expect(generator.generate({
      topic: "Обязательный анализ товара",
      goal: "sales",
      audience: "покупатели",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube"],
      productImageFileId: "telegram-image",
      avatarMode: "generated",
    })).rejects.toThrow(/обязательное изображение продукта/u);
  });

  it("falls back quickly when the free OpenRouter route stalls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const generator = new OpenRouterScriptGenerator({
      apiKey: "test",
      model: "test",
      requestTimeoutMs: 20,
      maxAttempts: 1,
    });

    const script = await generator.generate({
      topic: "Быстрый резервный сценарий",
      goal: "reach",
      audience: "пользователи",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube"],
      productImageFileId: "image",
      avatarMode: "generated",
    });

    expect(script.hook).toContain("Быстрый резервный сценарий");
  });

  it("stops production instead of silently substituting a template in production", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const generator = new OpenRouterScriptGenerator({
      apiKey: "test",
      model: "test",
      requestTimeoutMs: 20,
      maxAttempts: 1,
      allowFallback: false,
    });

    await expect(generator.generate({
      topic: "Продакшен без шаблонной подмены",
      goal: "reach",
      audience: "пользователи",
      tone: "живой",
      language: "ru",
      durationSec: 15,
      platforms: ["youtube"],
      productImageFileId: "image",
      avatarMode: "generated",
    })).rejects.toThrow(/Не удалось создать корректный сценарий/u);
  });
});
