import type { Task } from "kanban-mcp/types";
import { readTask, writeTask, readIndex, getAllTasksWithColumns } from "kanban-mcp/storage";
import { moveTask, editTask } from "kanban-mcp/operations";
import type { TaskInfo, BoardJson, ClaimResult, OrchestratorState } from "./types.js";
import { log } from "./logger.js";
import { ghSync, gitSync } from "./git.js";

// ── Env helper ───────────────────────────────────────────────────────────

async function withRoot<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.KANBAN_ROOT;
  process.env.KANBAN_ROOT = repoPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.KANBAN_ROOT;
    else process.env.KANBAN_ROOT = prev;
  }
}

// ── Type conversion ──────────────────────────────────────────────────────

function taskToInfo(task: Task, column = ""): TaskInfo {
  return {
    id: task.id,
    title: task.title,
    subTasks: (task.subtasks ?? []).map((s) => ({ text: s.text, completed: s.completed })),
    relations: (task.relations ?? []).map((r) => ({ type: r.type, taskId: r.taskId })),
    column,
    tags: task.tags ?? [],
    priority: task.priority ?? "medium",
  };
}

// ── Task reading ─────────────────────────────────────────────────────────

export async function getTaskJson(repoPath: string, taskId: string): Promise<TaskInfo | null> {
  if (!taskId) return null;
  return withRoot(repoPath, async () => {
    try {
      const { tasks } = await getAllTasksWithColumns();
      const found = tasks.find((t) => t.id === taskId);
      if (found) return taskToInfo(found, found.column);
      // Fallback: try reading directly
      const task = await readTask(taskId);
      return taskToInfo(task);
    } catch {
      return null;
    }
  });
}

export async function getTaskColumn(repoPath: string, taskId: string): Promise<string | null> {
  return withRoot(repoPath, async () => {
    try {
      const index = await readIndex();
      for (const col of index.columns) {
        if ((index.tasksByColumn[col] ?? []).includes(taskId)) return col;
      }
      return null;
    } catch {
      return null;
    }
  });
}

// ── Board helpers ────────────────────────────────────────────────────────

export async function getBoardJson(repoPath: string): Promise<BoardJson | null> {
  return withRoot(repoPath, async () => {
    try {
      const { tasks, index } = await getAllTasksWithColumns();
      const byColumn = new Map<string, TaskInfo[]>();
      for (const col of index.columns) byColumn.set(col, []);

      for (const t of tasks) {
        const col = t.column ?? "";
        const arr = byColumn.get(col);
        if (arr) arr.push(taskToInfo(t, col));
      }

      return {
        headings: index.columns.map((name) => ({ name })),
        lanes: [{ columns: index.columns.map((col) => byColumn.get(col) ?? []) }],
        startedColumns: index.startedColumns,
        completedColumns: index.completedColumns,
      };
    } catch {
      return null;
    }
  });
}

export function getColumnIndex(board: BoardJson, columnName: string): number {
  return board.headings.findIndex((h) => h.name.toLowerCase() === columnName.toLowerCase());
}

// ── Subtask helpers (pure, operate on TaskInfo) ──────────────────────────

export function getFirstIncompleteSubTask(task: TaskInfo | null): string | null {
  if (!task?.subTasks) return null;
  const st = task.subTasks.find((s) => !s.completed);
  return st ? st.text : null;
}

export function allSubTasksComplete(task: TaskInfo | null): boolean {
  if (!task?.subTasks?.length) return true;
  return task.subTasks.every((s) => s.completed);
}

export function isSubTaskComplete(task: TaskInfo | null, subTaskText: string): boolean {
  if (!subTaskText || !task?.subTasks) return false;
  const st = task.subTasks.find((s) => s.text === subTaskText);
  return st ? st.completed : false;
}

// ── Task operations ──────────────────────────────────────────────────────

