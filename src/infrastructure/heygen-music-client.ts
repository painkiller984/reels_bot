import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface AudioSearchResponse {
  data?: Array<{ audio_url?: string }>;
  error?: { message?: string };
}

export class HeyGenMusicClient {
  constructor(private readonly apiKey: string) {}

  async download(query: string, destination: string): Promise<string> {
    const params = new URLSearchParams({
      query: `${query}. Upbeat modern social media background music, instrumental, no vocals`,
      type: "music",
      limit: "1",
      min_score: "0.5",
    });
    const response = await fetch(`https://api.heygen.com/v3/audio/sounds?${params}`, {
      headers: { "x-api-key": this.apiKey },
    });
    const payload = await response.json() as AudioSearchResponse;
    const audioUrl = payload.data?.[0]?.audio_url;
    if (!response.ok || !audioUrl) {
      throw new Error(`HeyGen music search failed: ${response.status} ${payload.error?.message ?? "no matching track"}`);
    }
    const audio = await fetch(audioUrl);
    if (!audio.ok) throw new Error(`HeyGen music download failed: ${audio.status}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await audio.arrayBuffer()));
    return destination;
  }
}
