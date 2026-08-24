import { readFile } from "node:fs/promises";
import type { AudioTranscriber } from "./telegram-video-context.js";

export class OpenRouterAudioTranscriber implements AudioTranscriber {
  constructor(private readonly options: { apiKey: string; model: string }) {}
  async transcribe(audioFile: string, language: string): Promise<string> {
    const response = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(55_000),
      body: JSON.stringify({
        model: this.options.model,
        input_audio: { data: (await readFile(audioFile)).toString("base64"), format: "mp3" },
        language, temperature: 0,
      }),
    });
    const result = await response.json() as { text?: string; error?: { message?: string } };
    if (!response.ok || typeof result.text !== "string") throw new Error(`OpenRouter STT: ${result.error?.message ?? response.status}`);
    return result.text;
  }
}