export async function moveKanbanTask(repoPath: string, taskId: string, column: string): Promise<boolean> {
  return withRoot(repoPath, async () => {
    try {
      await moveTask(taskId, column);
      return true;
    } catch {
      return false;
    }
  });
}

export async function editKanbanTask(
  repoPath: string,
  taskId: string,
  updates: Partial<Pick<Task, "title" | "description" | "priority" | "assignee" | "tags">>,
): Promise<boolean> {
  return withRoot(repoPath, async () => {
    try {
      await editTask(taskId, updates);
      return true;
    } catch {
      return false;
    }
  });
}

export async function completeSubTaskInRepo(repoPath: string, taskId: string, subTaskText: string): Promise<boolean> {
  if (!subTaskText) return false;
  return withRoot(repoPath, async () => {
    try {
      const task = await readTask(taskId);
      const idx = task.subtasks.findIndex((s) => s.text === subTaskText);
      if (idx === -1) {
        // Check if already complete
        return task.subtasks.some((s) => s.text === subTaskText && s.completed);
      }
      if (task.subtasks[idx].completed) return true;
      task.subtasks[idx].completed = true;
      await writeTask(task);
      return true;
    } catch {
      return false;
    }
  });
}

// ── Board state checks ──────────────────────────────────────────────────

export async function isBoardComplete(repoPath: string): Promise<boolean> {
  const board = await getBoardJson(repoPath);
  if (!board) return false;

  const doneIndex = getColumnIndex(board, "Done");
  if (doneIndex < 0) return false;

  for (const lane of board.lanes) {
    for (let c = 0; c < lane.columns.length; c++) {
      if (c !== doneIndex && lane.columns[c].length > 0) return false;
      if (c === doneIndex) {
        for (const task of lane.columns[c]) {
          if (!allSubTasksComplete(task)) return false;
        }
      }
    }
  }
  return true;
}

export async function repairDoneCardsWithIncompleteSubTasks(repoPath: string): Promise<void> {
  const board = await getBoardJson(repoPath);
  if (!board) return;

  const doneIndex = getColumnIndex(board, "Done");
  if (doneIndex < 0) return;

  let repaired = 0;
  const seen = new Set<string>();

  for (const lane of board.lanes) {
    if (doneIndex >= lane.columns.length) continue;
    for (const task of lane.columns[doneIndex]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);

      if (!allSubTasksComplete(task)) {
        await moveKanbanTask(repoPath, task.id, "In Progress");
        log(`Moved ${task.id} from Done to In Progress (incomplete subtasks)`, "WARN");
        repaired++;
      }
    }
  }

  if (repaired > 0) {
    log(`Repaired ${repaired} Done task(s) with incomplete subtasks`, "WARN");
  }
}

// ── Task claiming ────────────────────────────────────────────────────────

interface Candidate {
  taskId: string;
  taskObj: TaskInfo | null;
  columnRank: number;
  isBlocked: boolean;
  hasPriority: boolean;
  isBlocker: boolean;
}

function getBlockerTaskIds(
  taskObj: TaskInfo | null,
  taskId: string,
  doneTasks: Set<string>,
  prTasks: Set<string>,
  reverseBlockedBy: Map<string, string[]>,
): string[] {
  const ids: string[] = [];

  if (taskObj?.relations) {
    for (const rel of taskObj.relations) {
      if (/^blocked|^requires/i.test(rel.type)) {
        let bid = rel.taskId;
        const byMatch = bid.match(/^by\s+(.+)$/i);
        if (byMatch) bid = byMatch[1];
        if (bid && !doneTasks.has(bid) && !prTasks.has(bid)) ids.push(bid);
      }
    }
  }

  if (taskId && reverseBlockedBy.has(taskId)) {
    for (const bid of reverseBlockedBy.get(taskId)!) {
      if (!doneTasks.has(bid) && !prTasks.has(bid) && !ids.includes(bid)) ids.push(bid);
    }
  }

  return ids;
}

