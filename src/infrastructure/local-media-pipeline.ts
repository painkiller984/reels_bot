import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { MediaPipeline } from "../application/ports.js";
import type { ContentJob } from "../domain/job.js";

export interface SpeechSynthesizer {
  synthesize(text: string, outputFile: string): Promise<void>;
}

export interface AvatarGenerator {
  generate(job: ContentJob, audioFile: string, outputFile: string): Promise<void>;
}

const execFileAsync = promisify(execFile);

interface ProbeResult {
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  format?: { duration?: string };
}

export interface LocalMediaOptions {
  artifactsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  speechSynthesizer?: SpeechSynthesizer;
  avatarGenerator?: AvatarGenerator;
  downloadTelegramImage?: (fileId: string, destination: string) => Promise<string>;
  downloadBackgroundMusic?: (query: string, destination: string) => Promise<string>;
  avatarHandlesSpeech?: boolean;
}

export class LocalMediaPipeline implements MediaPipeline {
  constructor(private readonly options: LocalMediaOptions) {}

  async synthesizeSpeech(job: ContentJob): Promise<string> {
    const directory = await this.jobDirectory(job.id);
    const output = resolve(directory, this.options.speechSynthesizer ? "voice.mp3" : "voice.m4a");
    const narration = [job.script?.hook, job.script?.body, job.script?.callToAction].filter(Boolean).join(" ");
    const textFile = resolve(directory, "narration.txt");
    const waveFile = resolve(directory, "voice.wav");
    await writeFile(textFile, narration, "utf8");
    if (this.options.avatarHandlesSpeech) return `heygen://tts/${job.id}`;

    let synthesized = false;
    if (this.options.speechSynthesizer) {
      await this.options.speechSynthesizer.synthesize(narration, output);
      synthesized = true;
    }
    if (process.platform === "win32") {
      try {
        if (synthesized) return output;
        const script =
          "Add-Type -AssemblyName System.Speech; " +
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
          "$s.SetOutputToWaveFile($env:REELS_TTS_WAVE_FILE); " +
          "$s.Speak([IO.File]::ReadAllText($env:REELS_TTS_TEXT_FILE)); $s.Dispose()";
        await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, REELS_TTS_TEXT_FILE: textFile, REELS_TTS_WAVE_FILE: waveFile },
        });
        await this.ffmpeg([
          "-y", "-i", waveFile, "-af", "apad", "-t", String(job.brief.durationSec),
          "-c:a", "aac", "-b:a", "128k", output,
        ]);
        synthesized = true;
      } catch {
        synthesized = false;
      }
    }
    if (!synthesized) {
      await this.ffmpeg([
        "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", String(job.brief.durationSec), "-c:a", "aac", "-b:a", "128k", output,
      ]);
    }
    return output;
  }

  async createAvatar(job: ContentJob, audioUri: string): Promise<string> {
    const directory = await this.jobDirectory(job.id);
    const output = resolve(directory, "avatar.mp4");
    if (this.options.avatarGenerator) {
      await this.options.avatarGenerator.generate(job, audioUri, output);
      return output;
    }
    await this.ffmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=0x18202f:s=1080x1920:r=30",
      "-i", audioUri, "-t", String(job.brief.durationSec),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", output,
    ]);
    return output;
  }

  async render(job: ContentJob, avatarUri: string): Promise<string> {
    const directory = await this.jobDirectory(job.id);
    const output = resolve(directory, "final.mp4");
    const captions = resolve(directory, "captions.srt");
    await writeFile(captions, this.createSrt(job), "utf8");
    const subtitlePath = captions.replace(/\\/g, "/").replace(":", "\\:").replace(/'/g, "\\'");
    const subtitleStyle = "FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=90";
    const musicFile = resolve(directory, "music.mp3");
    const hasMusic = Boolean(this.options.downloadBackgroundMusic);
    if (this.options.downloadBackgroundMusic) {
      await this.options.downloadBackgroundMusic(job.brief.topic, musicFile);
    }
    if (job.brief.productImageFileId && this.options.downloadTelegramImage) {
      const productImage = resolve(directory, "product.jpg");
      await this.options.downloadTelegramImage(job.brief.productImageFileId, productImage);
      const musicInput = hasMusic ? ["-stream_loop", "-1", "-i", musicFile] : [];
      const musicFilter = hasMusic
        ? `;[2:a]volume=0.08,afade=t=in:st=0:d=1,atrim=duration=${job.brief.durationSec}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[outa]`
        : "";
      await this.ffmpeg([
        "-y", "-i", avatarUri, "-loop", "1", "-i", productImage, ...musicInput,
        "-filter_complex", `[1:v]scale=360:360:force_original_aspect_ratio=decrease,pad=380:380:(ow-iw)/2:(oh-ih)/2:color=white,format=rgba,fade=t=in:st=0:d=0.5:alpha=1[product];[0:v][product]overlay=W-w-40:80[withproduct];[withproduct]subtitles='${subtitlePath}':force_style='${subtitleStyle}'[outv]${musicFilter}`,
        "-map", "[outv]", "-map", hasMusic ? "[outa]" : "0:a?", "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output,
      ]);
      return output;
    }
    if (hasMusic) {
      await this.ffmpeg([
        "-y", "-i", avatarUri, "-stream_loop", "-1", "-i", musicFile,
        "-filter_complex", `[0:v]subtitles='${subtitlePath}':force_style='${subtitleStyle}'[outv];[1:a]volume=0.08,afade=t=in:st=0:d=1,atrim=duration=${job.brief.durationSec}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[outa]`,
        "-map", "[outv]", "-map", "[outa]", "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output,
      ]);
      return output;
    }
    await this.ffmpeg([
      "-y", "-i", avatarUri,
      "-vf", `subtitles='${subtitlePath}':force_style='${subtitleStyle}'`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-movflags", "+faststart", output,
    ]);
    return output;
  }

  async validate(job: ContentJob, renderUri: string): Promise<string> {
    const { stdout } = await execFileAsync(this.options.ffprobePath, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", renderUri,
    ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const probe = JSON.parse(stdout) as ProbeResult;
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(probe.format?.duration ?? 0);
    const checks = {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      verticalVideo: Boolean(video?.width && video.height && video.height > video.width && video.width >= 720),
      durationReasonable: duration >= 5 && duration <= Math.max(job.brief.durationSec * 1.5, job.brief.durationSec + 10),
    };
    const passed = Object.values(checks).every(Boolean);
    const report = { passed, checks, durationSec: duration, expectedDurationSec: job.brief.durationSec };
    const output = resolve(await this.jobDirectory(job.id), "quality.json");
    await writeFile(output, JSON.stringify(report, null, 2), "utf8");
    if (!passed) throw new Error(`Media quality gate failed: ${JSON.stringify(checks)}`);
    return output;
  }

  private async jobDirectory(jobId: string): Promise<string> {
    const directory = resolve(this.options.artifactsDir, jobId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async ffmpeg(args: string[]): Promise<void> {
    await execFileAsync(this.options.ffmpegPath, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  }

  private createSrt(job: ContentJob): string {
    const text = [job.script?.hook, job.script?.body, job.script?.callToAction].filter(Boolean).join(" ");
    const chunks = text.match(/[^.!?]+[.!?]?/g)?.map((chunk) => chunk.trim()).filter(Boolean) ?? [text];
    const totalChars = Math.max(1, chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    return chunks.map((chunk, index) => {
      const precedingChars = chunks.slice(0, index).reduce((sum, value) => sum + value.length, 0);
      const throughCurrentChars = precedingChars + chunk.length;
      const start = job.brief.durationSec * precedingChars / totalChars;
      const end = job.brief.durationSec * throughCurrentChars / totalChars;
      return `${index + 1}\n${this.srtTime(start)} --> ${this.srtTime(end)}\n${chunk}\n`;
    }).join("\n");
  }

  private srtTime(seconds: number): string {
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const secs = Math.floor(milliseconds % 60_000 / 1000);
    const millis = milliseconds % 1000;
    return [hours, minutes, secs].map((value) => String(value).padStart(2, "0")).join(":") + `,${String(millis).padStart(3, "0")}`;
  }
}
