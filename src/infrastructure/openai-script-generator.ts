import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { ScriptGenerator } from "../application/ports.js";
import { ScriptSchema, type Brief, type Script } from "../domain/job.js";

const ScriptReviewSchema = z.object({
  draft: ScriptSchema,
  critique: z.object({
    hookScore: z.number().int().min(1).max(10),
    clarityScore: z.number().int().min(1).max(10),
    naturalSpeechScore: z.number().int().min(1).max(10),
    issues: z.array(z.string()).max(5),
  }),
  final: ScriptSchema,
});

export const SCRIPT_PROMPT_VERSION = "script-writer-critic-reviser-v1";

export interface OpenAiScriptOptions {
  apiKey: string;
  model: string;
}

export class OpenAiScriptGenerator implements ScriptGenerator {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiScriptOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  async generate(brief: Brief): Promise<Script> {
    const response = await this.client.responses.parse({
      model: this.options.model,
      input: [
        {
          role: "system",
          content:
            `Prompt version: ${SCRIPT_PROMPT_VERSION}. ` +
            "Ты редактор коротких вертикальных видео. Выполни три ограниченных шага: " +
            "Writer создаёт черновик, Critic оценивает его, Reviser исправляет замечания. " +
            "Текст должен естественно звучать вслух, начинаться без приветствия и не содержать непроверяемых обещаний. " +
            "Верни структурированный результат на языке брифа.",
        },
        {
          role: "user",
          content: JSON.stringify({
            topic: brief.topic,
            goal: brief.goal,
            audience: brief.audience,
            tone: brief.tone,
            language: brief.language,
            durationSec: brief.durationSec,
            callToAction: brief.callToAction ?? null,
          }),
        },
      ],
      text: { format: zodTextFormat(ScriptReviewSchema, "reels_script_review") },
    });

    if (!response.output_parsed) {
      throw new Error("LLM did not return a structured script");
    }
    return response.output_parsed.final;
  }
}
