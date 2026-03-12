import { join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "./logger.js";
import { gitSync, gitInDir, ghSync, ghInDir, hasNonKanbnChangesInRange, isKanbnPath, hasConflictMarkers } from "./git.js";
import { spawnMergeReviewWorker } from "./worker.js";
import { getBoardJson, getColumnIndex } from "./kanban.js";
import type { OrchestratorState, PullRequest, WorkerResult } from "./types.js";

/** Push worker results to remote (or validate locally in --local mode). Returns true on success. */
export function publishWorkerResults(
  state: OrchestratorState,
  worktreePath: string,
  workerId: number,
  taskId: string,
): boolean {
  const taskBranch = `ralph/${taskId}`;
  const local = state.local;
  let success = true;

  // 1. Push submodule changes (skip pushes in local mode)
  for (const sub of state.submodules) {
    const subPath = join(worktreePath, sub);
    if (!existsSync(join(subPath, ".git"))) continue;

    const baseRef = local ? state.baseBranch : `origin/${state.baseBranch}`;
    const { stdout: hasCommits } = gitInDir(subPath, "log", "--oneline", `${baseRef}..HEAD`);
    if (!hasCommits) {
      if (local) continue;
      const { stdout: hasMainCommits } = gitInDir(subPath, "log", "--oneline", "origin/main..HEAD");
      if (!hasMainCommits) continue;
    }

    if (!local) {
      gitInDir(subPath, "fetch", "origin", state.baseBranch);
      const { exitCode: rebaseExit, stdout: rebaseOut } = gitInDir(subPath, "rebase", `origin/${state.baseBranch}`);
      if (rebaseExit !== 0) {
        log(`  Worker ${workerId} sub ${sub} rebase failed: ${rebaseOut}`, "WARN");
        gitInDir(subPath, "rebase", "--abort");
        success = false;
        continue;
      }

      const { exitCode: pushExit, stdout: pushOut } = gitInDir(subPath, "push", "origin", `HEAD:${state.baseBranch}`);
      if (pushExit !== 0) {
        log(`  Worker ${workerId} sub ${sub} push failed: ${pushOut}`, "ERROR");
        success = false;
      }
    }
  }

  if (!success) return false;

  // 2. Validate: no conflict markers
  if (hasConflictMarkers(worktreePath)) {
    log(`Worker ${workerId} BLOCKED: conflict markers detected in task branch`, "ERROR");
    return false;
  }

  // 3. Strip .kanbn changes
  const baseRef = local ? state.baseBranch : `origin/${state.baseBranch}`;
  if (!local) {
    gitInDir(worktreePath, "fetch", "origin", state.baseBranch);
  }
  const { stdout: changedFiles } = gitInDir(worktreePath, "diff", "--name-only", `${baseRef}..HEAD`);
  let hasKanbnChanges = false;
  if (changedFiles) {
    hasKanbnChanges = changedFiles.split("\n").some((f) => isKanbnPath(f));
  }

  if (hasKanbnChanges) {
    log(`  Worker ${workerId} stripping .kanbn changes from task branch`, "WARN");
    gitInDir(worktreePath, "checkout", baseRef, "--", ".kanbn");
    gitInDir(worktreePath, "add", ".kanbn");
    const { exitCode: cachedExit } = gitInDir(worktreePath, "diff", "--cached", "--quiet");
    if (cachedExit !== 0) {
      gitInDir(worktreePath, "commit", "-m", "chore: remove .kanbn edits from worker branch");
    }
  }

  if (local) {
    log(`Worker ${workerId} validated ${taskBranch} (local mode)`, "OK");
    return true;
  }

  // 4. Push task branch
  const { exitCode: pushExit, stdout: pushOut } = gitInDir(worktreePath, "push", "origin", `${taskBranch}:${taskBranch}`, "--force");
  if (pushExit !== 0) {
    log(`Worker ${workerId} failed to push ${taskBranch}: ${pushOut}`, "ERROR");
    return false;
  }

  log(`Worker ${workerId} pushed ${taskBranch}`, "OK");
  return true;
}

/** Merge a task branch into the base branch locally (used in --local mode). */
export function mergeTaskLocally(state: OrchestratorState, taskId: string): void {
  const taskBranch = `ralph/${taskId}`;

  // Check the branch exists
  const { exitCode: branchExists } = gitSync(state.mainRepo, "rev-parse", "--verify", taskBranch);
  if (branchExists !== 0) {
    log(`  Local merge skip ${taskId}: branch does not exist`, "WARN");
    return;
  }

  // Check for actual changes vs base
  const { stdout: cherry } = gitSync(state.mainRepo, "cherry", state.baseBranch, taskBranch);
  if (!cherry || !cherry.split("\n").some((l) => l.startsWith("+"))) {
    log(`  Local merge skip ${taskId}: no changes vs ${state.baseBranch}`, "WARN");
    return;
  }

  // Save current branch
  const { stdout: currentBranch } = gitSync(state.mainRepo, "rev-parse", "--abbrev-ref", "HEAD");

  gitSync(state.mainRepo, "checkout", state.baseBranch);
  const { exitCode: mergeExit, stdout: mergeOut } = gitSync(state.mainRepo, "merge", "--no-ff", taskBranch, "-m", `ralph: merge ${taskId}`);

  if (mergeExit === 0) {
    log(`Merged ${taskBranch} into ${state.baseBranch} locally`, "OK");
    gitSync(state.mainRepo, "branch", "-D", taskBranch);
  } else {
    log(`Local merge failed for ${taskBranch}: ${mergeOut}`, "WARN");
    gitSync(state.mainRepo, "merge", "--abort");
  }

  // Restore branch if needed
  if (currentBranch && currentBranch !== state.baseBranch) {
    gitSync(state.mainRepo, "checkout", currentBranch);
  }
}

/** Create a PR for a completed task. */
export function createTaskPR(state: OrchestratorState, taskId: string): void {
  if (state.local) {
    mergeTaskLocally(state, taskId);
    return;
  }

  const taskBranch = `ralph/${taskId}`;

  gitSync(state.mainRepo, "fetch", "origin", taskBranch, state.baseBranch);
  const { exitCode: fetchExit } = gitSync(state.mainRepo, "fetch", "origin", taskBranch);
  if (fetchExit !== 0) {
    log(`  PR skip ${taskId}: branch not on remote`, "WARN");
    return;
  }

  // Check for actual changes
  const { stdout: cherry } = gitSync(state.mainRepo, "cherry", `origin/${state.baseBranch}`, `origin/${taskBranch}`);
  if (!cherry || !cherry.split("\n").some((l) => l.startsWith("+"))) {
    log(`  PR skip ${taskId}: no changes vs ${state.baseBranch}`, "WARN");
    return;
  }

  // Skip if open PR already exists
  const { stdout: prState, exitCode: prExit } = ghSync("pr", "view", taskBranch, "--json", "state", "--jq", ".state");
  if (prExit === 0 && prState.toUpperCase() === "OPEN") return;

  const { stdout: prUrl, exitCode: createExit } = ghInDir(state.mainRepo, "pr", "create",
    "--base", state.baseBranch,
    "--head", taskBranch,
    "--title", `ralph: ${taskId}`,
    "--body", `Automated PR for completed task **${taskId}**.`);

  if (createExit === 0 && prUrl) {
    log(`Created PR for ${taskId}: ${prUrl}`, "OK");
  } else {
    log(`PR create failed for ${taskId} (exit ${createExit})`, "WARN");
  }
}

/** Create PRs for all tasks in the Done column that have remote branches. */
export async function createPRsForDoneTasks(state: OrchestratorState): Promise<void> {
  if (state.local) return;

  const board = await getBoardJson(state.mainRepo);
  if (!board) {
    log("Cannot read board for Done-task PR sweep", "WARN");
    return;
  }

  const doneIndex = getColumnIndex(board, "Done");
  if (doneIndex < 0) return;

  const doneTaskIds = new Set<string>();
  for (const lane of board.lanes) {
    if (doneIndex >= lane.columns.length) continue;
    for (const task of lane.columns[doneIndex]) doneTaskIds.add(task.id);
  }

  if (doneTaskIds.size === 0) return;

  const { stdout: remoteBranches } = gitSync(state.mainRepo, "ls-remote", "--heads", "origin", "ralph/*");
  if (!remoteBranches) return;

  let created = 0;
  for (const line of remoteBranches.split("\n")) {
    const m = line.match(/refs\/heads\/(ralph\/.+)$/);
    if (!m) continue;
    const remoteBranch = m[1];
    if (/^ralph\/worker-\d+$/.test(remoteBranch)) continue;

    const taskId = remoteBranch.replace(/^ralph\//, "");
    if (doneTaskIds.has(taskId)) {
      created++;
      createTaskPR(state, taskId);
    }
  }

  if (created > 0) {
    log(`Processed ${created} Done task(s) with remote branches`, "OK");
  }
}

/** Try to merge a PR directly. Returns true if merged. */
export function mergeCleanPR(
  state: OrchestratorState,
  prNumber: number,
  mergeWorktreePath: string | null,
): boolean {
  // Check PR state
  const { stdout: prState } = ghSync("pr", "view", String(prNumber), "--json", "state", "--jq", ".state");
  if (prState.toUpperCase() === "MERGED") {
    log(`  PR #${prNumber}: already merged, cleaning up branch`, "OK");
    const { stdout: prBranch } = ghSync("pr", "view", String(prNumber), "--json", "headRefName", "--jq", ".headRefName");
    if (prBranch) gitSync(state.mainRepo, "push", "origin", "--delete", prBranch);
    return true;
  }
  if (prState.toUpperCase() === "CLOSED") {
    log(`  PR #${prNumber}: already closed`, "WARN");
    return false;
  }

  // Quick conflict marker check on diff
  const { stdout: diff, exitCode: diffExit } = ghSync("pr", "diff", String(prNumber));
  if (diffExit !== 0) {
    log(`  PR #${prNumber}: failed to fetch diff`, "WARN");
    return false;
  }
  if (diff && diff.split("\n").some((l) => /^\+(<{7} |={7}$|>{7} )/.test(l))) {
    log(`  PR #${prNumber}: conflict markers found in diff, needs worker review`, "WARN");
    return false;
  }

  // Try direct merge
  const { exitCode: mergeExit, stdout: mergeOut } = ghSync("pr", "merge", String(prNumber), "--rebase");
  if (mergeExit === 0) {
    log(`  PR #${prNumber}: merged`, "OK");
    return true;
  }

  if (mergeOut.includes("already merged")) {
    log(`  PR #${prNumber}: already merged, cleaning up branch`, "OK");
    const { stdout: prBranch } = ghSync("pr", "view", String(prNumber), "--json", "headRefName", "--jq", ".headRefName");
    if (prBranch) gitSync(state.mainRepo, "push", "origin", "--delete", prBranch);
    return true;
  }

  // Retry after fetch
  gitSync(state.mainRepo, "fetch", "origin", state.baseBranch);
  const { exitCode: retryExit, stdout: retryOut } = ghSync("pr", "merge", String(prNumber), "--rebase");
  if (retryExit === 0) {
    log(`  PR #${prNumber}: merged (after fetch)`, "OK");
    return true;
  }
  if (retryOut.includes("already merged")) {
    log(`  PR #${prNumber}: already merged, cleaning up branch`, "OK");
    const { stdout: prBranch } = ghSync("pr", "view", String(prNumber), "--json", "headRefName", "--jq", ".headRefName");
    if (prBranch) gitSync(state.mainRepo, "push", "origin", "--delete", prBranch);
    return true;
  }

  // Try local rebase + force-push from worktree
  if (mergeWorktreePath && existsSync(mergeWorktreePath)) {
    const { stdout: prBranch } = ghSync("pr", "view", String(prNumber), "--json", "headRefName", "--jq", ".headRefName");
    if (prBranch) {
      log(`  PR #${prNumber}: rebasing locally...`, "WARN");

      gitInDir(mergeWorktreePath, "fetch", "origin", prBranch, state.baseBranch);
      const { exitCode: coExit } = gitInDir(mergeWorktreePath, "checkout", `origin/${prBranch}`, "--detach");
      if (coExit !== 0) {
        log(`  PR #${prNumber}: checkout failed`, "WARN");
        return false;
      }

      const { exitCode: rbExit } = gitInDir(mergeWorktreePath, "rebase", `origin/${state.baseBranch}`);
      if (rbExit !== 0) {
        log(`  PR #${prNumber}: rebase has conflicts, needs worker`, "WARN");
        gitInDir(mergeWorktreePath, "rebase", "--abort");
        return false;
      }

      // Verify no conflict markers after rebase
      const { exitCode: grepExit, stdout: grepOut } = gitInDir(mergeWorktreePath, "grep", "-l", "-E", "^<{7} |^={7}$|^>{7} ", "HEAD", "--");
      if (grepExit === 0 && grepOut) {
        log(`  PR #${prNumber}: conflict markers after rebase, needs worker`, "WARN");
        return false;
      }

      gitInDir(mergeWorktreePath, "push", "origin", `HEAD:${prBranch}`, "--force");
      log(`  PR #${prNumber}: rebased and pushed`, "OK");

      // Detach HEAD
      gitInDir(mergeWorktreePath, "checkout", "--detach");

      // Retry merge after a brief pause
      const { exitCode: finalExit, stdout: finalOut } = ghSync("pr", "merge", String(prNumber), "--rebase");
      if (finalExit === 0) {
        log(`  PR #${prNumber}: merged (after local rebase)`, "OK");
        return true;
      }
      if (finalOut.includes("already merged")) {
        log(`  PR #${prNumber}: already merged`, "OK");
        gitSync(state.mainRepo, "push", "origin", "--delete", prBranch);
        return true;
      }
      log(`  PR #${prNumber}: merge still failed after rebase: ${finalOut}`, "WARN");
      return false;
    }
  }

  log(`  PR #${prNumber}: merge failed: ${retryOut}`, "WARN");
  return false;
}

/** Clean up a branch after its PR has been merged. */
export function cleanupBranchAfterMerge(
  state: OrchestratorState,
  taskBranch: string,
  worktrees: Map<number, string>,
): void {
  // Detach HEAD in any worktree that has this branch checked out
  for (const [, path] of worktrees) {
    const { stdout: currentBranch } = gitInDir(path, "rev-parse", "--abbrev-ref", "HEAD");
    if (currentBranch === taskBranch) {
      gitInDir(path, "checkout", "--", ".kanbn");
      gitInDir(path, "checkout", "--detach");
      break;
    }
  }

  const { exitCode } = gitSync(state.mainRepo, "branch", "-D", taskBranch);
  if (exitCode === 0) {
    log(`  Cleaned up local branch: ${taskBranch}`, "OK");
  }

  if (!state.local) {
    gitSync(state.mainRepo, "push", "origin", "--delete", taskBranch);
  }
}

/** Get all open ralph PRs. Returns empty in --local mode. */
export function getPendingRalphPRs(mainRepo: string, local = false): PullRequest[] {
  if (local) return [];
  const { stdout, exitCode } = ghInDir(mainRepo, "pr", "list", "--json", "number,headRefName,mergeable,mergeStateStatus");
  if (exitCode !== 0 || !stdout) return [];

  try {
    const parsed: PullRequest[] = JSON.parse(stdout);
    return parsed.filter((pr) => pr.headRefName.startsWith("ralph/"));
  } catch {
    return [];
  }
}

/** Drain all pending ralph PRs: try direct merge, fall back to worker review. */
export async function drainPendingPRs(
  state: OrchestratorState,
  mergeWorktreePath: string | null,
  worktrees: Map<number, string>,
): Promise<void> {
  if (state.local) return;

  const pendingPRs = getPendingRalphPRs(state.mainRepo);
  if (pendingPRs.length === 0) {
    log("No pending ralph PRs found.", "OK");
    return;
  }

  log(`Found ${pendingPRs.length} pending PR(s), draining...`);

  for (const pr of pendingPRs) {
    log(`  PR #${pr.number} (${pr.headRefName}): attempting merge...`);
    if (mergeCleanPR(state, pr.number, mergeWorktreePath)) {
      cleanupBranchAfterMerge(state, pr.headRefName, worktrees);
      continue;
    }

    // Fall back to worker for conflict resolution
    if (!mergeWorktreePath) continue;

    const logFile = join(state.logDir, "worker-merge.log");
    log(`  Worker dispatched on merge review: PR #${pr.number} (${pr.headRefName})`);

    const { promise } = spawnMergeReviewWorker(
      1, pr.number, pr.headRefName, state.baseBranch, logFile, mergeWorktreePath,
    );

    const result = await promise;
    log(`  Merge review PR #${pr.number}: ${result.status}`);

    if (result.status === "MERGE_REVIEW_DONE") {
      const { stdout: postState } = ghSync("pr", "view", String(pr.number), "--json", "state", "--jq", ".state");
      if (postState.toUpperCase() === "MERGED") {
        log(`  PR #${pr.number}: already merged by worker, cleaning up`, "OK");
        cleanupBranchAfterMerge(state, pr.headRefName, worktrees);
      } else if (postState.toUpperCase() === "OPEN") {
        log(`  PR #${pr.number}: still open after worker review, retrying merge...`);
        if (mergeCleanPR(state, pr.number, mergeWorktreePath)) {
          cleanupBranchAfterMerge(state, pr.headRefName, worktrees);
        } else {
          log(`  PR #${pr.number}: merge still failed after worker review`, "WARN");
        }
      }
    }
  }

  log("Drain complete", "OK");
}
