import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { z } from "zod";
import type { JobQueue } from "../application/job-queue.js";
import type { JobService } from "../application/job-service.js";
import type { ArtifactStore } from "../application/ports.js";
import type { Brief, Platform } from "../domain/job.js";
import { DraftStore, type BriefDraft } from "./draft-store.js";
import { formatJob, formatQueue, statusLabels } from "./formatters.js";

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
    .text("Создать автоматически", "brief:avatar:generated").row()
    .text("Описать внешность", "brief:avatar:describe").row()
    .text("Загрузить фото человека", "brief:avatar:photo");
}

function draftSummary(draft: BriefDraft): string {
  return [
    "Проверьте бриф:",
    `Тема: ${draft.topic}`,
    `Цель: ${draft.goal ? goalLabels[draft.goal] : "—"}`,
    `Аудитория: ${draft.audience}`,
    `Тон: ${draft.tone}`,
    `Длительность: ${draft.durationSec} сек`,
    `Платформы: ${draft.platforms?.join(", ")}`,
    `Фото продукта: ${draft.productImageFileId ? "добавлено" : "обязательно"}`,
    `Аватар: ${draft.avatarMode === "photo" ? "из фотографии" : draft.avatarPrompt ? `сгенерированный: ${draft.avatarPrompt}` : "сгенерированный автоматически"}`,
    `CTA: ${draft.callToAction ?? "автоматический"}`,
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
    avatarMode: draft.avatarMode ?? "generated",
    ...(draft.avatarPrompt ? { avatarPrompt: draft.avatarPrompt } : {}),
    ...(draft.avatarImageFileId ? { avatarImageFileId: draft.avatarImageFileId } : {}),
    ...(draft.callToAction ? { callToAction: draft.callToAction } : {}),
  };
}

