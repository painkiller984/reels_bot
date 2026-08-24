import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { z } from "zod";
import type { JobQueue } from "../application/job-queue.js";
import type { JobService } from "../application/job-service.js";
import type { ArtifactStore } from "../application/ports.js";
import type { Brief, ContentJob, Platform } from "../domain/job.js";
import { DraftStore, type BriefDraft } from "./draft-store.js";
import { formatJob, formatQueue, jobTitle, statusLabels } from "./formatters.js";

export interface BotCapabilities {
  storage: string;
  scripts: string;
  media: string;
  avatar: "heygen" | "placeholder";
  publishing: "youtube" | "disabled";
}

export interface YoutubeConnection {
  createAuthorizationUrl(userId: string): string;
  isConnected(userId: string): Promise<boolean>;
}

const goalLabels: Record<Brief["goal"], string> = {
  reach: "Охваты",
  sales: "Продажи",
  education: "Обучение",
  engagement: "Вовлечение",
};

function argumentOf(text: string | undefined): string {
  return text?.replace(/^\/\w+(?:@\w+)?\s*/, "").trim() ?? "";
}

function userIdOf(ctx: Context): string {
  const id = ctx.from?.id ?? ctx.chat?.id;
  if (id === undefined) throw new Error("Не удалось определить пользователя Telegram");
  return String(id);
}

function userFacingError(error: unknown): string {
  return error instanceof z.ZodError
    ? `Некорректные данные: ${error.issues.map((issue) => issue.message).join(", ")}`
    : error instanceof Error ? error.message : "Неизвестная ошибка";
}

function safeErrorDetails(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "UnknownError";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/gu, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .slice(0, 500);
  return { name, message };
}

async function reportBotError(ctx: Context, error: unknown): Promise<void> {
  console.error(JSON.stringify({ event: "telegram_update_failed", ...safeErrorDetails(error) }));
  try {
    await ctx.reply(`Не удалось выполнить команду: ${userFacingError(error)}`);
  } catch (replyError) {
    console.error(JSON.stringify({ event: "telegram_error_reply_failed", ...safeErrorDetails(replyError) }));
  }
}

function goalKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Охваты", "brief:goal:reach").text("Продажи", "brief:goal:sales").row()
    .text("Обучение", "brief:goal:education").text("Вовлечение", "brief:goal:engagement");
}

function toneKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Живой", "brief:tone:Живой и энергичный").text("Экспертный", "brief:tone:Экспертный и спокойный").row()
    .text("Дружелюбный", "brief:tone:Дружелюбный").text("Провокационный", "brief:tone:Провокационный");
}

function durationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("15 сек", "brief:duration:15").text("30 сек", "brief:duration:30")
    .text("45 сек", "brief:duration:45").text("60 сек", "brief:duration:60");
}

function platformKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("YouTube", "brief:platforms:youtube");
}

function avatarKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Готовый аватар — экономно", "brief:avatar:generated").row()
    .text("Создать новую внешность — +$1", "brief:avatar:describe").row()
    .text("Аватар из фото — +$1", "brief:avatar:photo");
}

function productImagesKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Готово — перейти дальше", "brief:product:done");
}

type JobAction = "status" | "preview" | "publish" | "retry" | "cancel";

function jobKeyboard(job: ContentJob): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("Статус", `job:status:${job.id}`)
    .text("Видео", `job:preview:${job.id}`);
  if (job.status === "ready_for_approval" || job.publications.some((item) => item.status === "failed")) {
    keyboard.row().text("Опубликовать", `job:publish:${job.id}`);
  }
  if (job.status === "failed") keyboard.row().text("Повторить производство", `job:retry:${job.id}`);
  if (!["published", "cancelled"].includes(job.status)) keyboard.row().text("Отменить", `job:cancel:${job.id}`);
  return keyboard;
}

