import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Config, OrchestratorState, WorkerResult, ActiveJob } from "./types.js";
import { log } from "./logger.js";
import { gitSync, gitInDir, commandExists, hasNonKanbnChangesInRange, getRepoRoot, detectBaseBranch, discoverSubmodules } from "./git.js";
import {
  claimNextTask, moveKanbanTask, releaseTaskClaim, isBoardComplete,
  repairDoneCardsWithIncompleteSubTasks, sanitizeTaskFiles,
  getTaskJson, getTaskColumn, isSubTaskComplete, allSubTasksComplete,
  getFirstIncompleteSubTask, completeSubTaskInRepo, getBoardJson, getColumnIndex,
} from "./kanban.js";
import {
  newRalphWorktree, initializeSubmodules, patchClaudeMD, configureWorktreeBuild,
  removeRalphWorktree, newMergeWorktree, removeMergeWorktree, removeAllWorktrees,
  switchWorktreeToTaskBranch, syncKanbnToWorktree, ensureUnionMergeForProgressTxt,
  stopAllWorkerProcesses, pruneMergedRalphBranches,
} from "./worktree.js";
import { spawnWorker } from "./worker.js";
import { publishWorkerResults, createTaskPR, createPRsForDoneTasks, mergeCleanPR, cleanupBranchAfterMerge, drainPendingPRs, getPendingRalphPRs } from "./merge.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initState(config: Config): OrchestratorState {
  const mainRepo = getRepoRoot(config.projectDir);
  const baseBranch = config.baseBranch || detectBaseBranch(mainRepo);
  const worktreeRoot = `${mainRepo}/.ralph-worktrees`;
  const logDir = `${worktreeRoot}/logs`;
  const submodules = discoverSubmodules(mainRepo);

  // Set KANBAN_ROOT for MCP tools
  process.env.KANBAN_ROOT = mainRepo;

  return {
    mainRepo,
    baseBranch,
    worktreeRoot,
    logDir,
    submodules,
    claimedTasks: new Map(),
    claimedSubTasks: new Map(),
    completedTasks: new Set(),
  };
}

function validatePrerequisites(): boolean {
  for (const cmd of ["claude", "git", "gh"]) {
    if (!commandExists(cmd)) {
      console.error(`Required command not found: ${cmd}`);
      return false;
    }
  }
  return true;
}

export async function runCleanup(config: Config): Promise<void> {
  const state = initState(config);
  mkdirSync(state.worktreeRoot, { recursive: true });
  mkdirSync(state.logDir, { recursive: true });

  log("Merging pending PRs before cleanup...");
  await drainPendingPRs(state, null, new Map());
  removeAllWorktrees(state);
}

export async function runMergeOnly(config: Config): Promise<void> {
  if (!validatePrerequisites()) return;

  const state = initState(config);
  mkdirSync(state.worktreeRoot, { recursive: true });
  mkdirSync(state.logDir, { recursive: true });

  log("=== Ralph Parallel (merge-only) ===");
  log(`Merge workers: ${config.workers} | Base branch: ${state.baseBranch} | Main repo: ${state.mainRepo}`);
  console.log();

  ensureUnionMergeForProgressTxt(state);

  const mergeWorktreePath = newMergeWorktree(state);
  if (!mergeWorktreePath) {
    log("Failed to create merge worktree, aborting", "ERROR");
    return;
  }

  initializeSubmodules(state, mergeWorktreePath);
  patchClaudeMD(state, mergeWorktreePath);

  try {
    createPRsForDoneTasks(state);
    await drainPendingPRs(state, mergeWorktreePath, new Map());
    pruneMergedRalphBranches(state);
  } finally {
    removeMergeWorktree(state);
  }
}

