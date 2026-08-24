import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { TelegramFileClient } from "./telegram-file-client.js";

const execFileAsync = promisify(execFile);

/** Supplies a compact visual synopsis of a Telegram video to a multimodal LLM. */
export interface VideoContextProvider {
  frames(fileId: string, durationSec: number): Promise<string[]>;
}

export class TelegramVideoContextProvider implements VideoContextProvider {
  constructor(private readonly options: {
    telegramFiles: TelegramFileClient;
    ffmpegPath: string;
    scratchDir: string;
    frameCount?: number;
  }) {}

  async frames(fileId: string, durationSec: number): Promise<string[]> {
    const directory = resolve(this.options.scratchDir, `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const source = resolve(directory, "source.mp4");
    const frameCount = Math.max(3, Math.min(8, this.options.frameCount ?? 6));
    try {
      await mkdir(directory, { recursive: true });
      await this.options.telegramFiles.download(fileId, source);
      // fps spreads frames evenly through the clip; the small 768px JPEGs give
      // vision models enough context without turning every request into a huge upload.
      const fps = frameCount / Math.max(10, durationSec);
      await execFileAsync(this.options.ffmpegPath, [
        "-y", "-i", source, "-vf", `fps=${fps.toFixed(5)},scale=768:-2:force_original_aspect_ratio=decrease`,
        "-frames:v", String(frameCount), "-q:v", "4", resolve(directory, "frame-%02d.jpg"),
      ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 45_000 });
      const names = (await readdir(directory)).filter((name) => /^frame-\d+\.jpg$/u.test(name)).sort();
      const frames = await Promise.all(names.map(async (name) => `data:image/jpeg;base64,${(await readFile(resolve(directory, name))).toString("base64")}`));
      if (frames.length < 3) throw new Error("из видео извлечено слишком мало кадров");
      return frames;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
