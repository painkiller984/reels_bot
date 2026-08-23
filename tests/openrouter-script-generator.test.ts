import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackScript, OpenRouterScriptGenerator, parseScriptResponse } from "../src/infrastructure/openrouter-script-generator.js";
import { TelegramFileClient } from "../src/infrastructure/telegram-file-client.js";

afterEach(() => vi.restoreAllMocks());

describe("OpenRouter script safety", () => {
  it("extracts schema JSON even when a free model adds a safety prefix", () => {
    const script = parseScriptResponse(
      'User Safety: safe\n{"hook":"Смотрите внимательно.","body":"Этот продукт помогает быстрее выполнить привычную задачу и экономит время каждый день.","callToAction":"Сохраните ролик и изучите детали."}',
      15,
    );
    expect(script.hook).toBe("Смотрите внимательно.");
  });

  it("rejects a script that cannot fit the requested duration", () => {
    const body = Array.from({ length: 100 }, () => "слово").join(" ");
    expect(() => parseScriptResponse(
      JSON.stringify({ hook: "Хук", body, callToAction: "Действуйте" }),
      15,
    )).toThrow(/length is unsuitable/u);
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
    expect(script.callToAction.length).toBeGreaterThan(10);
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
});
