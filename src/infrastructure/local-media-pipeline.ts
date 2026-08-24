import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { MediaPipeline } from "../application/ports.js";
import { createFallbackMontagePlan, productImageIds, type ContentJob, type MontagePlan, type MontageScene } from "../domain/job.js";
import type { BrollBackgroundGenerator, GeneratedBackground } from "./openrouter-product-image-generator.js";

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
  downloadTelegramVideo?: (fileId: string, destination: string) => Promise<string>;
  downloadBackgroundMusic?: (query: string, destination: string) => Promise<string>;
  brollBackgroundGenerator?: BrollBackgroundGenerator;
  avatarHandlesSpeech?: boolean;
  outputWidth?: number;
  outputHeight?: number;
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
    if (job.brief.sourceVideoFileId && this.options.downloadTelegramVideo) {
      const source = resolve(directory, "source.mp4");
      await this.options.downloadTelegramVideo(job.brief.sourceVideoFileId, source);
      await this.renderSourceVideoWithAvatar({ source, avatarUri, output, captions: subtitlePath, targetDuration, job });
      return output;
    }
    const montagePlan = job.script?.montagePlan ?? createFallbackMontagePlan(job.brief);
    const subtitleStyle = this.subtitleStyle(montagePlan);
    const musicFile = resolve(directory, "music.mp3");
    let hasMusic = false;
    if (this.options.downloadBackgroundMusic) {
      try {
        await this.options.downloadBackgroundMusic(`${job.brief.topic} ${montagePlan.musicMood}`, musicFile);
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
      let generatedBackgrounds: GeneratedBackground[] = [];
      if (this.options.brollBackgroundGenerator && montagePlan.generatedVisuals.length > 0) {
        try {
          generatedBackgrounds = await this.options.brollBackgroundGenerator.generate(job, montagePlan.generatedVisuals, directory);
        } catch {
          generatedBackgrounds = [];
        }
      }
      const requiredGeneratedScenes = new Set<"generated_1" | "generated_2">(montagePlan.scenes.flatMap((scene) =>
        scene.kind === "generated_scene" && scene.background !== "none" ? [scene.background] : [],
      ));
      const generatedIds = new Set(generatedBackgrounds.map((item) => item.id));
      const missingGeneratedScenes = [...requiredGeneratedScenes].filter((id) => !generatedIds.has(id));
      if (missingGeneratedScenes.length > 0) {
        throw new Error(`Не удалось создать обязательные AI-кадры режиссёрского плана: ${missingGeneratedScenes.join(", ")}. Повторите задачу через /retry`);
      }
      // Render every production resolution scene-by-scene. This makes the LLM
      // plan authoritative and enables real transitions instead of one static
      // overlay graph whose outputs looked identical between briefs.
      await this.renderStagedMontage({
        avatarUri,
        captions: subtitlePath,
        subtitleStyle,
        suppliedProductImages,
        generatedBackgrounds,
        montagePlan,
        targetDuration,
        ...(hasMusic ? { musicFile } : {}),
        directory,
        output,
      });
      return output;
    }
    if (hasMusic) {
      await this.ffmpeg([
        "-y", "-filter_complex_threads", "1", "-i", avatarUri, "-stream_loop", "-1", "-i", musicFile,
        "-filter_complex", `[0:v]subtitles='${subtitlePath}':force_style='${subtitleStyle}'[outv];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];[1:a]aresample=48000,volume=0.04,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(1, targetDuration - 1)}:d=1,atrim=duration=${targetDuration}[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,atrim=duration=${targetDuration},apad=whole_dur=${targetDuration}[outa]`,
        "-map", "[outv]", "-map", "[outa]", "-t", String(targetDuration), "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads", "1", "-crf", "22", "-c:a", "aac", "-shortest", "-movflags", "+faststart", output,
      ]);
      return output;
    }
    await this.ffmpeg([
      "-y", "-i", avatarUri,
      "-vf", `subtitles='${subtitlePath}':force_style='${subtitleStyle}'`,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-t", String(targetDuration), "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads", "1", "-crf", "22", "-c:a", "aac", "-movflags", "+faststart", output,
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
    const montagePlan = job.script?.montagePlan ?? createFallbackMontagePlan(job.brief);
    const checks = {
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      verticalVideo: Boolean(video?.width && video.height && video.height > video.width && video.width >= (this.options.outputWidth ?? 720)),
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
      montageLayoutsVaried: job.brief.sourceVideoFileId ? true : new Set(montagePlan.scenes.map((scene) => scene.kind)).size >= 2,
      montageMotionsVaried: job.brief.sourceVideoFileId ? true : new Set(montagePlan.scenes.map((scene) => scene.motion)).size >= 2,
      montageTransitionsVaried: job.brief.sourceVideoFileId ? true : new Set(montagePlan.scenes.map((scene) => scene.transition)).size >= 2,
    };
    const passed = Object.values(checks).every(Boolean);
    const generatedVisualCount = (await readdir(dirname(renderUri)))
      .filter((name) => /^generated_[12]\.(?:png|jpe?g|webp)$/iu.test(name)).length;
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
        montageTemplate: job.brief.sourceVideoFileId ? "source-video-avatar-overlay" : job.script?.montagePlan ? `ai-director-${job.script.montagePlan.style}` : "dynamic-fallback",
        montageSceneCount: job.script?.montagePlan?.scenes.length ?? createFallbackMontagePlan(job.brief).scenes.length,
        aiGeneratedVisualCount: generatedVisualCount,
        imageGenerationModel: this.options.brollBackgroundGenerator?.model,
        estimatedGeneratedVisualCostUsd: Number((generatedVisualCount
          * (this.options.brollBackgroundGenerator?.estimatedCostPerImageUsd ?? 0)).toFixed(4)),
      },
    };
    const output = resolve(await this.jobDirectory(job.id), "quality.json");
    await writeFile(output, JSON.stringify(report, null, 2), "utf8");
    if (!passed) throw new Error(`Media quality gate failed: duration=${duration.toFixed(2)}s expected=${job.brief.durationSec}s checks=${JSON.stringify(checks)}`);
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

  private async renderSourceVideoWithAvatar(input: {
    source: string;
    avatarUri: string;
    output: string;
    captions: string;
    targetDuration: number;
    job: ContentJob;
  }): Promise<void> {
    const width = this.options.outputWidth ?? 720;
    const height = this.options.outputHeight ?? 1280;
    const sourceDuration = await this.mediaDuration(input.source);
    const avatarDuration = await this.mediaDuration(input.avatarUri);
    const duration = Math.max(10, Math.min(input.targetDuration, sourceDuration || input.targetDuration, avatarDuration || input.targetDuration));
    const avatarSize = Math.round(Math.min(width, height) * 0.29);
    const position = this.avatarOverlayPosition(input.job, width, height, avatarSize);
    const subtitleStyle = `FontName=Arial,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Bold=1,Alignment=${position.top ? 2 : 8},MarginL=76,MarginR=76,MarginV=62`;
    const graph = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=18:4,eq=brightness=-0.18[bg]`,
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[main]`,
      `[bg][main]overlay=(W-w)/2:(H-h)/2[base]`,
      `[1:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',scale=${avatarSize}:${avatarSize},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte((X-W/2)^2+(Y-H/2)^2,(W/2-5)^2),255,0)'[avatar]`,
      `[base][avatar]overlay=${position.x}:${position.y},subtitles='${input.captions}':force_style='${subtitleStyle}'[outv]`,
      `[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,atrim=duration=${duration},apad=whole_dur=${duration}[outa]`,
    ].join(";");
    await this.ffmpeg([
      "-y", "-filter_complex_threads", "1", "-i", input.source, "-i", input.avatarUri,
      "-filter_complex", graph, "-map", "[outv]", "-map", "[outa]", "-t", String(duration),
      "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", input.output,
    ]);
  }

  private avatarOverlayPosition(job: ContentJob, width: number, height: number, size: number): { x: number; y: number; top: boolean } {
    const seed = job.brief.creativeSeed ?? [...job.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const margin = 34;
    const choices = [
      { x: margin, y: height - size - 190, top: false },
      { x: width - size - margin, y: height - size - 190, top: false },
      { x: margin, y: 105, top: true },
      { x: width - size - margin, y: 105, top: true },
    ];
    return choices[seed % choices.length]!;
  }

  private async renderStagedMontage(input: {
    avatarUri: string;
    captions: string;
    subtitleStyle: string;
    suppliedProductImages: string[];
    generatedBackgrounds: GeneratedBackground[];
    montagePlan: MontagePlan;
    targetDuration: number;
    musicFile?: string;
    directory: string;
    output: string;
  }): Promise<void> {
    const width = this.options.outputWidth ?? 540;
    const height = this.options.outputHeight ?? 960;
    const foregroundWidth = Math.round(width * 650 / 720);
    const foregroundHeight = Math.round(height * 1080 / 1280);
    const totalWeight = Math.max(1, input.montagePlan.scenes.reduce((sum, scene) => sum + scene.durationWeight, 0));
    let cursor = 0;
    const segmentFiles: string[] = [];
    const segmentLengths: number[] = [];

    for (const [index, scene] of input.montagePlan.scenes.entries()) {
      const end = index === input.montagePlan.scenes.length - 1
        ? input.targetDuration
        : cursor + input.targetDuration * scene.durationWeight / totalWeight;
      const sceneLength = Math.max(0.1, end - cursor);
      const segment = resolve(input.directory, `montage-segment-${index}.mp4`);
      console.info(JSON.stringify({ event: "montage_scene_started", scene: index + 1, total: input.montagePlan.scenes.length, kind: scene.kind }));
      const base = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=25`;
      const commonOutput = [
        "-map", "[outv]", "-an", "-t", sceneLength.toFixed(3),
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
        "-threads", "1", "-crf", "24", "-pix_fmt", "yuv420p", "-r", "25",
        "-video_track_timescale", "90000", segment,
      ];

      if (scene.kind === "avatar") {
        await this.ffmpeg([
          "-y", "-ss", cursor.toFixed(3), "-t", sceneLength.toFixed(3), "-i", input.avatarUri,
          "-filter_threads", "1", "-filter_complex", `${base}[outv]`, ...commonOutput,
        ]);
      } else {
        const productIndex = Math.min(input.suppliedProductImages.length - 1, Math.max(0, scene.productIndex ?? 0));
        const productImage = input.suppliedProductImages[productIndex]!;
        const background = scene.background
          ? input.generatedBackgrounds.find((item) => item.id === scene.background)?.path
          : undefined;
        const generatedScene = scene.kind === "generated_scene" ? background : undefined;
        const primaryImage = generatedScene ?? productImage;
        const imageInputs = ["-loop", "1", "-framerate", "25", "-i", primaryImage];
        if (background && !generatedScene) imageInputs.push("-loop", "1", "-framerate", "25", "-i", background);
        const fade = scene.transition === "cut" ? 0.02 : Math.min(0.28, Math.max(0.12, sceneLength / 5));
        const fadeOut = Math.max(0, sceneLength - fade).toFixed(3);
        let filter: string;

        if (scene.kind === "generated_scene") {
          filter = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${this.fullscreenMotion(scene, sceneLength, width, height)},format=yuv420p,fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${fadeOut}:d=${fade.toFixed(3)}[outv]`;
        } else if (scene.kind === "product_fullscreen") {
          const backgroundFilter = background
            ? `[2:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},eq=brightness=-0.14[bg]`
            : `[1:v]split=2[bgsrc][fgsrc];[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=16:1,eq=brightness=-0.24:saturation=1.15[bg]`;
          const foregroundInput = background ? "[1:v]" : "[fgsrc]";
          filter = `${backgroundFilter};${foregroundInput}scale=${foregroundWidth}:${foregroundHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${this.fullscreenMotion(scene, sceneLength, width, height)},format=yuv420p,fade=t=in:st=0:d=${fade.toFixed(3)},fade=t=out:st=${fadeOut}:d=${fade.toFixed(3)}[outv]`;
        } else {
          const split = scene.kind === "split_product";
          const size = Math.round((split ? 430 : 250) * width / 720);
          const content = Math.round((split ? 400 : 220) * width / 720);
          const pop = scene.motion === "pop"
            ? `,zoompan=z='min(zoom+0.006,1.13)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size}x${size}:fps=25`
            : "";
          const position = this.scenePosition(scene, 0, split, index);
          filter = `${base}[avatar];[1:v]scale=${content}:${content}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white${pop},format=rgba,fade=t=in:st=0:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${fadeOut}:d=${fade.toFixed(3)}:alpha=1[product];[avatar][product]overlay=x='${position.x}':y='${position.y}':eof_action=pass[outv]`;
        }
        await this.ffmpeg([
          "-y", "-ss", cursor.toFixed(3), "-t", sceneLength.toFixed(3), "-i", input.avatarUri,
          ...imageInputs, "-filter_complex_threads", "1", "-filter_complex", filter, ...commonOutput,
        ]);
      }
      segmentFiles.push(segment);
      segmentLengths.push(sceneLength);
      console.info(JSON.stringify({ event: "montage_scene_completed", scene: index + 1, total: input.montagePlan.scenes.length }));
      cursor = end;
    }

    const montageBase = resolve(input.directory, "montage-base.mp4");
    if (segmentFiles.length === 1) {
      await this.ffmpeg(["-y", "-i", segmentFiles[0]!, "-c", "copy", montageBase]);
    } else {
      const transitionInputs = segmentFiles.flatMap((file) => ["-i", file]);
      const chains = segmentFiles.map((_file, index) => `[${index}:v]fps=25,settb=AVTB,setpts=PTS-STARTPTS[v${index}]`);
      let current = "v0";
      let currentDuration = segmentLengths[0]!;
      for (let index = 1; index < segmentFiles.length; index += 1) {
        const scene = input.montagePlan.scenes[index]!;
        const transitionDuration = scene.transition === "cut"
          ? 0.02
          : Math.min(0.38, segmentLengths[index - 1]! / 4, segmentLengths[index]! / 4);
        const offset = Math.max(0.01, currentDuration - transitionDuration);
        const next = `x${index}`;
        chains.push(`[${current}][v${index}]xfade=transition=${this.xfadeTransition(scene.transition)}:duration=${transitionDuration.toFixed(3)}:offset=${offset.toFixed(3)}[${next}]`);
        current = next;
        currentDuration += segmentLengths[index]! - transitionDuration;
      }
      const speedFactor = input.targetDuration / Math.max(0.1, currentDuration);
      chains.push(`[${current}]setpts=${speedFactor.toFixed(8)}*PTS,fps=25,format=yuv420p[outv]`);
      await this.ffmpeg([
        "-y", ...transitionInputs, "-filter_complex_threads", "1", "-filter_complex", chains.join(";"),
        "-map", "[outv]", "-an", "-t", String(input.targetDuration), "-c:v", "libx264", "-preset", "veryfast",
        "-threads", "1", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", montageBase,
      ]);
    }

    const musicInput = input.musicFile ? ["-stream_loop", "-1", "-i", input.musicFile] : [];
    const musicFilter = input.musicFile
      ? `;[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[voice];[2:a]aresample=48000,volume=0.04,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(1, input.targetDuration - 1)}:d=1,atrim=duration=${input.targetDuration}[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,atrim=duration=${input.targetDuration},apad=whole_dur=${input.targetDuration}[outa]`
      : `;[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=${input.targetDuration}[outa]`;
    await this.ffmpeg([
      "-y", "-filter_complex_threads", "1", "-i", montageBase, "-i", input.avatarUri, ...musicInput,
      "-filter_complex", `[0:v]subtitles='${input.captions}':force_style='${input.subtitleStyle}'[outv]${musicFilter}`,
      "-map", "[outv]", "-map", "[outa]", "-t", String(input.targetDuration),
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-threads", "1", "-crf", "22",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart", input.output,
    ]);
    console.info(JSON.stringify({ event: "montage_completed", scenes: segmentFiles.length }));
  }

  private productMontageFilter(productCount: number, backgrounds: GeneratedBackground[], duration: number, plan: MontagePlan): { filter: string; output: string } {
    const width = this.options.outputWidth ?? 720;
    const height = this.options.outputHeight ?? 1280;
    const foregroundWidth = Math.round(width * 650 / 720);
    const foregroundHeight = Math.round(height * 1080 / 1280);
    const chains: string[] = [`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[avatarbase]`];
    const totalWeight = plan.scenes.reduce((sum, scene) => sum + scene.durationWeight, 0);
    let cursor = 0;
    const scenes = plan.scenes.map((scene, index) => {
      const end = index === plan.scenes.length - 1 ? duration : cursor + duration * scene.durationWeight / totalWeight;
      const timed = {
        scene,
        start: cursor,
        end,
        product: Math.min(productCount - 1, Math.max(0, scene.productIndex ?? 0)),
        background: backgrounds.findIndex((background) => background.id === scene.background),
      };
      cursor = end;
      return timed;
    });

    for (let product = 0; product < productCount; product += 1) {
      const labels = scenes
        .map((timed, index) => ({ timed, index }))
        .filter(({ timed }) => timed.scene.kind !== "avatar" && timed.product === product)
        .map(({ index }) => `s${index}productsrc`);
      if (labels.length === 0) continue;
      if (labels.length === 1) chains.push(`[${product + 1}:v]null[${labels[0]}]`);
      else chains.push(`[${product + 1}:v]split=${labels.length}${labels.map((label) => `[${label}]`).join("")}`);
    }

    for (let background = 0; background < backgrounds.length; background += 1) {
      const labels = scenes
        .map((timed, index) => ({ timed, index }))
        .filter(({ timed }) => timed.scene.kind === "product_fullscreen" && timed.background === background)
        .map(({ index }) => `s${index}backgroundsrc`);
      const input = 1 + productCount + background;
      if (labels.length === 1) chains.push(`[${input}:v]null[${labels[0]}]`);
      else if (labels.length > 1) chains.push(`[${input}:v]split=${labels.length}${labels.map((label) => `[${label}]`).join("")}`);
    }

    let current = "avatarbase";
    let stage = 0;
    for (const [index, timed] of scenes.entries()) {
      if (timed.scene.kind === "avatar") continue;
      const sceneLength = timed.end - timed.start;
      const fade = timed.scene.transition === "cut" ? 0.02 : Math.min(0.28, Math.max(0.12, sceneLength / 5));
      const start = timed.start.toFixed(3);
      const end = timed.end.toFixed(3);
      const fadeOut = Math.max(timed.start, timed.end - fade).toFixed(3);
      let overlayLabel: string;

      if (timed.scene.kind === "product_fullscreen") {
        if (timed.background >= 0) {
          chains.push(`[s${index}backgroundsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},eq=brightness=-0.14[s${index}bg]`);
          chains.push(`[s${index}productsrc]scale=${foregroundWidth}:${foregroundHeight}:force_original_aspect_ratio=decrease[s${index}fg]`);
        } else {
          chains.push(`[s${index}productsrc]split=2[s${index}bgsrc][s${index}fgsrc]`);
          chains.push(`[s${index}bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=16:1,eq=brightness=-0.24:saturation=1.15[s${index}bg]`);
          chains.push(`[s${index}fgsrc]scale=${foregroundWidth}:${foregroundHeight}:force_original_aspect_ratio=decrease[s${index}fg]`);
        }
        const motion = this.fullscreenMotion(timed.scene, sceneLength, width, height);
        chains.push(`[s${index}bg][s${index}fg]overlay=(W-w)/2:(H-h)/2,${motion},format=rgba,fade=t=in:st=${start}:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${fadeOut}:d=${fade.toFixed(3)}:alpha=1[s${index}visual]`);
        overlayLabel = `s${index}visual`;
      } else {
        const split = timed.scene.kind === "split_product";
        const size = split ? 430 : 250;
        const content = split ? 400 : 220;
        const pop = timed.scene.motion === "pop"
          ? `,zoompan=z='min(zoom+0.006,1.13)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${size}x${size}:fps=25`
          : "";
        chains.push(`[s${index}productsrc]scale=${content}:${content}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=white${pop},format=rgba,fade=t=in:st=${start}:d=${fade.toFixed(3)}:alpha=1,fade=t=out:st=${fadeOut}:d=${fade.toFixed(3)}:alpha=1[s${index}visual]`);
        overlayLabel = `s${index}visual`;
      }

      const next = `montage${stage++}`;
      const position = this.scenePosition(timed.scene, timed.start, timed.scene.kind === "split_product", index);
      chains.push(`[${current}][${overlayLabel}]overlay=x='${position.x}':y='${position.y}':eof_action=pass:enable='between(t,${start},${end})'[${next}]`);
      current = next;
    }
    return { filter: chains.join(";"), output: `[${current}]` };
  }

  private fullscreenMotion(scene: MontageScene, sceneLength: number, width: number, height: number): string {
    const frames = Math.max(1, Math.round(sceneLength * 25));
    if (scene.motion === "zoom_out") {
      return `zoompan=z='if(eq(on,0),1.10,max(zoom-0.0012,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "pan_left") {
      return `zoompan=z=1.08:x='(iw-iw/zoom)*min(on/${frames},1)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "pan_right") {
      return `zoompan=z=1.08:x='(iw-iw/zoom)*(1-min(on/${frames},1))':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "pan_up") {
      return `zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*min(on/${frames},1)':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "pan_down") {
      return `zoompan=z=1.08:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-min(on/${frames},1))':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "drift") {
      return `zoompan=z=1.06:x='(iw-iw/zoom)*(0.5+0.35*sin(on/18))':y='(ih-ih/zoom)*(0.5+0.25*cos(on/22))':d=1:s=${width}x${height}:fps=25`;
    }
    if (scene.motion === "pulse") {
      return `zoompan=z='1.04+0.025*sin(on/7)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=25`;
    }
    return `zoompan=z='min(zoom+0.0012,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=25`;
  }

  private xfadeTransition(transition: MontageScene["transition"]): string {
    const mapping: Record<MontageScene["transition"], string> = {
      cut: "fadefast",
      fade: "fade",
      whip_left: "wipeleft",
      whip_right: "wiperight",
      push_up: "slideup",
      push_down: "slidedown",
      zoom: "zoomin",
      circle: "circleopen",
      reveal: "smoothup",
      pixelize: "pixelize",
    };
    return mapping[transition];
  }

  private scenePosition(scene: MontageScene, startTime: number, split: boolean, index: number): { x: string; y: string } {
    const duration = 0.28;
    const start = startTime.toFixed(3);
    const progress = `(t-${start})/${duration}`;
    const fullscreen = scene.kind === "product_fullscreen";
    const targetX = fullscreen ? "0" : split ? "(W-w)/2" : index % 2 === 0 ? "28" : "W-w-28";
    const targetY = fullscreen ? "0" : split ? "H-h-170" : "80";
    const incoming = fullscreen ? scene.transition : scene.motion === "none" ? scene.transition : scene.motion;
    if (incoming === "fly_from_bottom" || incoming === "push_up") {
      return { x: targetX, y: `if(lt(t,${start}+${duration}),H+((${targetY})-H)*(${progress}),${targetY})` };
    }
    if (incoming === "fly_from_top" || incoming === "push_down") {
      return { x: targetX, y: `if(lt(t,${start}+${duration}),-h+((${targetY})+h)*(${progress}),${targetY})` };
    }
    if (incoming === "slide_left" || incoming === "whip_right") {
      return { x: `if(lt(t,${start}+${duration}),-w+((${targetX})+w)*(${progress}),${targetX})`, y: targetY };
    }
    if (incoming === "slide_right" || incoming === "whip_left") {
      return { x: `if(lt(t,${start}+${duration}),W+((${targetX})-W)*(${progress}),${targetX})`, y: targetY };
    }
    return { x: targetX, y: targetY };
  }

  private subtitleStyle(plan: MontagePlan): string {
    const common = "FontName=Arial,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Alignment=2,MarginL=85,MarginR=85,MarginV=55";
    if (plan.subtitleStyle === "minimal") return `${common},FontSize=9,Outline=1,Shadow=0`;
    if (plan.subtitleStyle === "highlight") return `${common},FontSize=11,SecondaryColour=&H0000D7FF,Outline=2,Shadow=1,Bold=1`;
    return `${common},FontSize=11,Outline=2,Shadow=1,Bold=1`;
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
