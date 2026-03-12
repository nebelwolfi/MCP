import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { BOARDS_ROOT } from "./constants.js";

export const cwd = (): string => process.env.KANBAN_ROOT || process.cwd();

export function boardSlug(dir: string): string {
  return dir
    .toLowerCase()
    .split(/[:\\/]+/)
    .filter(Boolean)
    .join("-");
}

export const boardPath = (...parts: string[]): string =>
  join(homedir(), BOARDS_ROOT, boardSlug(cwd()), ...parts);

export const now = (): string => new Date().toISOString();

export function generateTaskId(): string {
  return createHash("sha256").update(randomUUID()).digest("hex").slice(0, 12);
}
