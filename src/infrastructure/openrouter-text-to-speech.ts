import { writeFile } from "node:fs/promises";
import type { SpeechSynthesizer } from "./local-media-pipeline.js";

export interface OpenRouterTextToSpeechOptions {
  apiKey: string;
  model: string;
  voice: string;
}

export class OpenRouterTextToSpeech implements SpeechSynthesizer {
  constructor(private readonly options: OpenRouterTextToSpeechOptions) {}

  async synthesize(text: string, outputFile: string): Promise<void> {
    const response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        input: text,
        voice: this.options.voice,
        response_format: "mp3",
        speed: 1,
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter TTS: ${response.status} ${await response.text()}`);
    await writeFile(outputFile, Buffer.from(await response.arrayBuffer()));
  }
}
