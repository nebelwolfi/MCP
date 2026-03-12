import type { Config } from "./types.js";

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function parseArgs(argv: string[]): Config {
  const args = argv.slice(2);

  if (hasFlag(args, "help") || hasFlag(args, "h")) {
    console.log(`ralph — parallel Claude worker orchestrator

Usage: ralph [options]

Options:
  --workers N                Number of parallel workers (default: 3)
  --iterations-per-worker N  Max iterations per worker (default: 10)
  --skip-build               Skip cmake configure step
  --cleanup                  Clean up worktrees and exit
  --merge-only               Only drain pending PRs, no task work
  --base-branch NAME         Base branch (default: auto-detect)
  --project-dir PATH         Project directory (default: cwd)`);
    process.exit(0);
  }

  return {
    workers: parseInt(flag(args, "workers") ?? "3", 10),
    iterationsPerWorker: parseInt(flag(args, "iterations-per-worker") ?? "10", 10),
    skipBuild: hasFlag(args, "skip-build"),
    cleanup: hasFlag(args, "cleanup"),
    mergeOnly: hasFlag(args, "merge-only"),
    baseBranch: flag(args, "base-branch") ?? "",
    projectDir: flag(args, "project-dir") ?? process.cwd(),
  };
}
