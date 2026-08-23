import { describe, expect, it } from "vitest";
import { createFallbackScript, parseScriptResponse } from "../src/infrastructure/openrouter-script-generator.js";

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
});
