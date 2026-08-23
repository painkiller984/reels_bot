import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { MediaPipeline } from "../application/ports.js";
import { productImageIds, type ContentJob } from "../domain/job.js";
import type { BrollBackgroundGenerator } from "./openrouter-product-image-generator.js";

export interface SpeechSynthesizer {
  synthesize(text: string, outputFile: string): Promise<void>;
}

export interface AvatarGenerator {
  generate(job: ContentJob, audioFile: string, outputFile: string): Promise<void>;
}

const execFileAsync = promisify(execFile);

interface ProbeResult {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
  }>;
  format?: { duration?: string };
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface LocalMediaOptions {
  artifactsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  speechSynthesizer?: SpeechSynthesizer;
  avatarGenerator?: AvatarGenerator;
  downloadTelegramImage?: (fileId: string, destination: string) => Promise<string>;
  downloadBackgroundMusic?: (query: string, destination: string) => Promise<string>;
  brollBackgroundGenerator?: BrollBackgroundGenerator;
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
    const avatarDuration = await this.mediaDuration(avatarUri);
    const targetDuration = avatarDuration > 0 ? avatarDuration : job.brief.durationSec;
    const captions = resolve(directory, "captions.srt");
    const heygenCaptions = resolve(directory, "heygen-captions.srt");
    const captionsSource = await this.fileExists(heygenCaptions)
      ? await readFile(heygenCaptions, "utf8")
      : this.createSrt(job);
    await writeFile(captions, this.normalizeSrt(captionsSource), "utf8");
    const subtitlePath = captions.replace(/\\/g, "/").replace(":", "\\:").replace(/'/g, "\\'");
    const subtitleStyle = "FontName=Arial,FontSize=8,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.5,Shadow=1,Alignment=2,MarginL=100,MarginR=100,MarginV=50";
    const musicFile = resolve(directory, "music.mp3");
    let hasMusic = false;
    if (this.options.downloadBackgroundMusic) {
      try {
        await this.options.downloadBackgroundMusic(job.brief.topic, musicFile);
        hasMusic = true;
      } catch {
        hasMusic = false;
      }
    }
    const imageIds = productImageIds(job.brief);
    if (imageIds.length > 0 && this.options.downloadTelegramImage) {
      const suppliedProductImages = await Promise.all(imageIds.map(async (fileId, index) => {
        const destination = resolve(directory, `product-${index + 1}.jpg`);
        await this.options.downloadTelegramImage!(fileId, destination);
        return destination;
      }));
      let generatedBackgroundImages: string[] = [];
      if (suppliedProductImages.length === 1 && this.options.brollBackgroundGenerator) {
        try {
          generatedBackgroundImages = await this.options.brollBackgroundGenerator.generate(job, suppliedProductImages[0]!, directory);
        } catch {
          generatedBackgroundImages = [];
        }
      }
      const generatedBackgrounds = generatedBackgroundImages.slice(0, 3);
      const montageImages = [...suppliedProductImages, ...generatedBackgrounds];
      const imageInputs = montageImages.flatMap((productImage) => ["-loop", "1", "-framerate", "25", "-i", productImage]);
      const musicInputIndex = montageImages.length + 1;
      const musicInput = hasMusic ? ["-stream_loop", "-1", "-i", musicFile] : [];
      const musicFilter = hasMusic
        ? `;[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];[${musicInputIndex}:a]aresample=48000,volume=0.04,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(1, targetDuration - 1)}:d=1,atrim=duration=${targetDuration}[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,atrim=duration=${targetDuration},apad=whole_dur=${targetDuration}[outa]`
        : `;[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=${targetDuration}[outa]`;
      const productVideoFilter = this.productMontageFilter(suppliedProductImages.length, generatedBackgrounds.length, targetDuration);
      await this.ffmpeg([
        "-y", "-i", avatarUri, ...imageInputs, ...musicInput,
        "-filter_complex", `${productVideoFilter.filter};${productVideoFilter.output}subtitles='${subtitlePath}':force_style='${subtitleStyle}'[outv]${musicFilter}`,
        "-map", "[outv]", "-map", "[outa]", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output,
      ]);
      return output;
    }
    if (hasMusic) {
      await this.ffmpeg([
        "-y", "-i", avatarUri, "-stream_loop", "-1", "-i", musicFile,
        "-filter_complex", `[0:v]subtitles='${subtitlePath}':force_style='${subtitleStyle}'[outv];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];[1:a]aresample=48000,volume=0.04,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(1, targetDuration - 1)}:d=1,atrim=duration=${targetDuration}[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,atrim=duration=${targetDuration},apad=whole_dur=${targetDuration}[outa]`,
        "-map", "[outv]", "-map", "[outa]", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output,
      ]);
      return output;
    }
    await this.ffmpeg([
      "-y", "-i", avatarUri,
      "-vf", `subtitles='${subtitlePath}':force_style='${subtitleStyle}'`,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-t", String(targetDuration), "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-c:a", "aac", "-movflags", "+faststart", output,
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
    const captionsPath = resolve(dirname(renderUri), "captions.srt");
    const cues = this.parseSrt(await readFile(captionsPath, "utf8"));
    const subtitleLines = cues.flatMap((cue) => cue.text.split("\n"));
    const { stderr: blackDetectOutput } = await execFileAsync(this.options.ffmpegPath, [
      "-v", "info", "-i", renderUri, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-",
    ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    const blackDuration = [...blackDetectOutput.matchAll(/black_duration:([\d.]+)/gu)]
      .reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
    const { stderr: volumeOutput } = await execFileAsync(this.options.ffmpegPath, [
      "-v", "info", "-i", renderUri, "-af", "volumedetect", "-vn", "-f", "null", "-",
    ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    const meanVolume = Number(volumeOutput.match(/mean_volume:\s*(-?[\d.]+) dB/u)?.[1] ?? Number.NaN);
    const { stderr: silenceOutput } = await execFileAsync(this.options.ffmpegPath, [
      "-v", "info", "-i", renderUri, "-af", "silencedetect=noise=-35dB:d=0.8", "-vn", "-f", "null", "-",
    ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    const silenceStarts = [...silenceOutput.matchAll(/silence_start:\s*([\d.]+)/gu)].map((match) => Number(match[1]));
    const silenceEnds = [...silenceOutput.matchAll(/silence_end:\s*([\d.]+)/gu)].map((match) => Number(match[1]));
    const lastSilenceStart = silenceStarts.at(-1);
    const lastSilenceEnd = silenceEnds.at(-1);
    const trailingSilence = lastSilenceStart !== undefined
      && (lastSilenceEnd === undefined || lastSilenceEnd >= duration - 0.25)
      ? Math.max(0, (lastSilenceEnd ?? duration) - lastSilenceStart)
      : 0;
    const frameRate = this.frameRate(video?.r_frame_rate);
    const checks = {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      verticalVideo: Boolean(video?.width && video.height && video.height > video.width && video.width >= 720),
      codecsSupported: video?.codec_name === "h264" && audio?.codec_name === "aac",
      frameRateReasonable: frameRate >= 24 && frameRate <= 60,
      durationReasonable: duration >= Math.max(5, job.brief.durationSec * 0.65)
        && duration <= Math.max(job.brief.durationSec * 1.35, job.brief.durationSec + 5),
      subtitlesPresent: cues.length > 0,
      subtitlesReadable: subtitleLines.every((line) => line.length <= 24)
        && cues.every((cue) => cue.text.split("\n").length <= 2),
      subtitleTimingValid: cues.every((cue) => cue.start >= 0 && cue.end > cue.start && cue.end <= duration + 1),
      audioLevelReasonable: Number.isFinite(meanVolume) && meanVolume >= -30 && meanVolume <= -8,
      trailingSilenceReasonable: trailingSilence <= 1.2,
      blackFramesReasonable: blackDuration <= Math.max(1, duration * 0.1),
    };
    const passed = Object.values(checks).every(Boolean);
    const report = {
      passed,
      checks,
      durationSec: duration,
      expectedDurationSec: job.brief.durationSec,
      diagnostics: {
        videoCodec: video?.codec_name,
        audioCodec: audio?.codec_name,
        frameRate,
        audioSampleRate: audio?.sample_rate,
        audioChannels: audio?.channels,
        subtitleCueCount: cues.length,
        longestSubtitleLine: Math.max(0, ...subtitleLines.map((line) => line.length)),
        meanVolumeDb: meanVolume,
        trailingSilenceSec: trailingSilence,
        blackDurationSec: blackDuration,
        productImageCount: productImageIds(job.brief).length,
        montageTemplate: productImageIds(job.brief).length > 1 ? "dynamic-multi-image" : "dynamic-single-image",
      },
    };
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

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async mediaDuration(path: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(this.options.ffprobePath, [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
      ], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const duration = Number(stdout.trim());
      return Number.isFinite(duration) ? duration : 0;
    } catch {
      return 0;
    }
  }

  private productMontageFilter(productCount: number, backgroundCount: number, duration: number): { filter: string; output: string } {
    const chains: string[] = ["[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1[avatarbase]"];
    const introEnd = Math.min(2.2, Math.max(1.4, duration * 0.16));
    const outroStart = Math.max(introEnd + 1, duration - Math.min(2, duration * 0.16));
    const midStart = Math.max(introEnd + 0.8, duration * 0.48);
    const midEnd = Math.min(outroStart - 0.35, midStart + Math.min(1.8, duration * 0.13));
    const cardWindow = Math.max(0.5, outroStart - introEnd);
    const cardSlice = cardWindow / productCount;
    const cardIntervals = Array.from({ length: productCount }, (_, index) => {
      const start = introEnd + cardSlice * index;
      return { start, end: Math.min(outroStart, start + cardSlice) };
    });
    const scenes = [
      { product: 0, background: backgroundCount > 0 ? 0 : undefined, start: 0, end: introEnd },
      { product: Math.min(1, productCount - 1), background: backgroundCount > 0 ? 1 % backgroundCount : undefined, start: midStart, end: midEnd },
      { product: productCount - 1, background: backgroundCount > 0 ? 2 % backgroundCount : undefined, start: outroStart, end: duration },
    ].filter((scene) => scene.end > scene.start);

    for (let product = 0; product < productCount; product += 1) {
      const sceneIndexes = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.product === product).map(({ index }) => index);
      const labels = [`p${product}cardsrc`, ...sceneIndexes.map((scene) => `s${scene}productsrc`)];
      if (labels.length === 1) chains.push(`[${product + 1}:v]null[${labels[0]}]`);
      else chains.push(`[${product + 1}:v]split=${labels.length}${labels.map((label) => `[${label}]`).join("")}`);
      const card = cardIntervals[product]!;
      const cardFade = Math.min(0.25, Math.max(0.1, (card.end - card.start) / 4));
      chains.push(`[p${product}cardsrc]scale=200:200:force_original_aspect_ratio=decrease,pad=220:220:(ow-iw)/2:(oh-ih)/2:color=white,format=rgba,fade=t=in:st=${card.start.toFixed(3)}:d=${cardFade.toFixed(3)}:alpha=1,fade=t=out:st=${Math.max(card.start, card.end - cardFade).toFixed(3)}:d=${cardFade.toFixed(3)}:alpha=1[p${product}card]`);
    }

    for (let background = 0; background < backgroundCount; background += 1) {
      const sceneIndexes = scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.background === background).map(({ index }) => index);
      const labels = sceneIndexes.map((scene) => `s${scene}backgroundsrc`);
      const input = 1 + productCount + background;
      if (labels.length === 1) chains.push(`[${input}:v]null[${labels[0]}]`);
      else if (labels.length > 1) chains.push(`[${input}:v]split=${labels.length}${labels.map((label) => `[${label}]`).join("")}`);
    }

    scenes.forEach((scene, index) => {
      if (scene.background !== undefined) {
        chains.push(`[s${index}backgroundsrc]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,eq=brightness=-0.16[s${index}bg]`);
        chains.push(`[s${index}productsrc]scale=650:1080:force_original_aspect_ratio=decrease[s${index}fg]`);
      } else {
        chains.push(`[s${index}productsrc]split=2[s${index}bgsrc][s${index}fgsrc]`);
        chains.push(`[s${index}bgsrc]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:2,eq=brightness=-0.22[s${index}bg]`);
        chains.push(`[s${index}fgsrc]scale=650:1080:force_original_aspect_ratio=decrease[s${index}fg]`);
      }
      const sceneFade = Math.min(0.3, Math.max(0.12, (scene.end - scene.start) / 4));
      chains.push(`[s${index}bg][s${index}fg]overlay=(W-w)/2:(H-h)/2,zoompan=z='min(zoom+0.0009,1.07)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=25,format=rgba,fade=t=in:st=${scene.start.toFixed(3)}:d=${sceneFade.toFixed(3)}:alpha=1,fade=t=out:st=${Math.max(scene.start, scene.end - sceneFade).toFixed(3)}:d=${sceneFade.toFixed(3)}:alpha=1[s${index}full]`);
    });

    let current = "avatarbase";
    let stage = 0;
    for (const [index, scene] of scenes.entries()) {
      const next = `montage${stage++}`;
      chains.push(`[${current}][s${index}full]overlay=0:0:eof_action=pass:enable='between(t,${scene.start.toFixed(3)},${scene.end.toFixed(3)})'[${next}]`);
      current = next;
    }

    for (let index = 0; index < productCount; index += 1) {
      const { start, end } = cardIntervals[index]!;
      const x = index % 2 === 0 ? 24 : "W-w-24";
      const next = `montage${stage++}`;
      chains.push(`[${current}][p${index}card]overlay=${x}:60:eof_action=pass:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${next}]`);
      current = next;
    }
    return { filter: chains.join(";"), output: `[${current}]` };
  }

  private normalizeSrt(source: string): string {
    const cues = this.parseSrt(source);
    const normalized: SubtitleCue[] = [];
    for (const cue of cues) {
      const pages = this.subtitlePages(cue.text, 22, 2);
      const weights = pages.map((page) => page.replace(/\s/gu, "").length);
      const totalWeight = Math.max(1, weights.reduce((sum, value) => sum + value, 0));
      let cursor = cue.start;
      pages.forEach((page, index) => {
        const end = index === pages.length - 1
          ? cue.end
          : cursor + (cue.end - cue.start) * (weights[index] ?? 1) / totalWeight;
        normalized.push({ start: cursor, end, text: page });
        cursor = end;
      });
    }
    return normalized.map((cue, index) =>
      `${index + 1}\n${this.srtTime(cue.start)} --> ${this.srtTime(cue.end)}\n${cue.text}\n`,
    ).join("\n");
  }

  private parseSrt(source: string): SubtitleCue[] {
    return source.replace(/\r/gu, "").trim().split(/\n{2,}/u).flatMap((block) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) return [];
      const timing = lines[timingIndex]!.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/u);
      if (!timing) return [];
      const text = lines.slice(timingIndex + 1)
        .map((line) => line.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim())
        .filter(Boolean)
        .join("\n");
      if (!text) return [];
      return [{ start: this.srtSeconds(timing[1]!), end: this.srtSeconds(timing[2]!), text }];
    });
  }

  private subtitlePages(text: string, maxLineLength: number, maxLines: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/u).filter(Boolean)) {
      if (!current || `${current} ${word}`.length <= maxLineLength) current = current ? `${current} ${word}` : word;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const firstWords = lines[index]!.split(" ");
      let second = lines[index + 1]!;
      while (firstWords.length > 1 && second.length < Math.floor(maxLineLength * 0.35)) {
        const moved = firstWords.at(-1)!;
        const candidate = `${moved} ${second}`;
        if (candidate.length > maxLineLength) break;
        firstWords.pop();
        second = candidate;
      }
      lines[index] = firstWords.join(" ");
      lines[index + 1] = second;
    }
    const pages: string[] = [];
    for (let index = 0; index < lines.length; index += maxLines) pages.push(lines.slice(index, index + maxLines).join("\n"));
    return pages.length > 0 ? pages : [text.slice(0, maxLineLength)];
  }

  private srtSeconds(value: string): number {
    const [hours = "0", minutes = "0", secondsAndMillis = "0"] = value.replace(",", ".").split(":");
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(secondsAndMillis);
  }

  private frameRate(value: string | undefined): number {
    if (!value) return 0;
    const [numerator = "0", denominator = "1"] = value.split("/");
    return Number(numerator) / Math.max(1, Number(denominator));
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
