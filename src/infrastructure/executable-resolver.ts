import { existsSync, readdirSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function resolveExecutable(configured: string, executableName: string): string {
  if (configured !== executableName || process.platform !== "win32") return configured;

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, `${executableName}.exe`);
    if (existsSync(candidate)) return candidate;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return configured;
  const packages = resolve(localAppData, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packages)) return configured;
  try {
    const match = readdirSync(packages, { recursive: true, withFileTypes: true })
      .find((entry) => entry.isFile() && entry.name.toLowerCase() === `${executableName}.exe`);
    return match ? resolve(match.parentPath, match.name) : configured;
  } catch {
    return configured;
  }
}
