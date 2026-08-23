import { writeFile } from "node:fs/promises";
import type { SpeechSynthesizer } from "./local-media-pipeline.js";

export interface GoogleCloudTextToSpeechOptions {
  apiKey: string;
  voiceName: string;
}

/** Minimal REST client: an API key is sufficient for server-side demo use. */
export class GoogleCloudTextToSpeech implements SpeechSynthesizer {
  constructor(private readonly options: GoogleCloudTextToSpeechOptions) {}

  async synthesize(text: string, outputFile: string): Promise<void> {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.options.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: this.options.voiceName.slice(0, 5), name: this.options.voiceName },
          audioConfig: { audioEncoding: "MP3", speakingRate: 1 },
        }),
      },
    );
    if (!response.ok) throw new Error(`Google Cloud TTS: ${response.status} ${await response.text()}`);
    const payload = await response.json() as { audioContent?: string };
    if (!payload.audioContent) throw new Error("Google Cloud TTS returned no audioContent");
    await writeFile(outputFile, Buffer.from(payload.audioContent, "base64"));
  }
}
