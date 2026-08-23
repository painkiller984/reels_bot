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

export function formatJob(job: ContentJob): string {
  const lines = [
    `Ролик #${job.id}`,
    `Тема: ${job.brief.topic}`,
    `Статус: ${statusLabels[job.status]}`,
    `Платформы: ${job.brief.platforms.join(", ")}`,
  ];

  if (job.script) {
    lines.push("", `Хук: ${job.script.hook}`);
  }
  if (job.publications.some((item) => item.url)) {
    lines.push("", "Публикации:");
    for (const item of job.publications) {
      lines.push(`• ${item.platform}: ${item.url ?? item.error ?? item.status}`);
    }
  }
  if (job.error) lines.push("", `Ошибка: ${job.error}`);
  return lines.join("\n");
}

export function formatQueue(jobs: ContentJob[]): string {
  if (jobs.length === 0) return "Очередь пуста. Создайте ролик командой /create тема";
  return jobs.slice(0, 10).map((job) => `#${job.id} · ${statusLabels[job.status]} · ${job.brief.topic}`).join("\n");
}
