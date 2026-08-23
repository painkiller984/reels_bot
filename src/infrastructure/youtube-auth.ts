import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { google, type Auth } from "googleapis";
import type { YoutubeTokenStore } from "./youtube-token-store.js";

export interface YoutubeAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStore: YoutubeTokenStore;
}

export class YoutubeAuthService {
  private readonly pending = new Map<string, { userId: string; expiresAt: number }>();
  constructor(private readonly options: YoutubeAuthOptions) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  createAuthorizationUrl(userId: string): string {
    const state = randomUUID();
    this.pending.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000 });
    return this.client().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/youtube.upload"],
      state,
    });
  }

  async getAuthorizedClient(userId: string): Promise<Auth.OAuth2Client> {
    const tokens = await this.options.tokenStore.get(userId);
    if (!tokens?.refresh_token) throw new Error("YouTube не подключён. Выполните /connect_youtube в боте.");
    const client = this.client();
    client.setCredentials(tokens);
    client.on("tokens", async (updated: Auth.Credentials) => {
      await this.options.tokenStore.set(userId, updated);
    });
    return client;
  }

  async isConnected(userId: string): Promise<boolean> {
    return Boolean((await this.options.tokenStore.get(userId))?.refresh_token);
  }

  private client(): Auth.OAuth2Client {
    return new google.auth.OAuth2(this.options.clientId, this.options.clientSecret, this.options.redirectUri);
  }

  async handleCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.options.redirectUri);
    if (url.pathname !== "/oauth/youtube/callback") { response.writeHead(404).end("Not found"); return; }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const pending = state ? this.pending.get(state) : undefined;
    if (!pending || pending.expiresAt < Date.now() || !code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h2>Авторизация не выполнена. Вернитесь в Telegram и запустите /connect_youtube заново.</h2>");
      return;
    }
    let stage: "token_exchange" | "token_storage" = "token_exchange";
    try {
      const { tokens } = await this.client().getToken(code);
      stage = "token_storage";
      await this.options.tokenStore.set(pending.userId, tokens);
      this.pending.delete(state!);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h2>YouTube успешно подключён.</h2><p>Вернитесь в Telegram и создайте ролик.</p>");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "youtube_oauth_callback_failed", stage, message }));
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end("<h2>Не удалось завершить авторизацию.</h2>");
    }
  }

}
