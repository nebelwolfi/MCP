import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { WorkerResult, WorkerStatus } from "./types.js";
import { log } from "./logger.js";
import { gitInDir, isKanbnPath } from "./git.js";

function getWorkerPrompt(taskId: string, claimedSubTask: string | null): string {
  let subTaskInstructions = "";
  if (claimedSubTask) {
    subTaskInstructions = `YOUR ASSIGNED SUBTASK: ${claimedSubTask}

- Complete this exact sub-task in this cycle
- If it already was completed then that was your work!

`;
  }

  return `@progress.txt

YOUR ASSIGNED TASK ID: ${taskId}

${subTaskInstructions}
1. Work ONLY on the assigned task above. Do not pick a different task.
Review your task using kanban mcp.

2. Break down what needs to happen.
If the task is too large (more than ~200 lines of changes), break it into
smaller sub-tasks first using kanban mcp edit.

3. Check that the tests pass.

4. Append your progress to the progress.txt file.
Use this to leave a note for the next person working in the codebase.

5. Make a git commit of that feature.

ONLY WORK ON THIS SINGLE TASK. IF THE TASK HAS SUBTASKS, COMPLETE ONLY ONE.

### Rules

- **Never skip tests.** If you can't test it, you can't ship it.
- **Never leave the build broken** between cycles. Every cycle ends with a green build.
- **If a task reveals missing infrastructure**, create a new task with kanban mcp, set it as a blocker relation, and work on it first.
- **Commit atomically.** Each completed task should be one logical unit - all its files work together.`;
}

