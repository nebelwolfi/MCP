import { execFile, execFileSync } from "node:child_process";
import { log } from "./logger.js";

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/** Run git with -C repoPath and return { stdout, exitCode }. Never throws. */
export function gitSync(repoPath: string, ...args: string[]): ExecResult {
  try {
    const stdout = execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? "").trimEnd(), exitCode: e.status ?? 1 };
  }
}

/** Run git in a given directory (using cwd, not -C). */
export function gitInDir(cwd: string, ...args: string[]): ExecResult {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? "").trimEnd(), exitCode: e.status ?? 1 };
  }
}

/** Run gh CLI and return { stdout, exitCode }. Never throws. */
export function ghSync(...args: string[]): ExecResult {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? "").trimEnd(), exitCode: e.status ?? 1 };
  }
}

/** Run gh CLI from a specific directory. */
export function ghInDir(cwd: string, ...args: string[]): ExecResult {
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf-8",
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? "").trimEnd(), exitCode: e.status ?? 1 };
  }
}

/** Run an arbitrary command. */
export function execSync(cmd: string, args: string[], options?: { cwd?: string }): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf-8",
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: (e.stdout ?? "").trimEnd(), exitCode: e.status ?? 1 };
  }
}

/** Check if .kanbn path */
export function isKanbnPath(relativePath: string): boolean {
  if (!relativePath) return false;
  const normalized = relativePath.replace(/\\/g, "/").trim();
  return normalized === ".kanbn" || normalized.startsWith(".kanbn/");
}

/** Check if a range has non-.kanbn changes */
export function hasNonKanbnChangesInRange(repoPath: string, rangeSpec: string): boolean {
  const { stdout } = gitSync(repoPath, "diff", "--name-only", rangeSpec);
  if (!stdout) return false;
  return stdout.split("\n").some((f) => !isKanbnPath(f));
}

/** Check for conflict markers in committed or working tree files */
export function hasConflictMarkers(repoPath: string): boolean {
  // Check HEAD
  const { exitCode: e1, stdout: s1 } = gitInDir(repoPath, "grep", "--recurse-submodules", "-l", "-E", "^<{7} |^={7}$|^>{7} ", "HEAD", "--");
  if (e1 === 0 && s1) return true;

  // Check working tree
  const { exitCode: e2, stdout: s2 } = gitInDir(repoPath, "grep", "--recurse-submodules", "-l", "-E", "^<{7} |^={7}$|^>{7} ", "--");
  return e2 === 0 && !!s2;
}

/** Discover submodule paths from .gitmodules */
export function discoverSubmodules(repoPath: string): string[] {
  const { stdout, exitCode } = gitSync(repoPath, "config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$");
  if (exitCode !== 0 || !stdout) return [];
  return stdout.split("\n").map((line) => line.split(" ", 2)[1]).filter(Boolean);
}

/** Auto-detect the current branch */
export function detectBaseBranch(repoPath: string): string {
  const { stdout } = gitSync(repoPath, "symbolic-ref", "--short", "HEAD");
  return stdout || "main";
}

/** Get the repo root from a project directory */
export function getRepoRoot(projectDir: string): string {
  const { stdout } = gitSync(projectDir, "rev-parse", "--show-toplevel");
  return stdout.replace(/\\/g, "/");
}

/** Check if a command exists on PATH */
export function commandExists(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}