function selectionKeyboard(jobs: ContentJob[], action: JobAction): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  jobs.slice(0, 10).forEach((job, index) => {
    const raw = `${index + 1}. ${jobTitle(job)} · ${statusLabels[job.status]}`;
    keyboard.text(raw.length > 58 ? `${raw.slice(0, 55)}…` : raw, `job:${action}:${job.id}`).row();
  });
  return keyboard;
}

function draftSummary(draft: BriefDraft): string {
  const avatarCreationCost = draft.avatarMode === "photo" || Boolean(draft.avatarPrompt) ? 1 : 0;
  const estimatedHeygenCost = (draft.durationSec ?? 45) * 0.05 + avatarCreationCost;
  return [
    "Проверьте бриф:",
    `Тема: ${draft.topic}`,
    `Цель: ${draft.goal ? goalLabels[draft.goal] : "—"}`,
    `Аудитория: ${draft.audience}`,
    `Тон: ${draft.tone}`,
    `Длительность: ${draft.durationSec} сек`,
    `Платформы: ${draft.platforms?.join(", ")}`,
    `Исходные изображения: ${draft.productImageFileIds?.length ?? (draft.productImageFileId ? 1 : 0)}`,
    `Аватар: ${draft.avatarMode === "photo" ? "новый из фотографии" : draft.avatarPrompt ? `новый по описанию: ${draft.avatarPrompt}` : "готовый многоразовый"}`,
    `CTA: ${draft.callToAction ?? "автоматический"}`,
    `Ориентировочная стоимость HeyGen: $${estimatedHeygenCost.toFixed(2)} (по текущему API-тарифу)`,
  ].join("\n");
}

function completedBrief(draft: BriefDraft): unknown {
  return {
    topic: draft.topic,
    goal: draft.goal,
    audience: draft.audience,
    tone: draft.tone,
    durationSec: draft.durationSec,
    platforms: draft.platforms,
    productImageFileId: draft.productImageFileId,
    productImageFileIds: draft.productImageFileIds,
    avatarMode: draft.avatarMode ?? "generated",
    ...(draft.avatarPrompt ? { avatarPrompt: draft.avatarPrompt } : {}),
    ...(draft.avatarImageFileId ? { avatarImageFileId: draft.avatarImageFileId } : {}),
    ...(draft.callToAction ? { callToAction: draft.callToAction } : {}),
  };
}

