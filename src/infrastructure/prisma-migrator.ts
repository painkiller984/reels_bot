import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export async function deployPrismaMigrations(databaseUrl?: string): Promise<void> {
  if (!databaseUrl) {
    return;
  }

  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 10 * 1024 * 1024,
  });
}