async function acceptImage(ctx: Context, drafts: DraftStore, fileId: string): Promise<void> {
  const userId = userIdOf(ctx);
  const draft = drafts.get(userId);
  if (!draft || !["product_image", "avatar_image"].includes(draft.stage)) {
    await ctx.reply("Чтобы добавить изображение к ролику, сначала запустите /create.");
    return;
  }
  if (draft.stage === "product_image") {
    drafts.update(userId, { productImageFileId: fileId, stage: "avatar_mode" });
    await ctx.reply("Изображение продукта принято. Шаг 3/9. Как создать ведущего?", { reply_markup: avatarKeyboard() });
  } else {
    drafts.update(userId, { avatarImageFileId: fileId, stage: "goal" });
    await ctx.reply("Фото аватара принято. Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
  }
}

export function createBot(token: string, jobs: JobService, queue: JobQueue, capabilities: BotCapabilities, artifactStore: ArtifactStore, youtube?: YoutubeConnection): Bot {
  const bot = new Bot(token);
  const drafts = new DraftStore();

  const help =
    "/create — пошагово создать ролик\n" +
    "/create тема — быстрый старт\n" +
    "/status ID — статус задачи\n" +
    "/queue — очередь\n" +
    "/preview ID — получить готовый MP4\n" +
    "/connect_youtube — подключить канал YouTube\n" +
    "/publish ID — публикация\n" +
    "/retry ID — повторить упавшее производство\n" +
    "/cancel ID — отменить задачу\n" +
    "/health — состояние интеграций\n" +
    "/settings — текущий режим";

  bot.command(["start", "help"], (ctx) => ctx.reply(`AI Reels Bot\n\n${help}`));

  bot.command("create", async (ctx) => {
    const userId = userIdOf(ctx);
    const topic = argumentOf(ctx.message?.text);
    drafts.start(userId, topic || undefined);
    if (!topic) await ctx.reply("Шаг 1/9. Пришлите тему ролика одним сообщением.");
    else {
      drafts.update(userId, { stage: "product_image" });
      await ctx.reply("Шаг 2/9. Пришлите обязательное изображение продукта, логотип или скриншот приложения.");
    }
  });

  bot.callbackQuery(/^brief:goal:(reach|sales|education|engagement)$/, async (ctx) => {
    const goal = ctx.match[1] as Brief["goal"];
    const draft = drafts.update(userIdOf(ctx), { goal, stage: "audience" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 5/9. Опишите целевую аудиторию.");
  });

  bot.callbackQuery(/^brief:tone:(.+)$/, async (ctx) => {
    const draft = drafts.update(userIdOf(ctx), { tone: ctx.match[1]!, stage: "duration" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 7/9. Выберите длительность.", { reply_markup: durationKeyboard() });
  });

  bot.callbackQuery(/^brief:duration:(15|30|45|60)$/, async (ctx) => {
    const draft = drafts.update(userIdOf(ctx), { durationSec: Number(ctx.match[1]), stage: "platforms" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 8/9. Куда планируется публикация?", { reply_markup: platformKeyboard() });
  });

  bot.callbackQuery("brief:platforms:youtube", async (ctx) => {
    const platforms: Platform[] = ["youtube"];
    const draft = drafts.update(userIdOf(ctx), { platforms, stage: "cta" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply("Шаг 9/9. Пришлите призыв к действию или напишите /skip.");
  });

  bot.command("skip", async (ctx) => {
    const draft = drafts.get(userIdOf(ctx));
    if (!draft) return;
    if (draft.stage === "product_image") {
      await ctx.reply("Фото продукта обязательно. Пришлите фотографию, логотип или скриншот приложения.");
      return;
    }
    if (draft.stage !== "cta") return;
    drafts.update(userIdOf(ctx), { stage: "confirm" });
    await ctx.reply(draftSummary(drafts.get(userIdOf(ctx))!), {
      reply_markup: new InlineKeyboard().text("Создать", "brief:confirm").text("Отмена", "brief:cancel"),
    });
  });

  bot.callbackQuery(/^brief:avatar:(generated|describe|photo)$/, async (ctx) => {
    const choice = ctx.match[1];
    const userId = userIdOf(ctx);
    await ctx.answerCallbackQuery();
    if (choice === "generated") {
      drafts.update(userId, { avatarMode: "generated", stage: "goal" });
      await ctx.reply("Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
    } else if (choice === "describe") {
      drafts.update(userId, { avatarMode: "generated", stage: "avatar_prompt" });
      await ctx.reply("Опишите внешность ведущего: пол, возраст, одежду и стиль. Например: «молодая женщина в деловом костюме, современная студия».");
    } else {
      drafts.update(userId, { avatarMode: "photo", stage: "avatar_image" });
      await ctx.reply("Пришлите фронтальную фотографию человека с хорошим освещением.");
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
    const draft = drafts.get(userId);
    await ctx.answerCallbackQuery();
    if (!draft || draft.stage !== "confirm") return;
    const job = await jobs.create(userId, completedBrief(draft));
    drafts.delete(userId);
    queue.enqueue("produce", userId, job.id);
    await ctx.reply(`Задача #${job.id} добавлена в очередь.\nПроверить: /status ${job.id}`);
  });

  bot.callbackQuery("brief:cancel", async (ctx) => {
    drafts.delete(userIdOf(ctx));
    await ctx.answerCallbackQuery();
    await ctx.reply("Создание отменено.");
  });

  bot.on("message:text", async (ctx, next) => {
    const userId = userIdOf(ctx);
    const draft = drafts.get(userId);
    if (!draft || ctx.message.text.startsWith("/")) return next();
    if (draft.stage === "topic") {
      if (ctx.message.text.trim().length < 3) return void await ctx.reply("Тема слишком короткая.");
      drafts.update(userId, { topic: ctx.message.text.trim(), stage: "product_image" });
      await ctx.reply("Шаг 2/9. Пришлите обязательное изображение продукта, логотип или скриншот приложения.");
    } else if (draft.stage === "audience") {
      drafts.update(userId, { audience: ctx.message.text.trim(), stage: "tone" });
      await ctx.reply("Шаг 6/9. Выберите тон.", { reply_markup: toneKeyboard() });
    } else if (draft.stage === "avatar_prompt") {
      const avatarPrompt = ctx.message.text.trim();
      if (avatarPrompt.length < 3) return void await ctx.reply("Описание слишком короткое.");
      drafts.update(userId, { avatarPrompt, stage: "goal" });
      await ctx.reply("Шаг 4/9. Какая цель ролика?", { reply_markup: goalKeyboard() });
    } else if (draft.stage === "cta") {
      const updated = drafts.update(userId, { callToAction: ctx.message.text.trim(), stage: "confirm" });
      await ctx.reply(draftSummary(updated!), {
        reply_markup: new InlineKeyboard().text("Создать", "brief:confirm").text("Отмена", "brief:cancel"),
      });
    } else {
      await next();
    }
  });

  bot.command("status", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await ctx.reply("Укажите ID: /status abc123");
    const job = await jobs.get(userIdOf(ctx), id);
    const render = job.artifacts.find((artifact) => artifact.kind === "render");
    const downloadUrl = render ? await artifactStore.createDownloadUrl(render.uri) : undefined;
    await ctx.reply(formatJob(job) + (downloadUrl ? `\n\nСкачать ролик (ссылка на 1 час):\n${downloadUrl}` : ""), { link_preview_options: { is_disabled: true } });
  });

  bot.command("queue", async (ctx) => ctx.reply(formatQueue(await jobs.list(userIdOf(ctx)))));

  bot.command("connect_youtube", async (ctx) => {
    if (!youtube) return void await ctx.reply("YouTube OAuth ещё не настроен владельцем бота.");
    const url = youtube.createAuthorizationUrl(userIdOf(ctx));
    await ctx.reply("Откройте ссылку, войдите в нужный YouTube-канал и подтвердите доступ. После сообщения об успешной авторизации вернитесь в бот.\n\n" + url, { link_preview_options: { is_disabled: true } });
  });

  bot.command("preview", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await ctx.reply("Укажите ID: /preview abc123");
    const job = await jobs.get(userIdOf(ctx), id);
    const render = job.artifacts.find((artifact) => artifact.kind === "render");
    if (!render || render.uri.startsWith("mock://")) return void await ctx.reply("Файл предпросмотра ещё не готов.");
    const file = await artifactStore.materialize(render.uri);
    await ctx.replyWithVideo(new InputFile(file), { caption: `Ролик #${job.id}` });
  });

  bot.command("publish", async (ctx) => {
    if (capabilities.publishing === "disabled") {
      return void await ctx.reply("Публикация временно отключена. Сначала завершаем производство роликов; YouTube будет подключён последним этапом.");
    }
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await ctx.reply("Укажите ID: /publish abc123");
    const userId = userIdOf(ctx);
    const job = await jobs.get(userId, id);
    if (job.status !== "ready_for_approval") {
      return void await ctx.reply(`Публикация недоступна. Статус: ${statusLabels[job.status]}`);
    }
    queue.enqueue("publish", userId, id);
    await ctx.reply(`Публикация #${id} добавлена в очередь.`);
  });

  bot.command("retry", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await ctx.reply("Укажите ID: /retry abc123");
    const userId = userIdOf(ctx);
    await jobs.retryFailedProduction(userId, id);
    queue.enqueue("produce", userId, id);
    await ctx.reply(`Задача #${id} поставлена заново.`);
  });

  bot.command("cancel", async (ctx) => {
    const id = argumentOf(ctx.message?.text);
    if (!id) return void await ctx.reply("Укажите ID: /cancel abc123");
    await ctx.reply(formatJob(await jobs.cancel(userIdOf(ctx), id)));
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

  queue.onCompleted(async (kind, userId, jobId) => {
    const job = await jobs.get(userId, jobId);
    if (kind === "produce") {
      const render = job.artifacts.find((artifact) => artifact.kind === "render");
      if (render && !render.uri.startsWith("mock://")) {
        const file = await artifactStore.materialize(render.uri);
        await bot.api.sendVideo(userId, new InputFile(file), { caption: `Ролик #${job.id} готов. После проверки можно использовать /publish ${job.id}` });
      } else {
        await bot.api.sendMessage(userId, `Ролик #${job.id} готов. Проверка: /status ${job.id}`);
      }
    } else {
      await bot.api.sendMessage(userId, formatJob(job));
    }
  });

  bot.catch(async (error) => {
    const message = error.error instanceof z.ZodError
      ? `Некорректные данные: ${error.error.issues.map((issue) => issue.message).join(", ")}`
      : error.error instanceof Error ? error.error.message : "Неизвестная ошибка";
    await error.ctx.reply(`Не удалось выполнить команду: ${message}`);
  });

  return bot;
}
