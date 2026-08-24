import { describe, expect, it } from "vitest";
import { LocalMediaPipeline } from "../src/infrastructure/local-media-pipeline.js";

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
});
