import pino from "pino";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { webhookCallback } from "grammy";
import { readConfig } from "./config.js";
import { createContainer } from "./container.js";
import { createBot } from "./presentation/bot.js";
import { DraftStore } from "./presentation/draft-store.js";
import { createPrismaClient } from "./infrastructure/database.js";
import { PrismaJobRepository } from "./infrastructure/prisma-job-repository.js";
import { FileJobRepository } from "./infrastructure/file-job-repository.js";
import { LocalMediaPipeline } from "./infrastructure/local-media-pipeline.js";
import { MockMediaPipeline } from "./infrastructure/mock-providers.js";
import { MockScriptGenerator } from "./infrastructure/mock-providers.js";
import { OpenAiScriptGenerator } from "./infrastructure/openai-script-generator.js";
import { resolveExecutable } from "./infrastructure/executable-resolver.js";
import { GoogleCloudTextToSpeech } from "./infrastructure/google-cloud-text-to-speech.js";
import { GeminiScriptGenerator } from "./infrastructure/gemini-script-generator.js";
import { YoutubeAuthService } from "./infrastructure/youtube-auth.js";
import { YoutubePublisher } from "./infrastructure/youtube-publisher.js";
import { MockSocialPublisher } from "./infrastructure/mock-providers.js";
import { OpenRouterScriptGenerator } from "./infrastructure/openrouter-script-generator.js";
import { OpenRouterBrollBackgroundGenerator } from "./infrastructure/openrouter-product-image-generator.js";
import { OpenRouterTextToSpeech } from "./infrastructure/openrouter-text-to-speech.js";
import { HeyGenAvatarGenerator } from "./infrastructure/heygen-avatar-generator.js";
import { TelegramFileClient } from "./infrastructure/telegram-file-client.js";
import { HealthServer } from "./infrastructure/health-server.js";
import { HeyGenMusicClient } from "./infrastructure/heygen-music-client.js";
import { FileYoutubeTokenStore, PrismaYoutubeTokenStore } from "./infrastructure/youtube-token-store.js";
import { deployPrismaMigrations } from "./infrastructure/prisma-migrator.js";
import { LocalArtifactStore, R2ArtifactStore } from "./infrastructure/artifact-store.js";

const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
await deployPrismaMigrations(config.DATABASE_URL);
if (config.DATABASE_URL) {
  logger.info("PostgreSQL migrations applied");
}
const require = createRequire(import.meta.url);
const bundledFfmpeg = require("ffmpeg-static") as string | null;
const bundledFfprobe = (require("ffprobe-static") as { path?: string }).path;
const ffmpegPath = config.FFMPEG_PATH === "ffmpeg" && bundledFfmpeg
  ? bundledFfmpeg
  : resolveExecutable(config.FFMPEG_PATH, "ffmpeg");
const ffprobePath = config.FFPROBE_PATH === "ffprobe" && bundledFfprobe
  ? bundledFfprobe
  : resolveExecutable(config.FFPROBE_PATH, "ffprobe");

