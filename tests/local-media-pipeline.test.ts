import { describe, expect, it } from "vitest";
import {
  LocalMediaPipeline,
  SOURCE_VIDEO_AVATAR_SCALE,
  sourceVideoTimeline,
  trailingSilenceIsReasonable,
} from "../src/infrastructure/local-media-pipeline.js";

describe("LocalMediaPipeline subtitle normalization", () => {
  it("clamps HeyGen captions to the actual avatar video duration", () => {
    const pipeline = new LocalMediaPipeline({
      artifactsDir: ".",
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    });
    const internal = pipeline as unknown as {
      normalizeSrt(source: string, maxDuration?: number): string;
    };
    const normalized = internal.normalizeSrt([
      "1\n00:00:13,000 --> 00:00:16,200\n{\\an8}Последняя фраза обзора.",
      "2\n00:00:16,200 --> 00:00:17,000\nЛишний таймкод.",
    ].join("\n\n"), 14.54);

    expect(normalized).toContain("00:00:14,540");
    expect(normalized).toContain("{\\an5}");
    expect(normalized).toContain("Последняя фраза");
    expect(normalized).not.toContain("{\\an8}");
    expect(normalized).not.toContain("Лишний таймкод");
  });

  it("uses a 1.5x larger circular avatar coefficient", () => {
    expect(SOURCE_VIDEO_AVATAR_SCALE).toBeCloseTo(0.29 * 1.5);
  });

  it("extends the source timeline instead of cutting avatar speech", () => {
    const extended = sourceVideoTimeline(15, 16.2, 15);
    expect(extended.duration).toBeCloseTo(16.7);
    expect(extended.sourceExtension).toBeCloseTo(1.7);
    expect(sourceVideoTimeline(15, 14.2, 14.2)).toEqual({ duration: 15, sourceExtension: 0 });
    const roundedTelegramDuration = sourceVideoTimeline(14.04, 14.04, 15);
    expect(roundedTelegramDuration.duration).toBe(15);
    expect(roundedTelegramDuration.sourceExtension).toBeCloseTo(0.96);
    expect(trailingSilenceIsReasonable(true, 4.5)).toBe(true);
    expect(trailingSilenceIsReasonable(false, 4.5)).toBe(false);
  });
});
