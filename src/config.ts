import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalPostgresUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().url().startsWith("postgresql://").optional(),
);

const ConfigSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  AUTO_RECOVER_PRODUCTION: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_URL: optionalString,
  DATABASE_URL: optionalPostgresUrl,
  DATA_FILE: z.string().min(1).default(".data/jobs.json"),
  ARTIFACTS_DIR: z.string().min(1).default("artifacts"),
  OBJECT_STORAGE: z.enum(["local", "r2"]).default("local"),
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: z.string().min(3).default("reels-bot-anton-media"),
  R2_SIGNED_URL_TTL_SEC: z.coerce.number().int().min(60).max(604_800).default(3_600),
  MEDIA_MODE: z.enum(["local", "mock"]).default("local"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  SCRIPT_PROVIDER: z.enum(["auto", "openai", "openrouter", "gemini", "mock"]).default("auto"),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-terra"),
  OPENROUTER_API_KEY: optionalString,
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-3.5-flash-lite"),
  BROLL_PROVIDER: z.enum(["none", "openrouter"]).default("none"),
  OPENROUTER_IMAGE_MODEL: z.string().min(1).default("google/gemini-3.1-flash-lite-image"),
  OPENROUTER_BROLL_COUNT: z.coerce.number().int().min(1).max(3).default(2),
  OPENROUTER_IMAGE_ESTIMATED_COST_USD: z.coerce.number().positive().max(1).default(0.0336),
  OPENROUTER_BROLL_MAX_COST_USD: z.coerce.number().positive().max(5).default(0.08),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash-lite"),
  TTS_PROVIDER: z.enum(["google", "openrouter", "heygen", "local"]).default("heygen"),
  OPENROUTER_TTS_MODEL: z.string().min(1).default("openai/gpt-4o-mini-tts-2025-12-15"),
  OPENROUTER_TTS_VOICE: z.string().min(1).default("alloy"),
  GOOGLE_TTS_API_KEY: optionalString,
  GOOGLE_TTS_VOICE: z.string().min(1).default("ru-RU-Wavenet-D"),
  HEYGEN_API_KEY: optionalString,
  HEYGEN_DEFAULT_AVATAR_ID: optionalString,
  HEYGEN_DEFAULT_AVATAR_LABEL: z.string().min(2).max(80).default("Основной мужской аватар"),
  HEYGEN_VOICE_ID: optionalString,
  HEYGEN_MAX_ESTIMATED_JOB_COST_USD: z.coerce.number().positive().max(100).default(3),
  HEYGEN_RESOLUTION: z.enum(["720p", "1080p"]).default("720p"),
  MONTAGE_WIDTH: z.coerce.number().int().min(540).max(1080).default(720),
  MONTAGE_HEIGHT: z.coerce.number().int().min(960).max(1920).default(1280),
  HEYGEN_ASPECT_RATIO: z.enum(["9:16", "16:9"]).default("9:16"),
  YOUTUBE_CLIENT_ID: optionalString,
  YOUTUBE_CLIENT_SECRET: optionalString,
  YOUTUBE_OAUTH_REDIRECT_URI: z.string().url().default("http://localhost:3000/oauth/youtube/callback"),
  YOUTUBE_OAUTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  YOUTUBE_TOKEN_FILE: z.string().min(1).default(".data/youtube-tokens.json"),
  YOUTUBE_PRIVACY_STATUS: z.enum(["private", "unlisted", "public"]).default("public"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = ConfigSchema.parse(environment);
  if (config.OBJECT_STORAGE === "r2" && (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY)) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required when OBJECT_STORAGE=r2");
  }
  return config;
}
