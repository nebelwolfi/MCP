import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import { gitSync, gitInDir, execSync, ghSync } from "./git.js";
import type { OrchestratorState } from "./types.js";

export function newRalphWorktree(state: OrchestratorState, workerId: number): string | null {
  const worktreePath = join(state.worktreeRoot, `worker-${workerId}`);
  const branchName = `ralph/worker-${workerId}`;

  // Remove stale worktree/branch
  if (existsSync(worktreePath)) {
    log(`Removing stale worktree for worker ${workerId}`, "WARN");
    gitSync(state.mainRepo, "worktree", "remove", worktreePath, "--force");
  }
  gitSync(state.mainRepo, "branch", "-D", branchName);

  // Create worktree
  const { exitCode } = gitSync(state.mainRepo, "worktree", "add", worktreePath, "-b", branchName, state.baseBranch);
  if (exitCode !== 0 || !existsSync(worktreePath)) {
    log(`Failed to create worktree for worker ${workerId} (branch ${state.baseBranch} may not exist)`, "ERROR");
    return null;
  }

  log(`Created worktree: ${worktreePath} (branch: ${branchName})`, "OK");
  return worktreePath;
}

export function initializeSubmodules(state: OrchestratorState, worktreePath: string): void {
  for (const sub of state.submodules) {
    const dest = join(worktreePath, sub);
    const src = join(state.mainRepo, sub);

    // Remove placeholder directory
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }

    // Ensure parent directory exists
    const parentDir = join(dest, "..");
    mkdirSync(parentDir, { recursive: true });

    // Clone from local repo (fast, uses hardlinks)
    log(`  Cloning submodule: ${sub}`);
    const { exitCode, stdout } = execSync("git", ["clone", "--local", src, dest]);
    if (exitCode !== 0) {
      log(`  Failed to clone ${sub}: ${stdout}`, "ERROR");
      throw new Error(`Submodule clone failed: ${sub}`);
    }

    // Copy real remote URL so pushes go to GitHub
    const { stdout: realRemote } = gitInDir(src, "remote", "get-url", "origin");
    if (realRemote && realRemote !== src) {
      gitInDir(dest, "remote", "set-url", "origin", realRemote);
    }
  }

  log(`Submodules initialized for ${worktreePath}`, "OK");
}

