import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { google, type Auth } from "googleapis";

type StoredTokens = Record<string, Auth.Credentials>;

export interface YoutubeAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenFile: string;
  port: number;
}

export class YoutubeAuthService {
  private readonly pending = new Map<string, { userId: string; expiresAt: number }>();
  private server: Server | undefined;

  constructor(private readonly options: YoutubeAuthOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handleCallback(request.url, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port, "127.0.0.1", resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
  }

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
    const tokens = (await this.readTokens())[userId];
    if (!tokens?.refresh_token) throw new Error("YouTube не подключён. Выполните /connect_youtube в боте.");
    const client = this.client();
    client.setCredentials(tokens);
    client.on("tokens", async (updated: Auth.Credentials) => {
      const all = await this.readTokens();
      all[userId] = { ...all[userId], ...updated };
      await this.writeTokens(all);
    });
    return client;
  }

  async isConnected(userId: string): Promise<boolean> {
    return Boolean((await this.readTokens())[userId]?.refresh_token);
  }

  private client(): Auth.OAuth2Client {
    return new google.auth.OAuth2(this.options.clientId, this.options.clientSecret, this.options.redirectUri);
  }

  private async handleCallback(requestUrl: string | undefined, response: import("node:http").ServerResponse): Promise<void> {
    const url = new URL(requestUrl ?? "/", `http://127.0.0.1:${this.options.port}`);
    if (url.pathname !== "/oauth/youtube/callback") { response.writeHead(404).end("Not found"); return; }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const pending = state ? this.pending.get(state) : undefined;
    if (!pending || pending.expiresAt < Date.now() || !code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h2>Авторизация не выполнена. Вернитесь в Telegram и запустите /connect_youtube заново.</h2>");
      return;
    }
    try {
      const { tokens } = await this.client().getToken(code);
      const all = await this.readTokens();
      all[pending.userId] = { ...all[pending.userId], ...tokens };
      await this.writeTokens(all);
      this.pending.delete(state!);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h2>YouTube успешно подключён.</h2><p>Вернитесь в Telegram и создайте ролик.</p>");
    } catch {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end("<h2>Не удалось завершить авторизацию.</h2>");
    }
  }

  private async readTokens(): Promise<StoredTokens> {
    try { return JSON.parse(await readFile(this.options.tokenFile, "utf8")) as StoredTokens; } catch { return {}; }
  }
  private async writeTokens(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.options.tokenFile), { recursive: true });
    await writeFile(this.options.tokenFile, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
