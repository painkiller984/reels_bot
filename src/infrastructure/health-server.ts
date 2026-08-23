import { createServer, type RequestListener, type Server } from "node:http";

export class HealthServer {
  private server: Server | undefined;

  constructor(
    private readonly port: number,
    private readonly telegramWebhook?: RequestListener,
    private readonly youtubeCallback?: RequestListener,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      if (request.url === "/health" || request.url === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", service: "reels-bot" }));
      } else if (request.url === "/telegram" && request.method === "POST" && this.telegramWebhook) {
        this.telegramWebhook(request, response);
      } else if (request.url?.startsWith("/oauth/youtube/callback") && request.method === "GET" && this.youtubeCallback) {
        this.youtubeCallback(request, response);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "0.0.0.0", resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
  }
}
