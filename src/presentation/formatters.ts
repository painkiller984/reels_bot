import type { ContentJob, JobStatus } from "../domain/job.js";

export const statusLabels: Record<JobStatus, string> = {
  draft: "Черновик",
  brief_ready: "Бриф принят",
  script_generating: "Генерация сценария",
  script_review: "Проверка сценария",
  audio_generating: "Озвучка",
  avatar_generating: "Генерация аватара",
  rendering: "Монтаж",
  quality_check: "Проверка качества",
  ready_for_approval: "Готов к подтверждению",
  publishing: "Публикация",
  published: "Опубликован",
  needs_user_input: "Нужны данные",
  failed: "Ошибка",
  cancelled: "Отменён",
};

export function jobTitle(job: ContentJob): string {
  const title = job.brief.topic
    .replace(/\s+/gu, " ")
    .replace(/^[\s.,:;!?—–-]+|[\s.,:;!?—–-]+$/gu, "")
    .trim();
  return title.length > 52 ? `${title.slice(0, 49).trimEnd()}…` : title || "Без названия";
}

export function formatJob(job: ContentJob): string {
  const lines = [
    `Ролик: ${jobTitle(job)}`,
    `Статус: ${statusLabels[job.status]}`,
    `Платформы: ${job.brief.platforms.join(", ")}`,
  ];

  if (job.script) {
    lines.push("", `Хук: ${job.script.hook}`);
    if (job.brief.sourceVideoFileId) {
      lines.push("Формат: исходное видео + Avatar IV + центральные субтитры");
    } else if (job.script.montagePlan) {
      lines.push(`Монтаж: AI Director · ${job.script.montagePlan.scenes.length} сцен · стиль ${job.script.montagePlan.style}`);
      lines.push(`Дополнительные AI-кадры: ${job.script.montagePlan.generatedVisuals.length}`);
    }
  }
  if (job.status === "avatar_generating") {
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - job.updatedAt.getTime()) / 60_000));
    lines.push(`HeyGen Avatar IV: обработка на стороне HeyGen${elapsedMinutes > 0 ? ` · ${elapsedMinutes} мин` : ""}. Для длинных роликов это может занять несколько минут.`);
  }
  if (job.artifacts.some((artifact) => artifact.kind === "quality_report")) {
    lines.push("Проверка качества: пройдена");
  }
  if (job.publications.some((item) => item.status !== "pending")) {
    lines.push("", "Публикации:");
    for (const item of job.publications) {
      lines.push(`• ${item.platform}: ${item.url ?? item.error ?? item.status}`);
      if (item.metrics) lines.push(`  Просмотры: ${item.metrics.views} · лайки: ${item.metrics.likes} · комментарии: ${item.metrics.comments}`);
    }
  }
  if (job.error) lines.push("", `Ошибка: ${job.error}`);
  return lines.join("\n");
}

export function formatQueue(jobs: ContentJob[]): string {
  if (jobs.length === 0) return "Очередь пуста. Создайте ролик командой /create тема";
  return jobs.slice(0, 10).map((job, index) => `${index + 1}. ${jobTitle(job)} · ${statusLabels[job.status]}`).join("\n");
}