export async function runMain(config: Config): Promise<void> {
  if (!validatePrerequisites()) return;
  if (config.workers < 1) {
    console.log("Usage: ralph [--workers N] [--iterations-per-worker N] [--base-branch branch]");
    return;
  }

  const state = initState(config);

  log("=== Ralph Parallel ===");
  log(`Workers: ${config.workers} | Iterations/worker: ${config.iterationsPerWorker} | Total budget: ${config.workers * config.iterationsPerWorker}`);
  log(`Base branch: ${state.baseBranch} | Main repo: ${state.mainRepo}`);
  console.log();

  mkdirSync(state.worktreeRoot, { recursive: true });
  mkdirSync(state.logDir, { recursive: true });

  const activeJobs = new Map<number, ActiveJob>();
  const worktrees = new Map<number, string>();
  const childProcesses = new Set<ChildProcess>();
  let totalCompleted = 0;
  const maxIterations = config.workers * config.iterationsPerWorker;
  let totalIterations = 0;
  let boardComplete = false;
  let shutdownRequested = false;
  let mergeWorktreePath: string | null = null;

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      log("", "WARN");
      log("Ctrl+C received -- waiting for running workers to finish...", "WARN");
    }
  });

  try {
    // Phase 1: Setup
    ensureUnionMergeForProgressTxt(state);
    log(`Phase 1: Setting up ${config.workers} worktrees...`);

    for (let w = 1; w <= config.workers; w++) {
      log(`--- Worker ${w} setup ---`);
      const path = newRalphWorktree(state, w);
      if (!path) {
        log(`Skipping worker ${w} due to worktree creation failure`, "ERROR");
        continue;
      }

      initializeSubmodules(state, path);
      patchClaudeMD(state, path);

      if (!config.skipBuild) {
        if (!configureWorktreeBuild(state, path)) {
          log(`Skipping worker ${w} due to build failure`, "ERROR");
          continue;
        }
      }

      worktrees.set(w, path);
    }

    if (worktrees.size === 0) {
      log("No worktrees were created successfully. Exiting.", "ERROR");
      return;
    }

    // Setup merge worktree
    log("--- Merge worker setup ---");
    mergeWorktreePath = newMergeWorktree(state);
    if (mergeWorktreePath) {
      initializeSubmodules(state, mergeWorktreePath);
      patchClaudeMD(state, mergeWorktreePath);
    } else {
      log("Merge worktree creation failed, merge reviews will be skipped", "WARN");
    }

    // Sanitize Unicode in task files
    console.log();
    log("Sanitizing task files...");
    sanitizeTaskFiles(state.mainRepo);

    // Repair invalid Done cards
    console.log();
    log("Repairing Done cards with incomplete subtasks...");
    repairDoneCardsWithIncompleteSubTasks(state.mainRepo);

    // Phase 2: Initial dispatch
    console.log();
    log("Phase 2: Dispatching workers...");

    for (const [w, path] of worktrees) {
      const claim = claimNextTask(state, w, worktrees);
      if (!claim) {
        log(`No tasks available for worker ${w}`, "WARN");
        continue;
      }

      switchWorktreeToTaskBranch(path, claim.taskId, state.baseBranch);
      syncKanbnToWorktree(state.mainRepo, path);
      const logFile = join(state.logDir, `worker-${w}.log`);

      const { promise, process: child } = spawnWorker(w, path, claim.taskId, claim.claimedSubTask, logFile, state.baseBranch);
      childProcesses.add(child);
      child.on("close", () => childProcesses.delete(child));

      activeJobs.set(w, { promise, process: child, taskId: claim.taskId, claimedSubTask: claim.claimedSubTask });
      const subInfo = claim.claimedSubTask ? ` (subtask: ${claim.claimedSubTask})` : "";
      log(`Worker ${w} dispatched on task: ${claim.taskId}${subInfo}`);
    }

    if (activeJobs.size === 0) {
      log("No tasks to work on. Board may be empty.", "WARN");
      return;
    }

    // Phase 3: Monitor loop
    console.log();
    log("Phase 3: Monitoring workers...");
    const noCommitCounts = new Map<string, number>();

    while (activeJobs.size > 0 && !boardComplete && !shutdownRequested) {
      // Wait for any job to complete or timeout
      const settled = await Promise.race([
        ...[...activeJobs.entries()].map(([id, job]) =>
          job.promise.then((result) => ({ workerId: id, result })),
        ),
        delay(10000).then(() => null),
      ]);

      if (shutdownRequested) break;
      if (!settled) {
        // Timeout - guard: ensure MAIN_REPO stays on correct branch
        const { stdout: currentMain } = gitSync(state.mainRepo, "rev-parse", "--abbrev-ref", "HEAD");
        if (currentMain && currentMain !== state.baseBranch) {
          log(`MAIN_REPO on '${currentMain}' instead of '${state.baseBranch}', restoring!`, "ERROR");
          gitSync(state.mainRepo, "checkout", state.baseBranch);
        }
        continue;
      }

      const { workerId, result } = settled;
      const jobInfo = activeJobs.get(workerId)!;
      activeJobs.delete(workerId);

      const errorDetail = result.error ? ` - ${result.error}` : "";
      log(`Worker ${workerId} finished: ${result.status} (task: ${jobInfo.taskId})${errorDetail}`);

      const claimedSubTask = jobInfo.claimedSubTask;
      let workerTaskSnapshot = null;
      let workerColumnSnapshot: string | null = null;

      if (result.status === "TASK_COMPLETE") {
        workerTaskSnapshot = getTaskJson(state.mainRepo, jobInfo.taskId);
        workerColumnSnapshot = getTaskColumn(state.mainRepo, jobInfo.taskId);
      }

      // Publish if there are non-.kanbn changes
      const taskBranch = `ralph/${jobInfo.taskId}`;
      const workerPath = worktrees.get(workerId);
      if (workerPath && hasNonKanbnChangesInRange(workerPath, `${state.baseBranch}..${taskBranch}`)) {
        if (publishWorkerResults(state, workerPath, workerId, jobInfo.taskId)) {
          log(`Worker ${workerId}: pushed branch for ${jobInfo.taskId}`, "OK");
        } else {
          log(`Worker ${workerId}: publish failed for ${jobInfo.taskId}`, "ERROR");
        }
      }

      totalIterations++;
      totalCompleted++;
      log(`Worker ${workerId}: iteration ${totalIterations} / ${maxIterations} (budget)`);

      // Handle result
      if (result.status === "TASK_COMPLETE") {
        const workerMovedToDone = workerColumnSnapshot?.toLowerCase() === "done";
        const workerCheckedSubTask = isSubTaskComplete(workerTaskSnapshot, claimedSubTask ?? "");

        if (claimedSubTask && (workerCheckedSubTask || workerMovedToDone)) {
          if (completeSubTaskInRepo(state.mainRepo, jobInfo.taskId, claimedSubTask)) {
            log(`Synced completed subtask from worker: ${claimedSubTask}`, "OK");
          } else {
            log(`Failed to sync claimed subtask to main board: ${claimedSubTask}`, "WARN");
          }
        } else if (claimedSubTask) {
          // Force-mark subtask complete
          if (completeSubTaskInRepo(state.mainRepo, jobInfo.taskId, claimedSubTask)) {
            log(`Force-marked subtask complete (worker had TASK_COMPLETE but didn't check it off): ${claimedSubTask}`, "WARN");
          } else {
            log(`Failed to force-mark subtask; may loop: ${claimedSubTask}`, "ERROR");
          }
        }

        const mainTask = getTaskJson(state.mainRepo, jobInfo.taskId);
        const allComplete = allSubTasksComplete(mainTask);

        if (allComplete) {
          moveKanbanTask(state.mainRepo, jobInfo.taskId, "Done");
          state.completedTasks.add(jobInfo.taskId);
          createTaskPR(state, jobInfo.taskId);
          releaseTaskClaim(state, jobInfo.taskId);

          if (isBoardComplete(state.mainRepo)) {
            log("All tasks are in Done column with complete subtasks", "OK");
            boardComplete = true;
          }
        } else {
          // Advance to next subtask
          const nextSub = getFirstIncompleteSubTask(mainTask);
          if (nextSub && totalIterations < maxIterations && workerPath) {
            state.claimedSubTasks.set(jobInfo.taskId, nextSub);
            log(`Worker ${workerId} advancing to next subtask: ${nextSub}`);
            syncKanbnToWorktree(state.mainRepo, workerPath);
            const logFile = join(state.logDir, `worker-${workerId}.log`);
            const { promise, process: child } = spawnWorker(workerId, workerPath, jobInfo.taskId, nextSub, logFile, state.baseBranch);
            childProcesses.add(child);
            child.on("close", () => childProcesses.delete(child));
            activeJobs.set(workerId, { promise, process: child, taskId: jobInfo.taskId, claimedSubTask: nextSub });
            continue;
          } else if (nextSub) {
            log(`Worker ${workerId} has remaining subtasks but hit iteration budget (${totalIterations} / ${maxIterations})`, "WARN");
          } else {
            moveKanbanTask(state.mainRepo, jobInfo.taskId, "Done");
            state.completedTasks.add(jobInfo.taskId);
            createTaskPR(state, jobInfo.taskId);
            releaseTaskClaim(state, jobInfo.taskId);
          }
        }
      } else if (result.status === "ERROR") {
        moveKanbanTask(state.mainRepo, jobInfo.taskId, "Todo");
        releaseTaskClaim(state, jobInfo.taskId);
        log(`Task ${jobInfo.taskId} errored: ${result.error}`, "WARN");
      } else if (result.status !== "NO_COMMITS") {
        releaseTaskClaim(state, jobInfo.taskId);
      }

      // Decide next work
      if (!boardComplete && totalIterations < maxIterations && workerPath) {
        let dispatched = false;

        if (result.status === "NO_COMMITS") {
          const ncKey = `${jobInfo.taskId}::${jobInfo.claimedSubTask ?? ""}`;
          noCommitCounts.set(ncKey, (noCommitCounts.get(ncKey) ?? 0) + 1);

          // Check subtask completion
          let advanced = false;
          if (claimedSubTask) {
            const workerTask = getTaskJson(state.mainRepo, jobInfo.taskId);
            if (isSubTaskComplete(workerTask, claimedSubTask)) {
              completeSubTaskInRepo(state.mainRepo, jobInfo.taskId, claimedSubTask);
              log(`Synced completed subtask from worker (NO_COMMITS): ${claimedSubTask}`, "OK");
              noCommitCounts.delete(ncKey);

              const mainTask = getTaskJson(state.mainRepo, jobInfo.taskId);
              const nextSub = getFirstIncompleteSubTask(mainTask);
              if (nextSub) {
                log(`Worker ${workerId} advancing to next subtask: ${nextSub}`);
                state.claimedSubTasks.set(jobInfo.taskId, nextSub);
                syncKanbnToWorktree(state.mainRepo, workerPath);
                const logFile = join(state.logDir, `worker-${workerId}.log`);
                const { promise, process: child } = spawnWorker(workerId, workerPath, jobInfo.taskId, nextSub, logFile, state.baseBranch);
                childProcesses.add(child);
                child.on("close", () => childProcesses.delete(child));
                activeJobs.set(workerId, { promise, process: child, taskId: jobInfo.taskId, claimedSubTask: nextSub });
                dispatched = true;
                advanced = true;
              } else {
                log(`All subtasks complete for ${jobInfo.taskId}, moving to Done`, "OK");
                moveKanbanTask(state.mainRepo, jobInfo.taskId, "Done");
                state.completedTasks.add(jobInfo.taskId);
                createTaskPR(state, jobInfo.taskId);
                releaseTaskClaim(state, jobInfo.taskId);
                advanced = true;

                if (isBoardComplete(state.mainRepo)) {
                  log("All tasks are in Done column with complete subtasks", "OK");
                  boardComplete = true;
                }
              }
            }
          }

          if (!advanced) {
            const ncCount = noCommitCounts.get(ncKey) ?? 0;
            if (ncCount >= 5) {
              log(`Worker ${workerId}: ${ncCount} NO_COMMITS on ${ncKey}, giving up`, "WARN");
              moveKanbanTask(state.mainRepo, jobInfo.taskId, "Todo");
              releaseTaskClaim(state, jobInfo.taskId);
              noCommitCounts.delete(ncKey);
            } else {
              // Reset worktree after 3 consecutive failures
              if (ncCount >= 3) {
                log(`Worker ${workerId}: ${ncCount} consecutive NO_COMMITS on ${ncKey}, resetting worktree for clean slate`);
                gitInDir(workerPath, "submodule", "foreach", "--recursive", "git checkout -- . && git clean -fd");
                gitInDir(workerPath, "checkout", "--", ".");
                gitInDir(workerPath, "clean", "-fd");
                gitInDir(workerPath, "reset", "--hard", state.baseBranch);
                switchWorktreeToTaskBranch(workerPath, jobInfo.taskId, state.baseBranch);
              }

              log(`Worker ${workerId} continuing on task: ${jobInfo.taskId}`);
              syncKanbnToWorktree(state.mainRepo, workerPath);
              const logFile = join(state.logDir, `worker-${workerId}.log`);
              const { promise, process: child } = spawnWorker(workerId, workerPath, jobInfo.taskId, jobInfo.claimedSubTask, logFile, state.baseBranch);
              childProcesses.add(child);
              child.on("close", () => childProcesses.delete(child));
              activeJobs.set(workerId, { promise, process: child, taskId: jobInfo.taskId, claimedSubTask: jobInfo.claimedSubTask });
              dispatched = true;
            }
          }
        }

        // Try instant merge of pending PRs
        if (!dispatched) {
          const ncKey = `${jobInfo.taskId}::${jobInfo.claimedSubTask ?? ""}`;
          noCommitCounts.delete(ncKey);

          if (mergeWorktreePath) {
            const pendingPRs = getPendingRalphPRs(state.mainRepo);
            for (const pr of pendingPRs) {
              log(`Worker ${workerId}: attempting merge of PR #${pr.number} (${pr.headRefName})...`);
              if (mergeCleanPR(state, pr.number, mergeWorktreePath)) {
                cleanupBranchAfterMerge(state, pr.headRefName, worktrees);
              }
            }
          }
        }

        // Claim next task
        if (!dispatched) {
          const nextClaim = claimNextTask(state, workerId, worktrees);
          if (nextClaim && workerPath) {
            switchWorktreeToTaskBranch(workerPath, nextClaim.taskId, state.baseBranch);
            syncKanbnToWorktree(state.mainRepo, workerPath);
            const logFile = join(state.logDir, `worker-${workerId}.log`);
            const { promise, process: child } = spawnWorker(workerId, workerPath, nextClaim.taskId, nextClaim.claimedSubTask, logFile, state.baseBranch);
            childProcesses.add(child);
            child.on("close", () => childProcesses.delete(child));
            activeJobs.set(workerId, { promise, process: child, taskId: nextClaim.taskId, claimedSubTask: nextClaim.claimedSubTask });
            const subInfo = nextClaim.claimedSubTask ? ` (subtask: ${nextClaim.claimedSubTask})` : "";
            log(`Worker ${workerId} restarted on task: ${nextClaim.taskId}${subInfo}`);
            dispatched = true;
          }
        }

        if (!dispatched) {
          log(`Worker ${workerId}: no more tasks or PRs, shutting down`);
        }
      }
    }

    // Graceful shutdown: wait for remaining workers
    if (shutdownRequested || boardComplete) {
      while (activeJobs.size > 0) {
        const settled = await Promise.race([
          ...[...activeJobs.entries()].map(([id, job]) =>
            job.promise.then((result) => ({ workerId: id, result })),
          ),
          delay(5000).then(() => null),
        ]);

        if (!settled) continue;

        const { workerId, result } = settled;
        const jobInfo = activeJobs.get(workerId)!;
        activeJobs.delete(workerId);
        log(`Worker ${workerId} finished (drain): ${result.status} (task: ${jobInfo.taskId})`);

        // Publish any remaining work
        const wp = worktrees.get(workerId);
        if (wp && result.status !== "ERROR") {
          const taskBr = `ralph/${jobInfo.taskId}`;
          if (hasNonKanbnChangesInRange(wp, `${state.baseBranch}..${taskBr}`)) {
            if (publishWorkerResults(state, wp, workerId, jobInfo.taskId)) {
              log(`Worker ${workerId}: pushed branch for ${jobInfo.taskId}`, "OK");
            }
          }
        }
      }
      log("All workers finished");
    }

    // Phase 3b: Drain pending PRs
    if (!shutdownRequested) {
      console.log();
      log("Phase 3b: Draining pending PRs...");
      await drainPendingPRs(state, mergeWorktreePath, worktrees);
    }

  } finally {
    // Phase 4: Cleanup
    console.log();
    log("Phase 4: Cleanup...");

    // Kill remaining child processes
    const treeKill = await import("tree-kill").then((m) => m.default).catch(() => null);
    for (const child of childProcesses) {
      if (child.pid && !child.killed) {
        if (treeKill) {
          treeKill(child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      }
    }

    stopAllWorkerProcesses(state.worktreeRoot);

    // Restore main repo to base branch
    const { stdout: currentBranch } = gitSync(state.mainRepo, "rev-parse", "--abbrev-ref", "HEAD");
    if (currentBranch && currentBranch !== state.baseBranch) {
      log(`Restoring main repo from '${currentBranch}' to '${state.baseBranch}'`);
      gitSync(state.mainRepo, "checkout", state.baseBranch);
    }

    // Move uncompleted claimed tasks back
    for (const [taskId] of state.claimedTasks) {
      moveKanbanTask(state.mainRepo, taskId, "In Progress");
      releaseTaskClaim(state, taskId);
    }

    // Remove worktrees
    for (const [w] of worktrees) {
      removeRalphWorktree(state, w);
    }
    removeMergeWorktree(state);

    // Prune merged branches
    pruneMergedRalphBranches(state);

    // Delete remaining local ralph/* branches
    const { stdout: localBranches } = gitSync(state.mainRepo, "branch", "--list", "ralph/*");
    if (localBranches) {
      for (const branchLine of localBranches.split("\n")) {
        const branch = branchLine.trim().replace(/^\* /, "");
        if (!branch || /^ralph\/worker-\d+$/.test(branch)) continue;

        const { stdout: ahead } = gitSync(state.mainRepo, "log", "--oneline", `origin/${branch}..${branch}`);
        if (!ahead) {
          const { stdout: aheadMaster } = gitSync(state.mainRepo, "log", "--oneline", `master..${branch}`);
          if (aheadMaster) {
            log(`  Pushing unpushed work on ${branch} before cleanup`);
            gitSync(state.mainRepo, "push", "origin", `${branch}:${branch}`, "--force");
          }
        } else {
          log(`  Pushing unpushed work on ${branch} before cleanup`);
          gitSync(state.mainRepo, "push", "origin", `${branch}:${branch}`, "--force");
        }

        gitSync(state.mainRepo, "branch", "-D", branch);
        log(`  Cleaned up local branch: ${branch}`, "OK");
      }
    }

    // Create PRs for Done tasks
    createPRsForDoneTasks(state);

    // Prune stale worktree refs
    gitSync(state.mainRepo, "worktree", "prune");
  }

  console.log();
  if (boardComplete) {
    console.log("\x1b[32mKanbn board is complete!\x1b[0m");
  } else {
    console.log(`\x1b[36mCompleted ${totalCompleted} total iterations across ${config.workers} workers.\x1b[0m`);
  }
}
