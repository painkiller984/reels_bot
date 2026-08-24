import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { z } from "zod";
import type { AvatarProfileStore } from "../application/avatar-profiles.js";
import type { JobQueue } from "../application/job-queue.js";
import type { JobService } from "../application/job-service.js";
import type { ArtifactStore } from "../application/ports.js";
import type { ContentJob } from "../domain/job.js";
import { DraftStore, type BriefDraft } from "./draft-store.js";
import { formatJob, formatQueue, jobTitle, statusLabels } from "./formatters.js";

export interface BotCapabilities {
  storage: string;
  scripts: string;
  media: string;
  avatar: "heygen" | "placeholder";
  publishing: "youtube" | "disabled";
  defaultAvatarLabel?: string;
}
export interface YoutubeConnection { createAuthorizationUrl(userId: string): string; isConnected(userId: string): Promise<boolean>; }
type JobAction = "status" | "preview" | "publish" | "retry" | "cancel";

const argumentOf = (text: string | undefined): string => text?.replace(/^\/\w+(?:@\w+)?\s*/, "").trim() ?? "";
const userIdOf = (ctx: Context): string => String(ctx.from?.id ?? ctx.chat?.id ?? (() => { throw new Error("Не удалось определить пользователя Telegram"); })());
export function sourceVideoDurationError(duration: number | undefined): string | undefined {
  if (duration === undefined) return "Отправьте ролик как видео, чтобы Telegram передал его длительность.";
  if (duration < 10) return "Исходное видео должно быть длительностью от 10 до 60 секунд. Это видео слишком короткое.";
  if (duration > 60) return "Исходное видео должно быть длительностью от 10 до 60 секунд. Это видео слишком длинное.";
  return undefined;
}
const briefKeyboard = () => new InlineKeyboard().text("Создать ролик", "brief:confirm").text("Отмена", "brief:cancel");

function avatarKeyboard(label: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(label, "brief:avatar:generated").row()
    .text("Мои сохранённые аватары", "brief:avatar:list").row()
    .text("Создать аватар из фото", "brief:avatar:photo");
}
function jobKeyboard(job: ContentJob): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("Статус", `job:status:${job.id}`).text("Видео", `job:preview:${job.id}`);
  if (job.status === "ready_for_approval" || job.publications.some((item) => item.status === "failed")) keyboard.row().text("Опубликовать", `job:publish:${job.id}`);
  if (job.status === "failed") keyboard.row().text("Повторить", `job:retry:${job.id}`);
  if (!['published', 'cancelled'].includes(job.status)) keyboard.row().text("Отменить", `job:cancel:${job.id}`);
  return keyboard;
}
function selectionKeyboard(jobs: ContentJob[], action: JobAction): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  jobs.slice(0, 10).forEach((job, index) => {
    const label = `${index + 1}. ${jobTitle(job)} · ${statusLabels[job.status]}`;
    keyboard.text(label.length > 58 ? `${label.slice(0, 55)}…` : label, `job:${action}:${job.id}`).row();
  });
  return keyboard;
}
function draftSummary(draft: BriefDraft, defaultAvatarLabel: string): string {
  const avatar = draft.avatarMode === "photo" ? "новый из фотографии (будет сохранён)"
    : draft.avatarMode === "saved" ? `сохранённый: ${draft.avatarName ?? "аватар"}` : defaultAvatarLabel;
  return [
    "Проверьте задание:", `Тема: ${draft.topic}`, `Исходный ролик: принят (${draft.sourceVideoDurationSec ?? "?"} сек)`,
    `Аватар: ${avatar}`, "Формат: исходное видео + говорящая AI-голова + субтитры", "Платформа: YouTube",
  ].join("\n");
}
function completedBrief(draft: BriefDraft): unknown {
  const duration = Math.max(10, Math.min(60, draft.sourceVideoDurationSec ?? 30));
  return {
    topic: draft.topic, goal: "education", audience: "широкая аудитория", tone: "живой и уверенный", language: "ru",
    durationSec: duration, platforms: ["youtube"], sourceVideoFileId: draft.sourceVideoFileId, sourceVideoDurationSec: duration,
    avatarMode: draft.avatarMode ?? "generated", ...(draft.avatarId ? { avatarId: draft.avatarId } : {}),
    ...(draft.avatarName ? { avatarName: draft.avatarName } : {}), ...(draft.avatarImageFileId ? { avatarImageFileId: draft.avatarImageFileId } : {}),
  };
}
async function safeReply(ctx: Context, error: unknown): Promise<void> {
  console.error(JSON.stringify({ event: "telegram_update_failed", error: error instanceof Error ? error.message : String(error) }));
  const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : error instanceof Error ? error.message : "Неизвестная ошибка";
  await ctx.reply(`Не удалось выполнить действие: ${message}`);
}