export function patchClaudeMD(state: OrchestratorState, worktreePath: string): void {
  const claudeMdPath = join(worktreePath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    log("No CLAUDE.md found in worktree, skipping patch", "WARN");
    return;
  }

  let content = readFileSync(claudeMdPath, "utf-8");
  const mainRepo = state.mainRepo;

  // Replace main repo paths with worktree path (don't replace .ralph or .kanbn refs)
  const escaped = mainRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forwardPattern = new RegExp(`${escaped}(?![/\\\\]\\.|[/\\\\]ralph)`, "g");
  content = content.replace(forwardPattern, worktreePath);

  // Handle backslash variant
  const backslashMain = mainRepo.replace(/\//g, "\\");
  const escapedBackslash = backslashMain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backslashPattern = new RegExp(`${escapedBackslash}(?![/\\\\]\\.|[/\\\\]ralph)`, "g");
  content = content.replace(backslashPattern, worktreePath.replace(/\//g, "\\"));

  writeFileSync(claudeMdPath, content, "utf-8");
  log("  Patched CLAUDE.md paths");
}

export function configureWorktreeBuild(state: OrchestratorState, worktreePath: string): boolean {
  if (!existsSync(join(worktreePath, "CMakeLists.txt"))) {
    log("  No CMakeLists.txt found, skipping cmake configure");
    return true;
  }

  const buildDir = join(worktreePath, "cmake-build-debug");
  const cmakeDefines: string[] = [];

  // Read cmake cache variables and remap paths
  const mainBuildCache = join(state.mainRepo, "cmake-build-debug", "CMakeCache.txt");
  if (existsSync(mainBuildCache)) {
    const cacheContent = readFileSync(mainBuildCache, "utf-8");
    const escaped = state.mainRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mainPattern = new RegExp(escaped);

    for (const line of cacheContent.split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):([A-Z]+)=(.+)$/);
      if (m && mainPattern.test(m[3])) {
        const remapped = m[3].replace(new RegExp(escaped, "g"), worktreePath);
        cmakeDefines.push(`-D${m[1]}:${m[2]}=${remapped}`);
      }
    }
  }

  log("  Configuring cmake build...");
  const { exitCode, stdout } = execSync("cmake", [
    "-DCMAKE_BUILD_TYPE=Debug",
    "-DCMAKE_MAKE_PROGRAM=ninja",
    "-DCMAKE_C_COMPILER=clang",
    "-DCMAKE_CXX_COMPILER=clang++",
    ...cmakeDefines,
    "-G", "Ninja",
    "-S", worktreePath,
    "-B", buildDir,
  ]);

  if (exitCode !== 0) {
    log(`cmake configure failed for ${worktreePath}`, "ERROR");
    const lastLines = stdout.split("\n").slice(-3).join("\n");
    log(`  ${lastLines}`, "ERROR");
    return false;
  }

  log("  cmake configured successfully", "OK");
  return true;
}

export function removeRalphWorktree(state: OrchestratorState, workerId: number): void {
  const worktreePath = join(state.worktreeRoot, `worker-${workerId}`);
  if (existsSync(worktreePath)) {
    log(`Removing worktree for worker ${workerId}`);
    gitSync(state.mainRepo, "worktree", "remove", worktreePath, "--force");
  }
}

export function newMergeWorktree(state: OrchestratorState): string | null {
  const worktreePath = join(state.worktreeRoot, "merge-worker");
  const branchName = "ralph/merge-worker";

  if (existsSync(worktreePath)) {
    gitSync(state.mainRepo, "worktree", "remove", worktreePath, "--force");
  }
  gitSync(state.mainRepo, "branch", "-D", branchName);

  const { exitCode } = gitSync(state.mainRepo, "worktree", "add", worktreePath, "-b", branchName, state.baseBranch);
  if (exitCode !== 0 || !existsSync(worktreePath)) {
    log("Failed to create merge worktree", "ERROR");
    return null;
  }

  log(`Created merge worktree: ${worktreePath}`, "OK");
  return worktreePath;
}

export function removeMergeWorktree(state: OrchestratorState): void {
  const worktreePath = join(state.worktreeRoot, "merge-worker");
  if (existsSync(worktreePath)) {
    log("Removing merge worktree");
    gitSync(state.mainRepo, "worktree", "remove", worktreePath, "--force");
  }
  gitSync(state.mainRepo, "branch", "-D", "ralph/merge-worker");
}

export function removeAllWorktrees(state: OrchestratorState): void {
  log("Cleaning up all ralph worktrees...");

  const { stdout: worktreeList } = gitSync(state.mainRepo, "worktree", "list", "--porcelain");
  if (worktreeList) {
    for (const line of worktreeList.split("\n")) {
      const match = line.match(/^worktree (.+ralph-worktrees.+)/);
      if (match) {
        log(`  Removing worktree: ${match[1]}`);
        gitSync(state.mainRepo, "worktree", "remove", match[1], "--force");
      }
    }
  }

  // Delete ralph branches
  const { stdout: branches } = gitSync(state.mainRepo, "branch", "--list", "ralph/*");
  if (branches) {
    for (const line of branches.split("\n")) {
      const branch = line.trim().replace(/^\* /, "");
      if (branch) gitSync(state.mainRepo, "branch", "-D", branch);
    }
  }

  if (existsSync(state.worktreeRoot)) {
    rmSync(state.worktreeRoot, { recursive: true, force: true });
  }

  gitSync(state.mainRepo, "worktree", "prune");
  log("Cleanup complete", "OK");
}

export function switchWorktreeToTaskBranch(worktreePath: string, taskId: string, baseBranch: string): void {
  // Save uncommitted work
  const { stdout: dirty } = gitInDir(worktreePath, "status", "--porcelain");
  if (dirty) {
    gitInDir(worktreePath, "add", "-A");
    gitInDir(worktreePath, "commit", "-m", "WIP: auto-save uncommitted work before task switch");
  }

  // Commit submodule changes
  gitInDir(worktreePath, "submodule", "foreach", "--recursive",
    "git add -A && git diff --cached --quiet || git commit -m \"WIP: auto-save\"");
  gitInDir(worktreePath, "add", "-A");
  const { exitCode: cachedDiffExit } = gitInDir(worktreePath, "diff", "--cached", "--quiet");
  if (cachedDiffExit !== 0) {
    gitInDir(worktreePath, "commit", "-m", "WIP: auto-save submodule refs before task switch");
  }

  const taskBranch = `ralph/${taskId}`;
  gitInDir(worktreePath, "fetch", "origin", baseBranch, taskBranch);

  // Unmark assume-unchanged on .kanbn files
  const { stdout: kanbnFiles } = gitInDir(worktreePath, "ls-files", ".kanbn");
  if (kanbnFiles) {
    for (const f of kanbnFiles.split("\n").filter(Boolean)) {
      gitInDir(worktreePath, "update-index", "--no-assume-unchanged", f);
    }
  }
  gitInDir(worktreePath, "checkout", "--", ".kanbn");

  // Check if local branch exists
  const { exitCode: localExists } = gitInDir(worktreePath, "rev-parse", "--verify", taskBranch);
  if (localExists === 0) {
    const { exitCode, stdout } = gitInDir(worktreePath, "checkout", taskBranch);
    if (exitCode !== 0) {
      log(`  Failed to checkout ${taskBranch}: ${stdout}`, "ERROR");
      return;
    }
  } else {
    // Check if remote branch exists
    const { exitCode: remoteExists } = gitInDir(worktreePath, "rev-parse", "--verify", `origin/${taskBranch}`);
    if (remoteExists === 0) {
      const { exitCode, stdout } = gitInDir(worktreePath, "checkout", "-b", taskBranch, `origin/${taskBranch}`);
      if (exitCode !== 0) {
        log(`  Failed to checkout remote ${taskBranch}: ${stdout}`, "ERROR");
        return;
      }
      log(`  Checked out existing remote branch: ${taskBranch}`);
    } else {
      const { exitCode, stdout } = gitInDir(worktreePath, "checkout", "-b", taskBranch, `origin/${baseBranch}`);
      if (exitCode !== 0) {
        log(`  Failed to create ${taskBranch}: ${stdout}`, "ERROR");
        return;
      }
    }
  }
}

export function syncKanbnToWorktree(mainRepo: string, worktreePath: string): void {
  const src = join(mainRepo, ".kanbn");
  const dst = join(worktreePath, ".kanbn");

  if (existsSync(src)) {
    if (existsSync(dst)) {
      rmSync(dst, { recursive: true, force: true });
    }
    cpSync(src, dst, { recursive: true });

    // Mark kanbn files as assume-unchanged
    const { stdout: kanbnFiles } = gitInDir(worktreePath, "ls-files", ".kanbn");
    if (kanbnFiles) {
      for (const f of kanbnFiles.split("\n").filter(Boolean)) {
        gitInDir(worktreePath, "update-index", "--assume-unchanged", f);
      }
    }
  }
}

export function ensureUnionMergeForProgressTxt(state: OrchestratorState): void {
  const gitattributes = join(state.mainRepo, ".gitattributes");
  const unionRule = "progress.txt merge=union";
  let needsCommit = false;

  if (existsSync(gitattributes)) {
    const content = readFileSync(gitattributes, "utf-8");
    if (!/progress\.txt\s+merge=union/.test(content)) {
      writeFileSync(gitattributes, content + "\n" + unionRule, "utf-8");
      needsCommit = true;
    }
  } else {
    writeFileSync(gitattributes, unionRule, "utf-8");
    needsCommit = true;
  }

  if (needsCommit) {
    gitSync(state.mainRepo, "add", ".gitattributes");
    gitSync(state.mainRepo, "commit", "-m", "chore: add union merge strategy for progress.txt");
    gitSync(state.mainRepo, "push", "origin", state.baseBranch);
    log("Added .gitattributes with union merge for progress.txt", "OK");
  }
}

export function stopAllWorkerProcesses(worktreeRoot: string): void {
  // Use tree-kill for any tracked child processes (handled by orchestrator)
  // This is a fallback for orphaned processes
  if (process.platform === "win32") {
    // On Windows, use tasklist + grep for worktree pattern
    try {
      const { stdout } = execSync("tasklist", ["/V", "/FO", "CSV"]);
      // Best-effort: the orchestrator tracks PIDs directly
    } catch { /* best effort */ }
  }
  // On Unix, tracked child processes are killed via tree-kill in the orchestrator
}

export function pruneMergedRalphBranches(state: OrchestratorState): void {
  gitSync(state.mainRepo, "fetch", "origin", "--prune");

  let pruned = 0;
  const { stdout: remoteBranches } = gitSync(state.mainRepo, "ls-remote", "--heads", "origin", "ralph/*");
  if (!remoteBranches) return;

  for (const line of remoteBranches.split("\n")) {
    const m = line.match(/refs\/heads\/(ralph\/.+)$/);
    if (!m) continue;
    const remoteBranch = m[1];
    if (/^ralph\/worker-\d+$/.test(remoteBranch)) continue;

    const taskId = remoteBranch.replace(/^ralph\//, "");
    if (state.claimedTasks.has(taskId)) continue;

    // Check 1: git cherry - all commits already in base by patch content
    const { stdout: unmerged } = gitSync(state.mainRepo, "cherry", `origin/${state.baseBranch}`, `origin/${remoteBranch}`);
    const hasUnmerged = unmerged ? unmerged.split("\n").some((l) => l.startsWith("+")) : false;

    // Check 2: if cherry says unmerged, check PR state as fallback
    let prState: string | null = null;
    if (hasUnmerged) {
      const { stdout: ps } = ghSync("pr", "view", remoteBranch, "--json", "state", "--jq", ".state");
      prState = ps;
    }

    if (!hasUnmerged || prState?.toUpperCase() === "MERGED") {
      const { exitCode } = gitSync(state.mainRepo, "push", "origin", "--delete", remoteBranch);
      if (exitCode === 0) {
        const reason = !hasUnmerged ? "cherry-clean" : "PR merged";
        log(`  Pruned remote branch: ${remoteBranch} (${reason})`, "OK");
        pruned++;
      }
    }
  }

  if (pruned > 0) {
    log(`Pruned ${pruned} merged ralph branch(es)`, "OK");
  }
}
