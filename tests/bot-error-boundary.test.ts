import { describe, expect, it, vi } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { createContainer } from "../src/container.js";
import { LocalArtifactStore } from "../src/infrastructure/artifact-store.js";
import { createBot } from "../src/presentation/bot.js";

const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
  supports_guest_queries: false,
};

function messageUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      from: { id: 99, is_bot: false, first_name: "Tester" },
      chat: { id: 99, type: "private", first_name: "Tester" },
      text,
      entities: text.startsWith("/") ? [{ offset: 0, length: text.split(" ")[0]!.length, type: "bot_command" }] : undefined,
    },
  } as Update;
}

describe("Telegram webhook error boundary", () => {
  it("keeps processing commands after an invalid task ID", async () => {
    const { jobService, queue } = createContainer();
    const bot = createBot("123456789:test-token", jobService, queue, {
      storage: "test",
      scripts: "test",
      media: "test",
      avatar: "placeholder",
      publishing: "disabled",
    }, new LocalArtifactStore());
    bot.botInfo = botInfo;
    const apiCalls: Array<{ method: string; payload: unknown }> = [];
    bot.api.config.use(async (_previous, method, payload) => {
      apiCalls.push({ method, payload });
      return { ok: true, result: {} } as never;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(bot.handleUpdate(messageUpdate(1, "/preview abc123"))).resolves.toBeUndefined();
    expect(apiCalls.some(({ method, payload }) => method === "sendMessage"
      && String((payload as { text?: string }).text).includes("Задача abc123 не найдена"))).toBe(true);

    await expect(bot.handleUpdate(messageUpdate(2, "/create"))).resolves.toBeUndefined();
    expect(apiCalls.some(({ method, payload }) => method === "sendMessage"
      && String((payload as { text?: string }).text).includes("Шаг 1/9"))).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("explains the command syntax instead of silently ignoring an underscore", async () => {
    const { jobService, queue } = createContainer();
    const bot = createBot("123456789:test-token", jobService, queue, {
      storage: "test",
      scripts: "test",
      media: "test",
      avatar: "placeholder",
      publishing: "disabled",
    }, new LocalArtifactStore());
    bot.botInfo = botInfo;
    const apiCalls: Array<{ method: string; payload: unknown }> = [];
    bot.api.config.use(async (_previous, method, payload) => {
      apiCalls.push({ method, payload });
      return { ok: true, result: {} } as never;
    });

    await bot.handleUpdate(messageUpdate(3, "/preview_abc123"));

    expect(apiCalls.some(({ method, payload }) => method === "sendMessage"
      && String((payload as { text?: string }).text).includes("/preview abc123"))).toBe(true);
  });
});
