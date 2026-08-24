import { afterEach, describe, expect, it, vi } from "vitest";
import { productImageIds, type Brief, type ContentJob } from "../src/domain/job.js";
import { GeminiScriptGenerator } from "../src/infrastructure/gemini-script-generator.js";
import { OpenRouterBrollBackgroundGenerator } from "../src/infrastructure/openrouter-product-image-generator.js";
import { TelegramFileClient } from "../src/infrastructure/telegram-file-client.js";

const brief: Brief = {
  topic: "Свежий огурец",
  goal: "sales",
  audience: "покупатели",
  tone: "живой",
  language: "ru",
  durationSec: 15,
  platforms: ["youtube"],
  productImageFileId: "one",
  productImageFileIds: ["one", "two", "two"],
  avatarMode: "generated",
};

afterEach(() => vi.restoreAllMocks());

describe("Gemini and generated B-roll", () => {
  it("deduplicates product images while preserving their order", () => {
    expect(productImageIds(brief)).toEqual(["one", "two"]);
  });

  it("uses Gemini structured output for a duration-safe script", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        hook: "Свежесть видно сразу.",
        body: "Хрустящий огурец подходит для салатов и лёгких домашних закусок каждый день, сохраняя свежий вкус и приятную текстуру.",
        callToAction: "Выберите свежий продукт сегодня.",
      }) }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const generator = new GeminiScriptGenerator({ apiKey: "test", model: "gemini-3.5-flash-lite" });
    const script = await generator.generate(brief);

    expect(script.hook).toBe("Свежесть видно сразу.");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("gemini-3.5-flash-lite");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.generationConfig.responseMimeType).toBe("application/json");
  });

  it("generates backgrounds without sending the real product for alteration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const generator = new OpenRouterBrollBackgroundGenerator({
      apiKey: "test",
      model: "google/gemini-3.1-flash-lite-image",
      imageCount: 2,
    });
    const now = new Date();
    const job: ContentJob = {
      id: "job",
      userId: "user",
      status: "rendering",
      brief,
      artifacts: [],
      publications: [],
      createdAt: now,
      updatedAt: now,
    };

    await generator.generate(job, [{
      id: "generated_1",
      purpose: "background",
      prompt: "Светлая современная кухня с местом для товара справа",
    }], ".");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.input_references).toBeUndefined();
    expect(request.prompt).toMatch(/do not draw, imitate or alter the product itself/iu);
    expect(request.n).toBe(1);
    expect(request.aspect_ratio).toBe("9:16");
  });

  it("never asks the paid image endpoint for more than the configured limit", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const generator = new OpenRouterBrollBackgroundGenerator({
      apiKey: "test",
      model: "google/gemini-3.1-flash-lite-image",
      imageCount: 2,
    });
    const now = new Date();
    const job: ContentJob = {
      id: "job",
      userId: "user",
      status: "rendering",
      brief,
      artifacts: [],
      publications: [],
      createdAt: now,
      updatedAt: now,
    };
    await generator.generate(job, [
      { id: "generated_1", purpose: "background", prompt: "Светлая кухня для рекламной предметной съёмки" },
      { id: "generated_2", purpose: "texture", prompt: "Динамичная зелёная текстура для рекламного фона" },
      { id: "generated_1", purpose: "lifestyle", prompt: "Современный интерьер с чистой зоной под товар" },
    ], ".");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the selected source image as a reference only when the director requests a generated scene", async () => {
    const telegramFiles = new TelegramFileClient("test");
    vi.spyOn(telegramFiles, "dataUrl")
      .mockResolvedValueOnce("data:image/jpeg;base64,b25l")
      .mockResolvedValueOnce("data:image/jpeg;base64,dHdv");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const generator = new OpenRouterBrollBackgroundGenerator({
      apiKey: "test",
      model: "google/gemini-3.1-flash-lite-image",
      imageCount: 1,
      telegramFiles,
    });
    const now = new Date();
    const job: ContentJob = {
      id: "job", userId: "user", status: "rendering", brief, artifacts: [], publications: [], createdAt: now, updatedAt: now,
    };

    await generator.generate(job, [{
      id: "generated_1",
      purpose: "reference_scene",
      productIndex: 1,
      prompt: "Необычный макрокадр объекта в движении на контрастной городской сцене",
    }], ".");

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.input_references).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,dHdv" } }]);
    expect(request.prompt).toMatch(/do not default to a person holding/iu);
  });
});
