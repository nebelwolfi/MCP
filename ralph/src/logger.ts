import type { LogLevel } from "./types.js";

const COLORS: Record<LogLevel, string> = {
  INFO: "\x1b[36m",   // cyan
  ERROR: "\x1b[31m",  // red
  WARN: "\x1b[33m",   // yellow
  OK: "\x1b[32m",     // green
};

const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

export function log(message: string, level: LogLevel = "INFO"): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const timestamp = `${hh}:${mm}:${ss}`;
  const color = COLORS[level] ?? COLORS.INFO;
  process.stdout.write(`${DIM}[${timestamp}] ${RESET}${color}${message}${RESET}\n`);
}