function hasPriorityFlag(task: TaskInfo | null): boolean {
  if (!task) return false;
  if (task.tags?.some((t) => t.toLowerCase() === "priority")) return true;
  if (["high", "critical"].includes(task.priority)) return true;
  return false;
}

export function getCheckedOutTaskBranches(
  excludeWorkerId: number,
  worktrees: Map<number, string>,
): Map<string, number> {
  const checkedOut = new Map<string, number>();

  for (const [wid, path] of worktrees) {
    if (wid === excludeWorkerId) continue;
    const { stdout } = gitSync(path, "rev-parse", "--abbrev-ref", "HEAD");
    const branchMatch = stdout.match(/^ralph\/(.+)$/);
    if (branchMatch) checkedOut.set(branchMatch[1], wid);
  }

  return checkedOut;
}

export async function claimNextTask(
  state: OrchestratorState,
  workerId: number,
  worktrees: Map<number, string>,
): Promise<ClaimResult | null> {
  const board = await getBoardJson(state.mainRepo);
  if (!board) {
    log(`Failed to read kanban board`, "ERROR");
    return null;
  }

  // Get branches checked out by other workers
  const checkedOutBranches = new Map<string, number>();
  for (const [wid, path] of worktrees) {
    if (wid === workerId) continue;
    const { stdout } = gitSync(path, "rev-parse", "--abbrev-ref", "HEAD");
    const branchMatch = stdout.match(/^ralph\/(.+)$/);
    if (branchMatch) checkedOutBranches.set(branchMatch[1], wid);
  }

  const inProgressIndex = getColumnIndex(board, "In Progress");
  const todoIndex = getColumnIndex(board, "Todo");
  const backlogIndex = getColumnIndex(board, "Backlog");
  const doneIndex = getColumnIndex(board, "Done");

  // Build done set
  const doneTasks = new Set<string>();
  if (doneIndex >= 0) {
    for (const lane of board.lanes) {
      if (doneIndex >= lane.columns.length) continue;
      for (const t of lane.columns[doneIndex]) doneTasks.add(t.id);
    }
  }
  for (const tid of state.completedTasks) doneTasks.add(tid);

  // Build PR set
  const prTasks = new Set<string>();
  const { stdout: prBranches, exitCode: prExit } = ghSync("pr", "list", "--json", "headRefName", "--jq", ".[].headRefName");
  if (prExit === 0 && prBranches) {
    for (const br of prBranches.split("\n")) {
      const m = br.match(/^ralph\/(.+)$/);
      if (m) prTasks.add(m[1]);
    }
  }

  // Build candidate list
  const candidates: Candidate[] = [];
  const reverseBlockedBy = new Map<string, string[]>();
  let columnRank = 0;

  for (const targetColumn of [inProgressIndex, todoIndex, backlogIndex]) {
    if (targetColumn < 0) { columnRank++; continue; }

    for (const lane of board.lanes) {
      if (targetColumn >= lane.columns.length) continue;
      for (const task of lane.columns[targetColumn]) {
        // Build reverse blocker map
        if (task.relations) {
          for (const rel of task.relations) {
            if (rel.type.toLowerCase() === "blocks") {
              const existing = reverseBlockedBy.get(rel.taskId) ?? [];
              existing.push(task.id);
              reverseBlockedBy.set(rel.taskId, existing);
            }
          }
        }

        if (state.claimedTasks.has(task.id)) continue;
        if (state.completedTasks.has(task.id)) continue;
        if (checkedOutBranches.has(task.id)) continue;

        candidates.push({
          taskId: task.id,
          taskObj: task,
          columnRank,
          isBlocked: false,
          hasPriority: hasPriorityFlag(task),
          isBlocker: false,
        });
      }
    }
    columnRank++;
  }

  if (candidates.length === 0) return null;

  // Determine blocked/blocker status
  const isBlockingOthers = new Set<string>();
  for (const c of candidates) {
    const blockerIds = getBlockerTaskIds(c.taskObj, c.taskId, doneTasks, prTasks, reverseBlockedBy);
    c.isBlocked = blockerIds.length > 0;
    for (const bid of blockerIds) isBlockingOthers.add(bid);
  }
  for (const c of candidates) c.isBlocker = isBlockingOthers.has(c.taskId);

  // Sort: unblocked first, blockers first, priority first, earlier column first
  candidates.sort((a, b) => {
    if (a.isBlocked !== b.isBlocked) return a.isBlocked ? 1 : -1;
    if (a.isBlocker !== b.isBlocker) return a.isBlocker ? -1 : 1;
    if (a.hasPriority !== b.hasPriority) return a.hasPriority ? -1 : 1;
    return a.columnRank - b.columnRank;
  });

  let chosen = candidates[0];

  // If chosen is blocked, traverse blocker graph to find unblocked leaf
  if (chosen.isBlocked) {
    const visited = new Set<string>([chosen.taskId]);
    const frontier: string[] = [];
    for (const bid of getBlockerTaskIds(chosen.taskObj, chosen.taskId, doneTasks, prTasks, reverseBlockedBy)) {
      if (!visited.has(bid)) { visited.add(bid); frontier.push(bid); }
    }

    const leafCandidates: Candidate[] = [];
    while (frontier.length > 0) {
      const curId = frontier.shift()!;
      if (doneTasks.has(curId) || state.claimedTasks.has(curId) || state.completedTasks.has(curId) || checkedOutBranches.has(curId)) continue;

      const existing = candidates.find((c) => c.taskId === curId);
      const curObj = existing?.taskObj ?? await getTaskJson(state.mainRepo, curId);
      if (!curObj) continue;

      const curBlockers = getBlockerTaskIds(curObj, curId, doneTasks, prTasks, reverseBlockedBy);
      if (curBlockers.length === 0) {
        leafCandidates.push({
          taskId: curId,
          taskObj: curObj,
          columnRank: existing?.columnRank ?? 2,
          isBlocked: false,
          hasPriority: hasPriorityFlag(curObj),
          isBlocker: isBlockingOthers.has(curId),
        });
      } else {
        for (const bid of curBlockers) {
          if (!visited.has(bid)) { visited.add(bid); frontier.push(bid); }
        }
      }
    }

    if (leafCandidates.length > 0) {
      leafCandidates.sort((a, b) => {
        if (a.isBlocker !== b.isBlocker) return a.isBlocker ? -1 : 1;
        if (a.hasPriority !== b.hasPriority) return a.hasPriority ? -1 : 1;
        return a.columnRank - b.columnRank;
      });
      chosen = leafCandidates[0];
      log(`Worker ${workerId} resolved blocker graph -> unblocked task ${chosen.taskId}`);
    } else {
      log(`Worker ${workerId} picking blocked task ${chosen.taskId} (no claimable unblocked blockers)`, "WARN");
    }
  }

  const taskId = chosen.taskId;
  const taskObj = chosen.taskObj;
  const claimedSubTask = getFirstIncompleteSubTask(taskObj);

  await moveKanbanTask(state.mainRepo, taskId, "In Progress");
  await editKanbanTask(state.mainRepo, taskId, { assignee: `ralph-worker-${workerId}` });

  state.claimedTasks.set(taskId, workerId);
  if (claimedSubTask) {
    state.claimedSubTasks.set(taskId, claimedSubTask);
    log(`Worker ${workerId} claimed task: ${taskId} (subtask: ${claimedSubTask})`, "OK");
  } else {
    state.claimedSubTasks.delete(taskId);
    log(`Worker ${workerId} claimed task: ${taskId}`, "OK");
  }

  return { taskId, claimedSubTask };
}

export async function releaseTaskClaim(state: OrchestratorState, taskId: string): Promise<void> {
  state.claimedTasks.delete(taskId);
  state.claimedSubTasks.delete(taskId);
  await editKanbanTask(state.mainRepo, taskId, { assignee: "" });
}
