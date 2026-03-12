import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Frontmatter, Subtask, Relation, TaskInfo, BoardIndex, BoardJson, ClaimResult, OrchestratorState } from "./types.js";
import { log } from "./logger.js";
import { ghSync } from "./git.js";

// ── Frontmatter parsing ────────────────────────────────────────────────

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };

  const lines = match[1].split("\n");
  const fm: Frontmatter = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line) { i++; continue; }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "" && i + 1 < lines.length && /^\s+-/.test(lines[i + 1])) {
      const arr: string[] = [];
      i++;
      while (i < lines.length && /^\s+-/.test(lines[i])) {
        arr.push(lines[i].replace(/^\s+-\s*/, "").trim().replace(/^['"]|['"]$/g, ""));
        i++;
      }
      fm[key] = arr;
      continue;
    }

    const arrMatch = rest.match(/^\[(.*)\]$/);
    if (arrMatch) {
      fm[key] = arrMatch[1]
        ? arrMatch[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
        : [];
    } else {
      fm[key] = rest.replace(/^['"]|['"]$/g, "");
    }
    i++;
  }

  return { frontmatter: fm, body: match[2].trim() };
}

// ── Task reading ────────────────────────────────────────────────────────

export function readTaskDirect(repoPath: string, taskId: string, column = ""): TaskInfo | null {
  const taskPath = join(repoPath, ".kanbn", "tasks", `${taskId}.md`);
  if (!existsSync(taskPath)) return null;

  let raw: string;
  try { raw = readFileSync(taskPath, "utf-8"); } catch { return null; }

  const { frontmatter: fm, body } = parseFrontmatter(raw);

  let title = taskId;
  const titleMatch = body.match(/(?:^|\n)# (.+)$/m);
  if (titleMatch) title = titleMatch[1].trim();

  const stripped = body.replace(/\n---\r?\n[\s\S]*?\r?\n---/g, "").replace(/(?:^|\n)# .+\n*/g, "").trim();

  // Parse relations
  const relations: Relation[] = [];
  const relMatch = stripped.match(/(## Relations\r?\n)([\s\S]*?)(?=\n## |\s*$)/);
  if (relMatch) {
    for (const line of relMatch[2].split("\n")) {
      const linkM = line.match(/^- \[([^\]]+)\]\([^)]+\)$/);
      const bracketM = !linkM ? line.match(/^- \[([^\]]+)\]$/) : null;
      const text = linkM ? linkM[1].trim() : bracketM ? bracketM[1].trim() : null;
      if (!text) continue;
      const parts = text.split(/\s+/, 2);
      if (parts.length > 1) {
        relations.push({ type: parts[0], taskId: parts[1] });
      } else {
        relations.push({ type: "", taskId: parts[0] });
      }
    }
  }

  // Parse subtasks
  const subTasks: Subtask[] = [];
  const subMatch = stripped.match(/(## Sub-tasks\r?\n)([\s\S]*?)(?=\n## |\s*$)/);
  if (subMatch) {
    for (const line of subMatch[2].split("\n")) {
      const m = line.match(/^- \[([ xX])\] (.+)$/);
      if (m) subTasks.push({ text: m[2].trim(), completed: m[1] !== " " });
    }
  }

  // Tags
  let tags: string[] = [];
  if (fm.tags) {
    tags = Array.isArray(fm.tags) ? fm.tags as string[] : [fm.tags as string];
  }

  const priority = (fm.priority as string) ?? "medium";

  return { id: taskId, title, subTasks, relations, column, tags, priority };
}

// ── Index read/write ────────────────────────────────────────────────────

export function readKanbanIndex(repoPath: string): BoardIndex | null {
  const indexPath = join(repoPath, ".kanbn", "index.md");
  if (!existsSync(indexPath)) return null;

  let raw: string;
  try { raw = readFileSync(indexPath, "utf-8"); } catch { return null; }

  const { frontmatter: fm, body } = parseFrontmatter(raw);

  let name = "";
  const nameMatch = body.match(/(?:^|\n)# (.+)$/m);
  if (nameMatch) name = nameMatch[1].trim();

  const startedColumns = Array.isArray(fm.startedColumns) ? fm.startedColumns as string[] : ["In Progress"];
  const completedColumns = Array.isArray(fm.completedColumns) ? fm.completedColumns as string[] : ["Done"];

  const columns: string[] = [];
  const tasksByColumn: Record<string, string[]> = {};

  const h2Regex = /^## (.+)$/gm;
  const h2Positions: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = h2Regex.exec(body)) !== null) {
    h2Positions.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < h2Positions.length; i++) {
    const colName = h2Positions[i].name;
    columns.push(colName);
    tasksByColumn[colName] = [];

    const section = body.slice(
      h2Positions[i].end,
      i + 1 < h2Positions.length ? h2Positions[i + 1].start : body.length,
    );

    const linkRegex = /^- \[([^\]]+)\]\(tasks\/[^)]+\.md\)/gm;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(section)) !== null) {
      tasksByColumn[colName].push(lm[1].trim());
    }
  }

  return { name, columns, tasksByColumn, startedColumns, completedColumns };
}

export function writeKanbanIndex(repoPath: string, index: BoardIndex): void {
  const indexPath = join(repoPath, ".kanbn", "index.md");
  let fmStr = "";

  if (index.startedColumns.length > 0) {
    fmStr += "startedColumns:\n";
    for (const sc of index.startedColumns) fmStr += `  - '${sc}'\n`;
  }
  if (index.completedColumns.length > 0) {
    fmStr += "completedColumns:\n";
    for (const cc of index.completedColumns) fmStr += `  - '${cc}'\n`;
  }

  let content = `---\n${fmStr}---\n\n# ${index.name}\n`;
  for (const col of index.columns) {
    const tasks = index.tasksByColumn[col] ?? [];
    content += `\n## ${col}\n`;
    if (tasks.length > 0) {
      content += "\n";
      for (const tid of tasks) content += `- [${tid}](tasks/${tid}.md)\n`;
    }
  }

  writeFileSync(indexPath, content, "utf-8");
}

// ── Task operations ────────────────────────────────────────────────────

export function moveKanbanTask(repoPath: string, taskId: string, column: string): boolean {
  const index = readKanbanIndex(repoPath);
  if (!index) return false;
  if (!index.columns.includes(column)) return false;

  // Remove from all columns
  for (const col of index.columns) {
    index.tasksByColumn[col] = (index.tasksByColumn[col] ?? []).filter((t) => t !== taskId);
  }
  // Add to target column
  (index.tasksByColumn[column] ??= []).push(taskId);
  writeKanbanIndex(repoPath, index);

  // Update task frontmatter timestamps
  const taskPath = join(repoPath, ".kanbn", "tasks", `${taskId}.md`);
  if (existsSync(taskPath)) {
    try {
      let taskRaw = readFileSync(taskPath, "utf-8");
      const fmMatch = taskRaw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fmMatch) {
        let fmBlock = fmMatch[1];
        const now = new Date().toISOString();

        if (/^updated:/m.test(fmBlock)) {
          fmBlock = fmBlock.replace(/^updated:.*$/m, `updated: ${now}`);
        } else {
          fmBlock += `\nupdated: ${now}`;
        }

        if (index.startedColumns.includes(column) && !/^started:/m.test(fmBlock)) {
          fmBlock += `\nstarted: ${now}`;
        }
        if (index.completedColumns.includes(column) && !/^completed:/m.test(fmBlock)) {
          fmBlock += `\ncompleted: ${now}`;
        }

        if (fmBlock !== fmMatch[1]) {
          taskRaw = taskRaw.slice(0, fmMatch.index!) + `---\n${fmBlock}\n---` + taskRaw.slice(fmMatch.index! + fmMatch[0].length);
          writeFileSync(taskPath, taskRaw, "utf-8");
        }
      }
    } catch { /* best effort */ }
  }

  return true;
}

export function completeSubTaskInRepo(repoPath: string, taskId: string, subTaskText: string): boolean {
  if (!subTaskText) return false;
  const taskFile = join(repoPath, ".kanbn", "tasks", `${taskId}.md`);
  if (!existsSync(taskFile)) return false;

  const content = readFileSync(taskFile, "utf-8");
  const escaped = subTaskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*[-*]\\s*)\\[ \\](\\s+${escaped}\\s*$)`, "m");
  const newContent = content.replace(pattern, "$1[x]$2");

  if (newContent === content) {
    // Check if already complete
    const alreadyDone = new RegExp(`^\\s*[-*]\\s*\\[x\\]\\s+${escaped}\\s*$`, "m");
    return alreadyDone.test(content);
  }

  writeFileSync(taskFile, newContent, "utf-8");
  return true;
}

// ── Board helpers ────────────────────────────────────────────────────────

export function getBoardJson(repoPath: string): BoardJson | null {
  const index = readKanbanIndex(repoPath);
  if (!index) return null;

  const headings: { name: string }[] = [];
  const colArrays: TaskInfo[][] = [];

  for (const colName of index.columns) {
    headings.push({ name: colName });
    const taskObjs: TaskInfo[] = [];

    for (const tid of index.tasksByColumn[colName] ?? []) {
      const taskObj = readTaskDirect(repoPath, tid, colName);
      if (taskObj) {
        taskObjs.push(taskObj);
      } else {
        taskObjs.push({ id: tid, title: tid, column: colName, subTasks: [], relations: [], tags: [], priority: "medium" });
      }
    }
    colArrays.push(taskObjs);
  }

  return {
    headings,
    lanes: [{ columns: colArrays }],
    startedColumns: index.startedColumns,
    completedColumns: index.completedColumns,
  };
}

export function getColumnIndex(board: BoardJson, columnName: string): number {
  return board.headings.findIndex((h) => h.name.toLowerCase() === columnName.toLowerCase());
}

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

export function getTaskColumn(repoPath: string, taskId: string): string | null {
  const board = getBoardJson(repoPath);
  if (!board) return null;

  for (const lane of board.lanes) {
    for (let c = 0; c < lane.columns.length; c++) {
      for (const task of lane.columns[c]) {
        if (task.id === taskId) {
          return task.column || board.headings[c]?.name || null;
        }
      }
    }
  }
  return null;
}

export function getTaskJson(repoPath: string, taskId: string): TaskInfo | null {
  if (!taskId) return null;
  const task = readTaskDirect(repoPath, taskId);
  if (task) return task;

  const board = getBoardJson(repoPath);
  if (!board) return null;

  for (const lane of board.lanes) {
    for (const col of lane.columns) {
      for (const t of col) {
        if (t.id === taskId) return t;
      }
    }
  }
  return null;
}

// ── Board state checks ──────────────────────────────────────────────────

export function isBoardComplete(repoPath: string): boolean {
  const board = getBoardJson(repoPath);
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

export function repairDoneCardsWithIncompleteSubTasks(repoPath: string): void {
  const board = getBoardJson(repoPath);
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
        moveKanbanTask(repoPath, task.id, "In Progress");
        log(`Moved ${task.id} from Done to In Progress (incomplete subtasks)`, "WARN");
        repaired++;
      }
    }
  }

  if (repaired > 0) {
    log(`Repaired ${repaired} Done task(s) with incomplete subtasks`, "WARN");
  }
}

// ── Unicode sanitization ────────────────────────────────────────────────

export function sanitizeTaskFiles(repoPath: string): void {
  const taskDir = join(repoPath, ".kanbn", "tasks");
  if (!existsSync(taskDir)) return;

  for (const entry of readdirSync(taskDir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(taskDir, entry);
    const content = readFileSync(filePath, "utf-8");
    let result = content;

    result = result.replace(/\u2014/g, "-");   // em-dash
    result = result.replace(/\u2013/g, "-");   // en-dash
    result = result.replace(/\u2018/g, "'");   // left single quote
    result = result.replace(/\u2019/g, "'");   // right single quote
    result = result.replace(/\u201C/g, '"');   // left double quote
    result = result.replace(/\u201D/g, '"');   // right double quote
    result = result.replace(/ÔÇö/g, "-");      // corrupted em-dash
    result = result.replace(/ÔÇô/g, "-");      // corrupted en-dash

    if (result !== content) {
      writeFileSync(filePath, result, "utf-8");
      log(`Sanitized Unicode in task file: ${entry}`);
    }
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
  const { gitSync } = require("./git.js") as typeof import("./git.js");
  const checkedOut = new Map<string, number>();

  for (const [wid, path] of worktrees) {
    if (wid === excludeWorkerId) continue;
    const { stdout } = gitSync(path, "rev-parse", "--abbrev-ref", "HEAD");
    const branchMatch = stdout.match(/^ralph\/(.+)$/);
    if (branchMatch) checkedOut.set(branchMatch[1], wid);
  }

  return checkedOut;
}

export function claimNextTask(
  state: OrchestratorState,
  workerId: number,
  worktrees: Map<number, string>,
): ClaimResult | null {
  const { gitSync: gitSyncFn } = require("./git.js") as typeof import("./git.js");

  const board = getBoardJson(state.mainRepo);
  if (!board) {
    log("Failed to read kanbn board", "ERROR");
    return null;
  }

  // Get branches checked out by other workers
  const checkedOutBranches = new Map<string, number>();
  for (const [wid, path] of worktrees) {
    if (wid === workerId) continue;
    const { stdout } = gitSyncFn(path, "rev-parse", "--abbrev-ref", "HEAD");
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
      const curObj = existing?.taskObj ?? getTaskJson(state.mainRepo, curId);
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

  moveKanbanTask(state.mainRepo, taskId, "In Progress");

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

export function releaseTaskClaim(state: OrchestratorState, taskId: string): void {
  state.claimedTasks.delete(taskId);
  state.claimedSubTasks.delete(taskId);
}
