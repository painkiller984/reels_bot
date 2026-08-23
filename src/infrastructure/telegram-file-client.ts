import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class TelegramFileClient {
  constructor(private readonly token: string) {}

  async download(fileId: string, destination: string): Promise<string> {
    const { response } = await this.fetchFile(fileId, 30_000);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  }

  async dataUrl(fileId: string, timeoutMs = 10_000): Promise<string> {
    const { response, filePath } = await this.fetchFile(fileId, timeoutMs);
    const contentType = response.headers.get("content-type")
      ?? (filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
    return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  }

  private async fetchFile(fileId: string, timeoutMs: number): Promise<{ response: Response; filePath: string }> {
    const metadata = await fetch(`https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await metadata.json() as { ok: boolean; result?: { file_path?: string }; description?: string };
    const filePath = body.result?.file_path;
    if (!metadata.ok || !body.ok || !filePath) throw new Error(`Telegram file download failed: ${body.description ?? metadata.status}`);
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return { response, filePath };
  }
}
