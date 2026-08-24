import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { TelegramFileClient } from "./telegram-file-client.js";

const execFileAsync = promisify(execFile);

/** Supplies a compact visual synopsis of a Telegram video to a multimodal LLM. */
export interface VideoContextProvider {
  analyze(fileId: string, durationSec: number): Promise<VideoAnalysis>;
}

export interface VideoAnalysis { frames: string[]; chronologicalFrameCount?: number; transcript?: string; }
export interface AudioTranscriber { transcribe(audioFile: string, language: string): Promise<string>; }

export class TelegramVideoContextProvider implements VideoContextProvider {
  constructor(private readonly options: {
    telegramFiles: TelegramFileClient;
    ffmpegPath: string;
    scratchDir: string;
    frameCount?: number;
    transcriber?: AudioTranscriber;
  }) {}

  async analyze(fileId: string, durationSec: number): Promise<VideoAnalysis> {
    const directory = resolve(this.options.scratchDir, `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const source = resolve(directory, "source.mp4");
    // About one frame per 2.5 seconds for short clips, capped at 12 frames for
    // a 60-second Reel. The complete accepted video is analyzed; no tail is cut.
    const frameCount = Math.max(4, Math.min(12, this.options.frameCount ?? Math.ceil(durationSec / 2.5)));
    try {
      await mkdir(directory, { recursive: true });
      await this.options.telegramFiles.download(fileId, source);
      // Select real scene cuts first, then add evenly spaced coverage frames.
      // This avoids missing a fast screen change while still representing the end.
      const sceneCount = Math.max(1, Math.floor(frameCount / 2));
      const fps = (frameCount - sceneCount) / Math.max(10, durationSec);
      await execFileAsync(this.options.ffmpegPath, [
        "-y", "-i", source, "-vf", `fps=${fps.toFixed(5)},scale=768:-2:force_original_aspect_ratio=decrease`,
        "-t", String(durationSec), "-frames:v", String(frameCount - sceneCount), "-q:v", "4", resolve(directory, "timed-%02d.jpg"),
      ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 45_000 });
      await execFileAsync(this.options.ffmpegPath, [
        "-y", "-i", source, "-t", String(durationSec), "-vf", "select='gt(scene,0.22)',scale=768:-2:force_original_aspect_ratio=decrease",
        "-vsync", "vfr", "-frames:v", String(sceneCount), "-q:v", "4", resolve(directory, "scene-%02d.jpg"),
      ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 45_000 });
      const names = (await readdir(directory))
        .filter((name) => /^(?:timed|scene)-\d+\.jpg$/u.test(name))
        // The multimodal model receives chronological coverage first. Scene
        // cuts are supplementary detail and must not scramble the timeline.
        .sort((left, right) => {
          const leftGroup = left.startsWith("timed-") ? 0 : 1;
          const rightGroup = right.startsWith("timed-") ? 0 : 1;
          return leftGroup - rightGroup || left.localeCompare(right, "en", { numeric: true });
        });
      const frames = await Promise.all(names.map(async (name) => `data:image/jpeg;base64,${(await readFile(resolve(directory, name))).toString("base64")}`));
      const chronologicalFrameCount = names.filter((name) => name.startsWith("timed-")).length;
      if (frames.length < 3) throw new Error("из видео извлечено слишком мало кадров");
      let transcript: string | undefined;
      if (this.options.transcriber) {
        const audio = resolve(directory, "source.mp3");
        try {
          await execFileAsync(this.options.ffmpegPath, ["-y", "-i", source, "-t", String(durationSec), "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio], { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 45_000 });
          const text = await this.options.transcriber.transcribe(audio, "ru");
          if (text.trim()) transcript = text.trim().slice(0, 12_000);
        } catch (error) {
          console.warn(JSON.stringify({ event: "video_audio_transcript_unavailable", message: error instanceof Error ? error.message.slice(0, 300) : "unknown error" }));
        }
      }
      return { frames, chronologicalFrameCount, ...(transcript ? { transcript } : {}) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