if (!config.TELEGRAM_BOT_TOKEN) {
  logger.error("TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and add the token.");
  process.exitCode = 1;
} else {
  if (config.TTS_PROVIDER === "google" && !config.GOOGLE_TTS_API_KEY) {
    throw new Error("GOOGLE_TTS_API_KEY is required when TTS_PROVIDER=google");
  }
  if ((config.SCRIPT_PROVIDER === "openrouter" || config.TTS_PROVIDER === "openrouter") && !config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter script/TTS providers");
  }
  if (config.TTS_PROVIDER === "heygen" && !config.HEYGEN_API_KEY) {
    throw new Error("HEYGEN_API_KEY is required when TTS_PROVIDER=heygen");
  }
  const telegramFiles = new TelegramFileClient(config.TELEGRAM_BOT_TOKEN);
  const musicClient = config.HEYGEN_API_KEY ? new HeyGenMusicClient(config.HEYGEN_API_KEY) : undefined;
  const speechSynthesizer = config.TTS_PROVIDER === "google"
    ? new GoogleCloudTextToSpeech({ apiKey: config.GOOGLE_TTS_API_KEY!, voiceName: config.GOOGLE_TTS_VOICE })
    : config.TTS_PROVIDER === "openrouter"
      ? new OpenRouterTextToSpeech({ apiKey: config.OPENROUTER_API_KEY!, model: config.OPENROUTER_TTS_MODEL, voice: config.OPENROUTER_TTS_VOICE })
      : undefined;
  const avatarGenerator = config.HEYGEN_API_KEY
    ? new HeyGenAvatarGenerator({
        apiKey: config.HEYGEN_API_KEY,
        resolution: config.HEYGEN_RESOLUTION,
        aspectRatio: config.HEYGEN_ASPECT_RATIO,
        telegramFiles,
        ...(config.HEYGEN_VOICE_ID ? { voiceId: config.HEYGEN_VOICE_ID } : {}),
        ...(config.HEYGEN_DEFAULT_AVATAR_ID ? { defaultAvatarId: config.HEYGEN_DEFAULT_AVATAR_ID } : {}),
        maxEstimatedJobCostUsd: config.HEYGEN_MAX_ESTIMATED_JOB_COST_USD,
      })
    : undefined;
  const prisma = config.DATABASE_URL ? createPrismaClient(config.DATABASE_URL) : undefined;
  const repository = prisma ? new PrismaJobRepository(prisma) : new FileJobRepository(config.DATA_FILE);
  if (config.BROLL_PROVIDER === "openrouter" && !config.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required when BROLL_PROVIDER=openrouter");
  }
  const brollBackgroundGenerator = config.BROLL_PROVIDER === "openrouter"
    ? new OpenRouterBrollBackgroundGenerator({
        apiKey: config.OPENROUTER_API_KEY!,
        model: config.OPENROUTER_IMAGE_MODEL,
        imageCount: Math.max(1, Math.min(
          config.OPENROUTER_BROLL_COUNT,
          Math.floor(config.OPENROUTER_BROLL_MAX_COST_USD / config.OPENROUTER_IMAGE_ESTIMATED_COST_USD),
        )),
        estimatedCostPerImageUsd: config.OPENROUTER_IMAGE_ESTIMATED_COST_USD,
      })
    : undefined;
  const artifactStore = config.OBJECT_STORAGE === "r2"
    ? new R2ArtifactStore({
        accountId: config.R2_ACCOUNT_ID!,
        accessKeyId: config.R2_ACCESS_KEY_ID!,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
        bucket: config.R2_BUCKET,
        cacheDir: `${config.ARTIFACTS_DIR}/.r2-cache`,
        signedUrlTtlSec: config.R2_SIGNED_URL_TTL_SEC,
      })
    : new LocalArtifactStore();
  const media = config.MEDIA_MODE === "local"
    ? new LocalMediaPipeline({
        artifactsDir: config.ARTIFACTS_DIR,
        ffmpegPath,
        ffprobePath,
        ...(speechSynthesizer ? { speechSynthesizer } : {}),
        ...(avatarGenerator ? { avatarGenerator } : {}),
        avatarHandlesSpeech: config.TTS_PROVIDER === "heygen",
        downloadTelegramImage: (fileId, destination) => telegramFiles.download(fileId, destination),
        ...(musicClient ? { downloadBackgroundMusic: (query: string, destination: string) => musicClient.download(query, destination) } : {}),
        ...(brollBackgroundGenerator ? { brollBackgroundGenerator } : {}),
      })
    : new MockMediaPipeline();
  if (config.SCRIPT_PROVIDER === "openai" && !config.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when SCRIPT_PROVIDER=openai");
  }
  if (config.SCRIPT_PROVIDER === "gemini" && !config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required when SCRIPT_PROVIDER=gemini");
  }
  const useOpenAi = config.SCRIPT_PROVIDER === "openai"
    || (config.SCRIPT_PROVIDER === "auto" && Boolean(config.OPENAI_API_KEY));
  const useGemini = config.SCRIPT_PROVIDER === "gemini"
    || (config.SCRIPT_PROVIDER === "auto" && !useOpenAi && Boolean(config.GEMINI_API_KEY));
  const useOpenRouter = config.SCRIPT_PROVIDER === "openrouter"
    || (config.SCRIPT_PROVIDER === "auto" && !useOpenAi && !useGemini && Boolean(config.OPENROUTER_API_KEY));
  const scripts = useGemini
    ? new GeminiScriptGenerator({ apiKey: config.GEMINI_API_KEY!, model: config.GEMINI_MODEL, telegramFiles })
    : useOpenRouter
    ? new OpenRouterScriptGenerator({ apiKey: config.OPENROUTER_API_KEY!, model: config.OPENROUTER_MODEL, telegramFiles })
    : useOpenAi
    ? new OpenAiScriptGenerator({ apiKey: config.OPENAI_API_KEY!, model: config.OPENAI_MODEL })
    : new MockScriptGenerator();
  const scriptLabel = useGemini
    ? `Gemini/${config.GEMINI_MODEL}`
    : useOpenRouter ? `OpenRouter/${config.OPENROUTER_MODEL}` : useOpenAi ? config.OPENAI_MODEL : "mock";
  const youtube = config.YOUTUBE_CLIENT_ID && config.YOUTUBE_CLIENT_SECRET
    ? new YoutubeAuthService({
        clientId: config.YOUTUBE_CLIENT_ID,
        clientSecret: config.YOUTUBE_CLIENT_SECRET,
        redirectUri: config.YOUTUBE_OAUTH_REDIRECT_URI,
        tokenStore: prisma ? new PrismaYoutubeTokenStore(prisma) : new FileYoutubeTokenStore(config.YOUTUBE_TOKEN_FILE),
      })
    : undefined;
  await youtube?.start();
  const publisher = youtube ? new YoutubePublisher(youtube, config.YOUTUBE_PRIVACY_STATUS, artifactStore) : new MockSocialPublisher();
  const { jobService, queue, recovery } = createContainer(repository, (kind, jobId, error) => {
    logger.error({ kind, jobId, error }, "Background task failed");
  }, media, scripts, publisher, artifactStore, config.AUTO_RECOVER_PRODUCTION);
  const bot = createBot(config.TELEGRAM_BOT_TOKEN, jobService, queue, {
    storage: `${prisma ? "PostgreSQL" : "file"} + ${artifactStore.name}`,
    scripts: scriptLabel,
    media: config.MEDIA_MODE === "local" ? `FFmpeg + ${config.TTS_PROVIDER} TTS` : config.MEDIA_MODE,
    avatar: avatarGenerator ? "heygen" : "placeholder",
    publishing: youtube ? "youtube" : "disabled",
  }, artifactStore, youtube, new DraftStore(prisma));
  const webhookBaseUrl = config.TELEGRAM_WEBHOOK_URL ?? process.env.RENDER_EXTERNAL_URL;
  const webhookSecret = createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest("hex");
  const telegramWebhook = webhookBaseUrl
    ? webhookCallback(bot, "http", { secretToken: webhookSecret, onTimeout: "return", timeoutMilliseconds: 55_000 })
    : undefined;
  const healthServer = new HealthServer(config.PORT, telegramWebhook, youtube ? (request, response) => void youtube.handleCallback(request, response) : undefined);
  await healthServer.start();
  const recoveryResult = await recovery.recover();
  logger.info(recoveryResult, "Interrupted jobs recovery completed");

  const shutdown = async () => {
    if (bot.isRunning()) bot.stop();
    await queue.drain();
    await youtube?.stop();
    await healthServer.stop();
    await prisma?.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  logger.info({
    storage: prisma ? "postgresql" : "file",
    artifactStorage: artifactStore.name,
    media: config.MEDIA_MODE,
    tts: config.TTS_PROVIDER,
    scripts: scriptLabel,
    avatar: avatarGenerator ? "heygen" : "placeholder",
    youtube: Boolean(youtube),
  }, webhookBaseUrl ? "Starting Telegram bot in webhook mode" : "Starting Telegram bot in long-polling mode");
  const commands = [
    { command: "create", description: "Создать новый ролик" },
    { command: "done", description: "Закончить загрузку изображений" },
    { command: "queue", description: "Показать очередь" },
    { command: "status", description: "Статус задачи" },
    { command: "preview", description: "Получить готовый MP4" },
    { command: "connect_youtube", description: "Подключить YouTube" },
    { command: "publish", description: "Опубликовать ролик" },
    { command: "retry", description: "Повторить задачу" },
    { command: "cancel", description: "Отменить задачу" },
    { command: "health", description: "Проверить интеграции" },
    { command: "help", description: "Справка" },
  ];
  await bot.api.setMyCommands(commands);
  if (webhookBaseUrl) {
    await bot.init();
    await bot.api.setWebhook(`${webhookBaseUrl.replace(/\/$/, "")}/telegram`, { secret_token: webhookSecret });
    logger.info({ username: bot.botInfo.username }, "Telegram webhook configured");
  } else {
    await bot.api.deleteWebhook();
    await bot.start({ onStart: ({ username }) => logger.info({ username }, "Telegram bot started") });
  }
}