async function acceptImage(ctx: Context, drafts: DraftStore, fileId: string): Promise<void> {
  const userId = userIdOf(ctx);
  const draft = await drafts.get(userId);
  if (!draft || !["product_image", "avatar_image"].includes(draft.stage)) {
    await ctx.reply("Чтобы добавить изображение к ролику, сначала запустите /create.");
    return;
  }
  if (draft.stage === "product_image") {
    const existing = draft.productImageFileIds ?? (draft.productImageFileId ? [draft.productImageFileId] : []);
    if (existing.length >= 6) {
      await ctx.reply("Уже добавлено максимум 6 изображений. Нажмите «Готово — перейти дальше».", { reply_markup: productImagesKeyboard() });
      return;
    }
    if (existing.includes(fileId)) {
      await ctx.reply(`Это изображение уже принято. Сейчас загружено: ${existing.length}.`, { reply_markup: productImagesKeyboard() });
      return;
    }
    const productImageFileIds = [...existing, fileId];
    await drafts.update(userId, { productImageFileId: productImageFileIds[0]!, productImageFileIds });
    await ctx.reply(
      `Исходное изображение ${productImageFileIds.length}/6 принято. Можно добавить другие ракурсы или нажать «Готово — перейти дальше».`,
      { reply_markup: productImagesKeyboard() },
    );
  } else {
    await drafts.update(userId, { avatarImageFileId: fileId, stage: "goal" });
    await ctx.reply("Фото аватара принято. Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
  }
}

export function createBot(token: string, jobs: JobService, queue: JobQueue, capabilities: BotCapabilities, artifactStore: ArtifactStore, youtube?: YoutubeConnection, draftStore?: DraftStore): Bot {
  const bot = new Bot(token);
  const drafts = draftStore ?? new DraftStore();

  // bot.catch only protects long polling. This middleware also protects webhook mode.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      await reportBotError(ctx, error);
    }
  });

  const help =
    "/create — пошагово создать ролик\n" +
    "/create тема — быстрый старт\n" +
    "/done — закончить добавление изображений\n" +
    "/status — выбрать ролик и посмотреть статус\n" +
    "/queue — очередь\n" +
    "/preview — выбрать ролик и получить MP4\n" +
    "/connect_youtube — подключить канал YouTube\n" +
    "/publish — выбрать ролик для публикации\n" +
    "/retry — выбрать неудавшийся ролик и повторить\n" +
    "/cancel — выбрать ролик и отменить\n" +
    "/health — состояние интеграций\n" +
    "/settings — текущий режим";

  bot.command(["start", "help"], (ctx) => ctx.reply(`AI Reels Bot\n\n${help}`));

  bot.command("create", async (ctx) => {
    const userId = userIdOf(ctx);
    const topic = argumentOf(ctx.message?.text);
    await drafts.start(userId, topic || undefined);
    if (!topic) await ctx.reply("Шаг 1/9. Пришлите тему ролика одним сообщением.");
    else {
      await drafts.update(userId, { stage: "product_image" });
      await ctx.reply("Шаг 2/9. Пришлите от 1 до 6 исходных изображений того, о чём должен быть ролик. AI сам распознает содержимое. После загрузки нажмите «Готово».");
    }
  });

  const completeProductImages = async (ctx: Context): Promise<void> => {
    const userId = userIdOf(ctx);
    const draft = await drafts.get(userId);
    if (!draft || draft.stage !== "product_image") {
      await ctx.reply("Сессия создания не найдена. Запустите /create ещё раз — после исправления следующие шаги сохраняются между перезапусками.");
      return;
    }
    const imageCount = draft.productImageFileIds?.length ?? (draft.productImageFileId ? 1 : 0);
    if (imageCount === 0) {
      await ctx.reply("Нужно минимум одно исходное изображение объекта ролика.");
      return;
    }
    await drafts.update(userId, { stage: "avatar_mode" });
    await ctx.reply(`Принято изображений: ${imageCount}. Шаг 3/9. Как создать ведущего?`, { reply_markup: avatarKeyboard() });
  };

  bot.command("done", completeProductImages);
  bot.callbackQuery("brief:product:done", async (ctx) => {
    await ctx.answerCallbackQuery();
    await completeProductImages(ctx);
  });

  bot.callbackQuery(/^brief:goal:(reach|sales|education|engagement)$/, async (ctx) => {
    const goal = ctx.match[1] as Brief["goal"];
    const draft = await drafts.update(userIdOf(ctx), { goal, stage: "audience" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 5/9. Опишите целевую аудиторию.");
  });

  bot.callbackQuery(/^brief:tone:(.+)$/, async (ctx) => {
    const draft = await drafts.update(userIdOf(ctx), { tone: ctx.match[1]!, stage: "duration" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 7/9. Выберите длительность.", { reply_markup: durationKeyboard() });
  });

  bot.callbackQuery(/^brief:duration:(15|30|45|60)$/, async (ctx) => {
    const draft = await drafts.update(userIdOf(ctx), { durationSec: Number(ctx.match[1]), stage: "platforms" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 8/9. Куда планируется публикация?", { reply_markup: platformKeyboard() });
  });

  bot.callbackQuery("brief:platforms:youtube", async (ctx) => {
    const platforms: Platform[] = ["youtube"];
    const draft = await drafts.update(userIdOf(ctx), { platforms, stage: "cta" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 9/9. Пришлите призыв к действию или напишите /skip.");
  });

  bot.command("skip", async (ctx) => {
    const draft = await drafts.get(userIdOf(ctx));
    if (!draft) return;
    if (draft.stage === "product_image") {
      await ctx.reply("Исходное изображение обязательно. Пришлите то, о чём должен быть ролик.");
      return;
    }
    if (draft.stage !== "cta") return;
    const updated = await drafts.update(userIdOf(ctx), { stage: "confirm" });
    await ctx.reply(draftSummary(updated!), {
      reply_markup: new InlineKeyboard().text("Создать", "brief:confirm").text("Отмена", "brief:cancel"),
    });
  });

  bot.callbackQuery(/^brief:avatar:(generated|describe|photo)$/, async (ctx) => {
    const choice = ctx.match[1];
    const userId = userIdOf(ctx);
    await ctx.answerCallbackQuery();
    if (choice === "generated") {
      await drafts.update(userId, { avatarMode: "generated", stage: "goal" });
      await ctx.reply("Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
    } else if (choice === "describe") {
      await drafts.update(userId, { avatarMode: "generated", stage: "avatar_prompt" });
      await ctx.reply("Этот вариант создаст новый HeyGen-аватар и добавит примерно $1 к стоимости. Опишите внешность ведущего: пол, возраст, одежду и стиль.");
    } else {
      await drafts.update(userId, { avatarMode: "photo", stage: "avatar_image" });
      await ctx.reply("Создание аватара из фото добавит примерно $1 к стоимости. Пришлите фронтальную фотографию человека с хорошим освещением.");
    }
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (photo) await acceptImage(ctx, drafts, photo.file_id);
  });

  bot.on("message:document", async (ctx) => {
    if (!ctx.message.document.mime_type?.startsWith("image/")) {
      await ctx.reply("Нужен файл изображения PNG, JPEG или WEBP.");
      return;
    }
    await acceptImage(ctx, drafts, ctx.message.document.file_id);
  });

  bot.callbackQuery("brief:confirm", async (ctx) => {
    const userId = userIdOf(ctx);
    const draft = await drafts.get(userId);
    await ctx.answerCallbackQuery();
    if (!draft || draft.stage !== "confirm") return;
    const job = await jobs.create(userId, completedBrief(draft));
    await drafts.delete(userId);
    queue.enqueue("produce", userId, job.id);
    await ctx.reply(`«${jobTitle(job)}» добавлен в очередь.`, { reply_markup: jobKeyboard(job) });
  });

  bot.callbackQuery("brief:cancel", async (ctx) => {
    await drafts.delete(userIdOf(ctx));
    await ctx.answerCallbackQuery();
    await ctx.reply("Создание отменено.");
  });

  bot.on("message:text", async (ctx, next) => {
    const userId = userIdOf(ctx);
    const draft = await drafts.get(userId);
    if (!draft || ctx.message.text.startsWith("/")) return next();
    if (draft.stage === "topic") {
      if (ctx.message.text.trim().length < 3) return void await ctx.reply("Тема слишком короткая.");
      await drafts.update(userId, { topic: ctx.message.text.trim(), stage: "product_image" });
      await ctx.reply("Шаг 2/9. Пришлите от 1 до 6 исходных изображений того, о чём должен быть ролик. AI сам распознает содержимое. После загрузки нажмите «Готово».");
    } else if (draft.stage === "audience") {
      await drafts.update(userId, { audience: ctx.message.text.trim(), stage: "tone" });
      await ctx.reply("Шаг 6/9. Выберите тон.", { reply_markup: toneKeyboard() });
    } else if (draft.stage === "avatar_prompt") {
      const avatarPrompt = ctx.message.text.trim();
      if (avatarPrompt.length < 3) return void await ctx.reply("Описание слишком короткое.");
      await drafts.update(userId, { avatarPrompt, stage: "goal" });
      await ctx.reply("Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
    } else if (draft.stage === "cta") {
      const updated = await drafts.update(userId, { callToAction: ctx.message.text.trim(), stage: "confirm" });
      await ctx.reply(draftSummary(updated!), {
        reply_markup: new InlineKeyboard().text("Создать", "brief:confirm").text("Отмена", "brief:cancel"),
      });
    } else {
      await next();
    }
  });

  const showJobPicker = async (ctx: Context, action: JobAction): Promise<void> => {
    const all = await jobs.list(userIdOf(ctx));
    const available = all.filter((job) => {
      if (action === "preview") return job.artifacts.some((artifact) => artifact.kind === "render");
      if (action === "publish") return job.status === "ready_for_approval" || job.publications.some((item) => item.status === "failed");
      if (action === "retry") return job.status === "failed";
      if (action === "cancel") return !["published", "cancelled"].includes(job.status);
      return true;
    });
    if (available.length === 0) {
      await ctx.reply(action === "status" ? "Роликов пока нет. Запустите /create." : "Сейчас нет роликов, доступных для этого действия.");
      return;
    }
    const labels: Record<JobAction, string> = {
      status: "Выберите ролик:", preview: "Какой ролик показать?", publish: "Какой ролик опубликовать?",
      retry: "Какой ролик повторить?", cancel: "Какой ролик отменить?",
    };
    await ctx.reply(labels[action], { reply_markup: selectionKeyboard(available, action) });
  };

  const sendStatus = async (ctx: Context, id: string): Promise<void> => {
    const job = await jobs.get(userIdOf(ctx), id);
    const render = job.artifacts.find((artifact) => artifact.kind === "render");
    const downloadUrl = render ? await artifactStore.createDownloadUrl(render.uri) : undefined;
    await ctx.reply(formatJob(job) + (downloadUrl ? `\n\nСкачать ролик (ссылка на 1 час):\n${downloadUrl}` : ""), {
      link_preview_options: { is_disabled: true }, reply_markup: jobKeyboard(job),
    });
  };

  const sendPreview = async (ctx: Context, id: string): Promise<void> => {
    const job = await jobs.get(userIdOf(ctx), id);
    const render = job.artifacts.find((artifact) => artifact.kind === "render");
    if (!render || render.uri.startsWith("mock://")) return void await ctx.reply("Файл предпросмотра ещё не готов.", { reply_markup: jobKeyboard(job) });
    const file = await artifactStore.materialize(render.uri);
    await ctx.replyWithVideo(new InputFile(file), { caption: `«${jobTitle(job)}»`, reply_markup: jobKeyboard(job) });
  };

  const enqueuePublication = async (ctx: Context, id: string): Promise<void> => {
    if (capabilities.publishing === "disabled") {
      return void await ctx.reply("Публикация временно отключена владельцем бота.");
    }
    const userId = userIdOf(ctx);
    const job = await jobs.get(userId, id);
    const retryPublication = await jobs.canRetryPublication(userId, id);
    if (job.status !== "ready_for_approval" && !retryPublication) {
      return void await ctx.reply(`Публикация недоступна. Статус: ${statusLabels[job.status]}`, { reply_markup: jobKeyboard(job) });
    }
    queue.enqueue("publish", userId, id);
    await ctx.reply(`${retryPublication ? "Повторная публикация" : "Публикация"} «${jobTitle(job)}» добавлена в очередь.`);
  };

  const enqueueRetry = async (ctx: Context, id: string): Promise<void> => {
    const userId = userIdOf(ctx);
    const job = await jobs.get(userId, id);
    await jobs.retryFailedProduction(userId, id);
    queue.enqueue("produce", userId, id);
    await ctx.reply(`«${jobTitle(job)}» поставлен в очередь заново.`);
  };

  const cancelJob = async (ctx: Context, id: string): Promise<void> => {
    const job = await jobs.cancel(userIdOf(ctx), id);
    await ctx.reply(formatJob(job), { reply_markup: jobKeyboard(job) });
  };

  bot.command("status", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await showJobPicker(ctx, "status");
    await sendStatus(ctx, id);
  });

  bot.command("queue", async (ctx) => {
    const list = await jobs.list(userIdOf(ctx));
    if (list.length > 0) await ctx.reply(formatQueue(list), { reply_markup: selectionKeyboard(list, "status") });
    else await ctx.reply(formatQueue(list));
  });

  bot.command("connect_youtube", async (ctx) => {
    if (!youtube) return void await ctx.reply("YouTube OAuth ещё не настроен владельцем бота.");
    const url = youtube.createAuthorizationUrl(userIdOf(ctx));
    await ctx.reply("Откройте ссылку, войдите в нужный YouTube-канал и подтвердите доступ. После сообщения об успешной авторизации вернитесь в бот.\n\n" + url, { link_preview_options: { is_disabled: true } });
  });

  bot.command("preview", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await showJobPicker(ctx, "preview");
    await sendPreview(ctx, id);
  });

  bot.command("publish", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await showJobPicker(ctx, "publish");
    await enqueuePublication(ctx, id);
  });

  bot.command("retry", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await showJobPicker(ctx, "retry");
    await enqueueRetry(ctx, id);
  });

  bot.command("cancel", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await showJobPicker(ctx, "cancel");
    await cancelJob(ctx, id);
  });

  bot.callbackQuery(/^job:(status|preview|publish|retry|cancel):([A-Za-z0-9_-]+)$/, async (ctx) => {
    const action = ctx.match[1] as JobAction;
    const id = ctx.match[2]!;
    await ctx.answerCallbackQuery();
    if (action === "status") await sendStatus(ctx, id);
    else if (action === "preview") await sendPreview(ctx, id);
    else if (action === "publish") await enqueuePublication(ctx, id);
    else if (action === "retry") await enqueueRetry(ctx, id);
    else await cancelJob(ctx, id);
  });

  bot.command("health", async (ctx) => {
    await ctx.reply([
      "Состояние интеграций:",
      `Хранилище: ${capabilities.storage}`,
      `Сценарии: ${capabilities.scripts}`,
      `Медиа: ${capabilities.media}`,
      `Аватар: ${capabilities.avatar}`,
      `Публикация: ${capabilities.publishing}`,
      `YouTube: ${youtube ? (await youtube.isConnected(userIdOf(ctx)) ? "канал подключён" : "требуется /connect_youtube") : "не настроен"}`,
      `Фоновых задач: ${queue.pendingCount()}`,
    ].join("\n"));
  });

  bot.command("settings", (ctx) => ctx.reply(
    "Настройки задаются владельцем через переменные окружения.\n" +
    `LLM: ${capabilities.scripts}\nMedia: ${capabilities.media}\nStorage: ${capabilities.storage}`,
  ));

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply("Неизвестная команда. Откройте /help. Для выбора ролика бот покажет кнопки.");
    }
  });

  queue.onCompleted(async (kind, userId, jobId) => {
    const job = await jobs.get(userId, jobId);
    if (kind === "produce") {
      const render = job.artifacts.find((artifact) => artifact.kind === "render");
      if (render && !render.uri.startsWith("mock://")) {
        const file = await artifactStore.materialize(render.uri);
        await bot.api.sendVideo(userId, new InputFile(file), { caption: `«${jobTitle(job)}» готов.`, reply_markup: jobKeyboard(job) });
      } else {
        await bot.api.sendMessage(userId, `«${jobTitle(job)}» готов.`, { reply_markup: jobKeyboard(job) });
      }
    } else {
      await bot.api.sendMessage(userId, formatJob(job), { reply_markup: jobKeyboard(job) });
    }
  });

  bot.catch((error) => reportBotError(error.ctx, error.error));

  return bot;
}