function getMergeReviewPrompt(prNumber: number, taskBranch: string, targetBranch: string): string {
  return `You are resolving merge conflicts and merging a pull request.

PR #${prNumber} (branch: ${taskBranch} -> ${targetBranch})

IMPORTANT CONSTRAINTS:
- Do NOT run \`gh pr checkout\` (it fails when the branch is checked out in another worktree)
- Do NOT run \`git checkout ${targetBranch}\` (it is checked out in the main repo and will fail)
- Do NOT navigate to any other directory — stay in the current working directory
- Use detached HEAD mode for all operations

Steps:
1. Fetch and check out the PR branch in detached HEAD mode:
\`\`\`bash
git fetch origin ${taskBranch} ${targetBranch}
git checkout origin/${taskBranch} --detach
\`\`\`

2. Rebase onto the target:
\`\`\`bash
git rebase origin/${targetBranch}
\`\`\`

3. Resolve ALL merge conflicts. For each conflicting file:
- Read both sides of the conflict carefully
- Keep the intent of both changes (do not discard either side's work)
- Remove all conflict markers (<<<<<<<, =======, >>>>>>>)
- Stage the resolved file and continue the rebase

4. After resolving, verify NO conflict markers remain:
\`\`\`bash
git grep -n -E '^<{7} |^={7}$|^>{7} ' -- '*.cpp' '*.h' '*.md' '*.txt' '*.cmake'
\`\`\`
If any results appear, you MUST fix them before proceeding.

5. Build and run tests to verify the resolution is correct:
\`\`\`bash
cmake --build cmake-build-debug --target tests && cmake-build-debug/git/tests/tests.exe --unit
\`\`\`

6. Force-push the rebased branch:
\`\`\`bash
git push origin HEAD:${taskBranch} --force
\`\`\`

7. Merge the PR:
\`\`\`bash
gh pr merge ${prNumber} --rebase
\`\`\`

If you cannot resolve the conflicts cleanly, abort:
\`\`\`bash
git rebase --abort
\`\`\`
Then leave a comment explaining the issue:
\`\`\`bash
gh pr comment ${prNumber} --body "Unable to auto-resolve conflicts: [explain what conflicts and why]"
\`\`\`

CRITICAL: Never push files containing conflict markers. Always verify with git grep before pushing.`;
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function spawnWorker(
  workerId: number,
  worktreePath: string,
  taskId: string,
  claimedSubTask: string | null,
  logFile: string,
  baseBranch: string,
): { promise: Promise<WorkerResult>; process: ChildProcess } {
  const prompt = getWorkerPrompt(taskId, claimedSubTask);

  appendFileSync(logFile, `[${timestamp()}] Worker ${workerId} - Running task ${taskId}\n`);

  const child = spawn("claude", [
    "--model", "claude-opus-4-6",
    "--effort", "high",
    "--permission-mode", "bypassPermissions",
    "-p",
  ], {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    env: { ...process.env },
  });

  // Write prompt to stdin
  child.stdin!.write(prompt);
  child.stdin!.end();

  const promise = new Promise<WorkerResult>((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (data) => chunks.push(data));
    child.stderr?.on("data", (data) => chunks.push(data));

    child.on("close", (exitCode) => {
      const resultText = Buffer.concat(chunks).toString("utf-8");

      const iterLog = `${logFile}.iter-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
      writeFileSync(iterLog, resultText, "utf-8");

      if (exitCode !== 0) {
        const lastLines = resultText.split("\n").slice(-5).join(" | ").slice(0, 300);
        const errorSummary = `exit code ${exitCode} - ${lastLines}`;
        appendFileSync(logFile, `[${timestamp()}] Worker ${workerId} - ERROR: ${errorSummary} (saved to ${iterLog})\n`);
        resolve({ status: "ERROR", workerId, taskId, error: errorSummary });
        return;
      }

      appendFileSync(logFile, `[${timestamp()}] Worker ${workerId} - Result length: ${resultText.length} (saved to ${iterLog})\n`);

      // Auto-commit uncommitted submodule work
      gitInDir(worktreePath, "submodule", "foreach", "--recursive",
        "git add -A && git diff --cached --quiet || git commit -m \"auto: uncommitted work\"");
      const { stdout: rescueDirty } = gitInDir(worktreePath, "status", "--porcelain");
      if (rescueDirty) {
        gitInDir(worktreePath, "add", "-A");
        gitInDir(worktreePath, "commit", "-m", "auto: save uncommitted submodule and file changes");
      }

      // Check for non-.kanbn changes
      const { stdout: changedFiles } = gitInDir(worktreePath, "diff", "--name-only", `${baseBranch}..HEAD`);
      let hasNonKanbnChanges = false;
      if (changedFiles) {
        hasNonKanbnChanges = changedFiles.split("\n").some((f) => !isKanbnPath(f));
      }

      const status: WorkerStatus = hasNonKanbnChanges ? "TASK_COMPLETE" : "NO_COMMITS";
      resolve({ status, workerId, taskId });
    });

    child.on("error", (err) => {
      resolve({ status: "ERROR", workerId, taskId, error: err.message });
    });
  });

  return { promise, process: child };
}

export function spawnMergeReviewWorker(
  workerId: number,
  prNumber: number,
  taskBranch: string,
  targetBranch: string,
  logFile: string,
  worktreePath: string,
): { promise: Promise<WorkerResult>; process: ChildProcess } {
  const prompt = getMergeReviewPrompt(prNumber, taskBranch, targetBranch);

  appendFileSync(logFile, `[${timestamp()}] Worker ${workerId} - Reviewing PR #${prNumber}\n`);

  const child = spawn("claude", [
    "--model", "claude-opus-4-6",
    "--effort", "high",
    "--permission-mode", "bypassPermissions",
    "-p",
  ], {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  child.stdin!.write(prompt);
  child.stdin!.end();

  const promise = new Promise<WorkerResult>((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (data) => chunks.push(data));
    child.stderr?.on("data", (data) => chunks.push(data));

    child.on("close", (exitCode) => {
      const resultText = Buffer.concat(chunks).toString("utf-8");

      const iterLog = `${logFile}.merge-review-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
      writeFileSync(iterLog, resultText, "utf-8");
      appendFileSync(logFile, `[${timestamp()}] Worker ${workerId} - Merge review exit code: ${exitCode} (saved to ${iterLog})\n`);

      // Detach HEAD to release branch lock
      gitInDir(worktreePath, "checkout", "--detach");

      const status: WorkerStatus = exitCode === 0 ? "MERGE_REVIEW_DONE" : "MERGE_REVIEW_ERROR";
      resolve({ status, workerId, taskId: `merge-review-${prNumber}` });
    });

    child.on("error", (err) => {
      resolve({ status: "ERROR", workerId, taskId: `merge-review-${prNumber}`, error: err.message });
    });
  });

  return { promise, process: child };
}