export function createBot(token: string, jobs: JobService, queue: JobQueue, capabilities: BotCapabilities, artifactStore: ArtifactStore, youtube?: YoutubeConnection, draftStore?: DraftStore, avatars?: AvatarProfileStore): Bot {
  const bot = new Bot(token);
  const drafts = draftStore ?? new DraftStore();
  const defaultAvatarLabel = capabilities.defaultAvatarLabel ?? "Основной мужской аватар";
  bot.use(async (ctx, next) => { try { await next(); } catch (error) { await safeReply(ctx, error); } });
  const help = "/create — создать ролик из исходного видео\n/avatars — мои сохранённые аватары\n/status — статус\n/queue — очередь\n/preview — скачать MP4\n/connect_youtube — подключить YouTube\n/publish — публикация\n/retry — повторить\n/cancel — отменить\n/health — состояние сервисов";
  bot.command(["start", "help"], (ctx) => ctx.reply(`AI Reels Bot\n\n${help}`));

  bot.command("create", async (ctx) => {
    const topic = argumentOf(ctx.message?.text);
    await drafts.start(userIdOf(ctx), topic || undefined);
    await ctx.reply(topic
      ? "Шаг 1/3. Пришлите исходное видео, которое должен обозревать аватар."
      : "Шаг 1/3. Пришлите исходное видео. После этого я запрошу тему ролика.");
  });

  const showAvatarChoice = async (ctx: Context): Promise<void> => {
    await drafts.update(userIdOf(ctx), { stage: "avatar" });
    await ctx.reply("Шаг 3/3. Выберите ведущего. Основной аватар уже создан в HeyGen и не тратит кредит на создание.", { reply_markup: avatarKeyboard(defaultAvatarLabel) });
  };
  const acceptVideo = async (ctx: Context, fileId: string, duration: number | undefined): Promise<void> => {
    const draft = await drafts.get(userIdOf(ctx));
    if (!draft || draft.stage !== "source_video") return void await ctx.reply("Сначала запустите /create.");
    const durationError = sourceVideoDurationError(duration);
    if (durationError) return void await ctx.reply(durationError);
    const safeDuration = duration!;
    if (draft.topic) {
      await drafts.update(userIdOf(ctx), { sourceVideoFileId: fileId, sourceVideoDurationSec: safeDuration });
      await ctx.reply(`Видео принято полностью: ${safeDuration} сек.`);
      await showAvatarChoice(ctx);
    } else {
      await drafts.update(userIdOf(ctx), { sourceVideoFileId: fileId, sourceVideoDurationSec: safeDuration, stage: "topic" });
      await ctx.reply(`Видео принято полностью: ${safeDuration} сек. Шаг 2/3. Одним сообщением напишите, что именно должен объяснить или обозреть аватар в этом ролике.`);
    }
  };
  bot.on("message:video", (ctx) => acceptVideo(ctx, ctx.message.video.file_id, ctx.message.video.duration));
  bot.on("message:document", async (ctx) => {
    if (!ctx.message.document.mime_type?.startsWith("video/")) return void await ctx.reply("На этом шаге нужен исходный ролик MP4. Для создания аватара из фото сначала выберите эту кнопку.");
    await acceptVideo(ctx, ctx.message.document.file_id, undefined);
  });

  bot.callbackQuery("brief:avatar:generated", async (ctx) => {
    const draft = await drafts.update(userIdOf(ctx), { avatarMode: "generated", avatarId: undefined, avatarName: defaultAvatarLabel, stage: "confirm" });
    await ctx.answerCallbackQuery();
    if (draft) await ctx.reply(draftSummary(draft, defaultAvatarLabel), { reply_markup: briefKeyboard() });
  });
  bot.callbackQuery("brief:avatar:photo", async (ctx) => {
    await drafts.update(userIdOf(ctx), { avatarMode: "photo", stage: "avatar_image" });
    await ctx.answerCallbackQuery();
    await ctx.reply("Пришлите фронтальную фотографию человека. Отправляя её, вы подтверждаете право использовать это лицо. Аватар будет создан в HeyGen один раз и сохранён для следующих роликов.");
  });
  const showAvatarList = async (ctx: Context): Promise<void> => {
    if (!avatars) return void await ctx.reply("Сохранение аватаров доступно после подключения базы данных.");
    const profiles = await avatars.list(userIdOf(ctx));
    if (profiles.length === 0) return void await ctx.reply("Сохранённых аватаров пока нет. Выберите «Создать аватар из фото».");
    const keyboard = new InlineKeyboard();
    profiles.slice(0, 12).forEach((profile) => keyboard.text(profile.name, `brief:avatar:saved:${profile.id}`).row());
    await ctx.reply("Выберите сохранённый аватар:", { reply_markup: keyboard });
  };
  bot.command("avatars", showAvatarList);
  bot.callbackQuery("brief:avatar:list", async (ctx) => { await ctx.answerCallbackQuery(); await showAvatarList(ctx); });
  bot.callbackQuery(/^brief:avatar:saved:([\w-]+)$/, async (ctx) => {
    const profile = avatars ? await avatars.get(userIdOf(ctx), ctx.match[1]!) : undefined;
    await ctx.answerCallbackQuery();
    if (!profile) return void await ctx.reply("Аватар не найден. Выберите его ещё раз через /avatars.");
    const draft = await drafts.update(userIdOf(ctx), { avatarMode: "saved", avatarId: profile.heygenAvatarId, avatarName: profile.name, stage: "confirm" });
    if (draft) await ctx.reply(draftSummary(draft, defaultAvatarLabel), { reply_markup: briefKeyboard() });
  });
  bot.on("message:photo", async (ctx) => {
    const draft = await drafts.get(userIdOf(ctx));
    if (!draft || draft.stage !== "avatar_image") return void await ctx.reply("Фото можно прислать после /create → «Создать аватар из фото».");
    const photo = ctx.message.photo.at(-1)!;
    const updated = await drafts.update(userIdOf(ctx), { avatarImageFileId: photo.file_id, avatarName: `Аватар: ${(draft.topic ?? "ведущий").slice(0, 45)}`, stage: "confirm" });
    await ctx.reply(draftSummary(updated!, defaultAvatarLabel), { reply_markup: briefKeyboard() });
  });
  bot.callbackQuery("brief:confirm", async (ctx) => {
    const draft = await drafts.get(userIdOf(ctx)); await ctx.answerCallbackQuery();
    if (!draft || draft.stage !== "confirm") return;
    const job = await jobs.create(userIdOf(ctx), completedBrief(draft)); await drafts.delete(userIdOf(ctx)); queue.enqueue("produce", userIdOf(ctx), job.id);
    await ctx.reply(`«${jobTitle(job)}» добавлен в очередь.`, { reply_markup: jobKeyboard(job) });
  });
  bot.callbackQuery("brief:cancel", async (ctx) => { await drafts.delete(userIdOf(ctx)); await ctx.answerCallbackQuery(); await ctx.reply("Создание отменено."); });
  bot.on("message:text", async (ctx, next) => {
    const draft = await drafts.get(userIdOf(ctx)); if (!draft || ctx.message.text.startsWith("/")) return next();
    if (draft.stage === "topic") {
      const topic = ctx.message.text.trim(); if (topic.length < 3) return void await ctx.reply("Тема слишком короткая.");
      await drafts.update(userIdOf(ctx), { topic }); await showAvatarChoice(ctx);
    } else await next();
  });

  const picker = async (ctx: Context, action: JobAction): Promise<void> => {
    const available = (await jobs.list(userIdOf(ctx))).filter((job) => action === "preview" ? job.artifacts.some((a) => a.kind === "render") : action === "publish" ? job.status === "ready_for_approval" || job.publications.some((p) => p.status === "failed") : action === "retry" ? job.status === "failed" : action === "cancel" ? !["published", "cancelled"].includes(job.status) : true);
    if (!available.length) return void await ctx.reply("Подходящих роликов пока нет.");
    await ctx.reply("Выберите ролик:", { reply_markup: selectionKeyboard(available, action) });
  };
  const sendStatus = async (ctx: Context, id: string): Promise<void> => { const job = await jobs.get(userIdOf(ctx), id); await ctx.reply(formatJob(job), { reply_markup: jobKeyboard(job) }); };
  const sendPreview = async (ctx: Context, id: string): Promise<void> => { const job = await jobs.get(userIdOf(ctx), id); const artifact = job.artifacts.find((a) => a.kind === "render"); if (!artifact) return void await ctx.reply("Видео ещё не готово."); await ctx.replyWithVideo(new InputFile(await artifactStore.materialize(artifact.uri)), { caption: `«${jobTitle(job)}»` }); };
  const runAction = async (ctx: Context, action: JobAction, id: string): Promise<void> => { if (action === "status") return sendStatus(ctx, id); if (action === "preview") return sendPreview(ctx, id); if (action === "publish") { queue.enqueue("publish", userIdOf(ctx), id); return void await ctx.reply("Публикация добавлена в очередь."); } if (action === "retry") { await jobs.retryFailedProduction(userIdOf(ctx), id); queue.enqueue("produce", userIdOf(ctx), id); return void await ctx.reply("Повторное производство добавлено в очередь."); } await jobs.cancel(userIdOf(ctx), id); await ctx.reply("Задача отменена."); };
  for (const action of ["status", "preview", "publish", "retry", "cancel"] as const) bot.command(action, (ctx) => { const id = argumentOf(ctx.message?.text); return id ? runAction(ctx, action, id) : picker(ctx, action); });
  bot.callbackQuery(/^job:(status|preview|publish|retry|cancel):([\w-]+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await runAction(ctx, ctx.match[1] as JobAction, ctx.match[2]!); });
  bot.command("queue", async (ctx) => ctx.reply(formatQueue(await jobs.list(userIdOf(ctx)))));
  bot.command("connect_youtube", async (ctx) => { if (!youtube) return void await ctx.reply("YouTube OAuth не настроен."); await ctx.reply(`Откройте ссылку и подтвердите доступ:\n${youtube.createAuthorizationUrl(userIdOf(ctx))}`); });
  bot.command("health", async (ctx) => ctx.reply(`LLM: ${capabilities.scripts}\nМонтаж: ${capabilities.media}\nАватар: ${capabilities.avatar}\nХранилище: ${capabilities.storage}\nYouTube: ${capabilities.publishing}`));
  bot.command("settings", async (ctx) => ctx.reply(`Основной ведущий: ${defaultAvatarLabel}\nLLM: ${capabilities.scripts}\nМонтаж: ${capabilities.media}`));
  bot.on("message:text", async (ctx) => { if (ctx.message.text.startsWith("/")) await ctx.reply("Неизвестная команда. Откройте /help."); });
  queue.onCompleted(async (kind, userId, jobId) => { const job = await jobs.get(userId, jobId); if (kind !== "produce") return void await bot.api.sendMessage(userId, formatJob(job), { reply_markup: jobKeyboard(job) }); const render = job.artifacts.find((a) => a.kind === "render"); if (render && !render.uri.startsWith("mock://")) await bot.api.sendVideo(userId, new InputFile(await artifactStore.materialize(render.uri)), { caption: `«${jobTitle(job)}» готов.`, reply_markup: jobKeyboard(job) }); else await bot.api.sendMessage(userId, `«${jobTitle(job)}» готов.`, { reply_markup: jobKeyboard(job) }); });
  bot.catch((error) => void safeReply(error.ctx, error.error));
  return bot;
}
