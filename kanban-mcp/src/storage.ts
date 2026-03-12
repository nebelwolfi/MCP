import { readFile, writeFile, readdir, mkdir, rm, access, unlink } from "node:fs/promises";
import { openSync, closeSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Task, BoardIndex } from "./types.js";
import { TASKS_DIR, INDEX_FILE, VERSION_FILE, BOARD_VERSION, DEFAULT_COLUMNS, BOARDS_ROOT, V1_CONFIG_FILE, V1_TASKS_INDEX_FILE } from "./constants.js";
import { cwd, boardPath, now } from "./helpers.js";
import {
  parseFrontmatter, toMarkdown,
  parseSubtasks, parseRelations,
  taskToYaml, taskFromYaml, indexToYaml, indexFromYaml,
} from "./parsers.js";

const LOCK_FILE = ".lock";
const OLD_KANBN_DIR = ".kanbn";

// ── Git init for boards root ────────────────────────────────────────────

let boardsRootChecked = false;

async function ensureBoardsRootGit(): Promise<void> {
  if (boardsRootChecked) return;
  const root = join(homedir(), BOARDS_ROOT);
  await mkdir(root, { recursive: true });
  const gitDir = join(root, ".git");
  try {
    await access(gitDir);
  } catch {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  }
  boardsRootChecked = true;
}

// ── Locking ────────────────────────────────────────────────────────────

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureBoardsRootGit();
  const lockPath = boardPath(LOCK_FILE);
  await mkdir(boardPath(), { recursive: true });
  const deadline = Date.now() + 10_000;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      break;
    } catch {
      if (Date.now() > deadline) {
        try { unlinkSync(lockPath); } catch {}
        continue;
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

// ── Board existence ────────────────────────────────────────────────────

export async function boardExists(): Promise<boolean> {
  try { await access(boardPath(INDEX_FILE)); return true; } catch {}
  // Also check v1 format
  try { await access(boardPath(V1_CONFIG_FILE)); return true; } catch {}
  return false;
}

// ── Index I/O (v2: index.yaml) ─────────────────────────────────────────

export async function readIndex(): Promise<BoardIndex> {
  // Try v2 format first
  try {
    const content = await readFile(boardPath(INDEX_FILE), "utf-8");
    return indexFromYaml(content);
  } catch {}

  // Fall back to v1 format (config.md + tasks.md)
  return readIndexV1();
}

export async function writeIndex(index: BoardIndex): Promise<void> {
  await mkdir(boardPath(), { recursive: true });
  await writeFile(boardPath(INDEX_FILE), indexToYaml(index));
}

// ── Task I/O (v2: flat yaml files) ─────────────────────────────────────

function taskFile(id: string): string {
  return boardPath(TASKS_DIR, `${id}.yaml`);
}

function taskDirV1(id: string): string {
  return boardPath(TASKS_DIR, id);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try { return await readFile(path, "utf-8"); } catch { return ""; }
}

export async function readTask(id: string): Promise<Task> {
  // Try v2 format first (flat yaml)
  try {
    const content = await readFile(taskFile(id), "utf-8");
    return taskFromYaml(content, id);
  } catch {}

  // Fall back to v1 format (folder with .md files)
  return readTaskV1(id);
}

export async function writeTask(task: Task): Promise<void> {
  await mkdir(boardPath(TASKS_DIR), { recursive: true });
  await writeFile(taskFile(task.id), taskToYaml(task));
}

export async function deleteTaskFile(id: string): Promise<void> {
  // Delete v2 file
  try { await unlink(taskFile(id)); } catch {}
  // Also clean up legacy v1 folder if it exists
  try { await rm(taskDirV1(id), { recursive: true, force: true }); } catch {}
}

// ── Listing helpers ────────────────────────────────────────────────────

export async function listTaskIds(): Promise<string[]> {
  try {
    const index = await readIndex();
    return index.columns.flatMap((c) => index.tasksByColumn[c] ?? []);
  } catch { return []; }
}

export async function getAllTasksWithColumns(): Promise<{ tasks: (Task & { column: string })[]; index: BoardIndex }> {
  const index = await readIndex();
  const tasks: (Task & { column: string })[] = [];
  for (const col of index.columns) {
    for (const id of (index.tasksByColumn[col] ?? [])) {
      try {
        tasks.push({ ...(await readTask(id)), column: col });
      } catch { /* skip missing */ }
    }
  }
  return { tasks, index };
}

export async function listOrphanedFiles(): Promise<string[]> {
  try {
    const entries = await readdir(boardPath(TASKS_DIR), { withFileTypes: true });
    const index = await readIndex();
    const indexed = new Set(index.columns.flatMap((c) => index.tasksByColumn[c] ?? []));
    const orphans: string[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".yaml")) {
        const id = e.name.replace(/\.yaml$/, "");
        if (!indexed.has(id)) orphans.push(id);
      } else if (e.isDirectory()) {
        // Legacy v1 folder
        if (!indexed.has(e.name)) orphans.push(e.name);
      }
    }
    return orphans;
  } catch { return []; }
}

// ── Board initialization + auto-migration ──────────────────────────────

export async function ensureBoard(): Promise<void> {
  await ensureBoardsRootGit();

  // Check for existing v2 board
  try {
    await access(boardPath(INDEX_FILE));
    return;
  } catch {}

  // Check for v1 board to migrate
  try {
    await access(boardPath(V1_CONFIG_FILE));
    await migrateFromV1();
    return;
  } catch {}

  // Check for old-format (v0) board to migrate
  const oldIndexPath = join(cwd(), OLD_KANBN_DIR, "index.md");
  try {
    await access(oldIndexPath);
    await migrateFromV0(join(cwd(), OLD_KANBN_DIR));
    return;
  } catch {}

  // Create fresh v2 board
  await mkdir(boardPath(TASKS_DIR), { recursive: true });
  await writeFile(boardPath(VERSION_FILE), BOARD_VERSION);

  const index: BoardIndex = {
    name: basename(cwd()),
    columns: [...DEFAULT_COLUMNS],
    tasksByColumn: Object.fromEntries(DEFAULT_COLUMNS.map((c) => [c, []])),
    startedColumns: ["In Progress"],
    completedColumns: ["Done"],
  };
  await writeIndex(index);
}

// ── V1 reading helpers (used by migration and fallback) ────────────────

async function readConfigV1(): Promise<{ name: string; startedColumns: string[]; completedColumns: string[] }> {
  const content = await readFile(boardPath(V1_CONFIG_FILE), "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const nameMatch = body.match(/^# (.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : basename(cwd());

  return {
    name,
    startedColumns: Array.isArray(frontmatter.startedColumns) ? frontmatter.startedColumns as string[] : [],
    completedColumns: Array.isArray(frontmatter.completedColumns) ? frontmatter.completedColumns as string[] : [],
  };
}

async function readTasksIndexV1(): Promise<{ columns: string[]; tasksByColumn: Record<string, string[]> }> {
  const content = await readFile(boardPath(V1_TASKS_INDEX_FILE), "utf-8");

  const columns: string[] = [];
  const tasksByColumn: Record<string, string[]> = {};
  const h2Regex = /^## (.+)$/gm;
  const h2Positions: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = h2Regex.exec(content)) !== null) {
    h2Positions.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < h2Positions.length; i++) {
    const col = h2Positions[i].name;
    columns.push(col);
    tasksByColumn[col] = [];

    const sectionText = content.slice(
      h2Positions[i].end,
      i + 1 < h2Positions.length ? h2Positions[i + 1].start : content.length
    );

    const linkRegex = /^- \[([^\]]+)\]\(tasks\/([^/]+)\/(task\.md|task\.yaml)\)/gm;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(sectionText)) !== null) {
      tasksByColumn[col].push(lm[2]);
    }
  }

  return { columns, tasksByColumn };
}

async function readIndexV1(): Promise<BoardIndex> {
  const config = await readConfigV1();
  const tasksIdx = await readTasksIndexV1();

  return {
    name: config.name,
    columns: tasksIdx.columns,
    tasksByColumn: tasksIdx.tasksByColumn,
    startedColumns: config.startedColumns,
    completedColumns: config.completedColumns,
  };
}

async function readTaskV1(id: string): Promise<Task> {
  const dir = taskDirV1(id);
  const taskMd = await readFile(join(dir, "task.md"), "utf-8");
  const { frontmatter, body } = parseFrontmatter(taskMd);

  const titleMatch = body.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  const detailsContent = await readFileOrEmpty(join(dir, "details.md"));
  const subtasksContent = await readFileOrEmpty(join(dir, "subtasks.md"));
  const relationsContent = await readFileOrEmpty(join(dir, "relations.md"));

  return {
    id,
    title,
    description: detailsContent.trim(),
    subtasks: parseSubtasks(subtasksContent),
    relations: parseRelations(relationsContent),
    created: (frontmatter.created as string) ?? now(),
    updated: (frontmatter.updated as string) ?? now(),
    started: frontmatter.started as string | undefined,
    completed: frontmatter.completed as string | undefined,
    priority: (frontmatter.priority as Task["priority"]) ?? "medium",
    assignee: (frontmatter.assignee as string) ?? "",
    tags: Array.isArray(frontmatter.tags)
      ? frontmatter.tags as string[]
      : frontmatter.tags ? [frontmatter.tags as string] : [],
  };
}

// ── Migration from v1 (config.md + tasks.md + task folders) ────────────

async function migrateFromV1(): Promise<void> {
  const index = await readIndexV1();

  // Migrate each task: read from v1 folder, write as flat yaml
  for (const col of index.columns) {
    for (const id of (index.tasksByColumn[col] ?? [])) {
      try {
        const task = await readTaskV1(id);
        await writeTask(task);
        // Remove old task folder
        await rm(taskDirV1(id), { recursive: true, force: true });
      } catch { /* skip unreadable tasks */ }
    }
  }

  // Write v2 index
  await writeIndex(index);

  // Update version
  await writeFile(boardPath(VERSION_FILE), BOARD_VERSION);

  // Clean up old v1 files
  try { await unlink(boardPath(V1_CONFIG_FILE)); } catch {}
  try { await unlink(boardPath(V1_TASKS_INDEX_FILE)); } catch {}
}

// ── Migration from v0 (.kanbn/) ────────────────────────────────────────

async function migrateFromV0(oldRoot: string): Promise<void> {
  const { generateTaskId } = await import("./helpers.js");

  // Read old index
  const oldIndexContent = await readFile(join(oldRoot, "index.md"), "utf-8");
  const { frontmatter, body } = parseFrontmatter(oldIndexContent);

  const nameMatch = body.match(/^# (.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : basename(cwd());

  const startedColumns = Array.isArray(frontmatter.startedColumns) ? frontmatter.startedColumns as string[] : [];
  const completedColumns = Array.isArray(frontmatter.completedColumns) ? frontmatter.completedColumns as string[] : [];

  // Parse old columns and task IDs
  const columns: string[] = [];
  const oldTasksByColumn: Record<string, string[]> = {};
  const h2Regex = /^## (.+)$/gm;
  const h2Positions: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = h2Regex.exec(body)) !== null) {
    h2Positions.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < h2Positions.length; i++) {
    const col = h2Positions[i].name;
    columns.push(col);
    oldTasksByColumn[col] = [];

    const sectionText = body.slice(
      h2Positions[i].end,
      i + 1 < h2Positions.length ? h2Positions[i + 1].start : body.length
    );

    const linkRegex = /^- \[([^\]]+)\]\(tasks\/[^)]+\.md\)/gm;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(sectionText)) !== null) {
      oldTasksByColumn[col].push(lm[1]);
    }
  }

  // Create new board structure
  await mkdir(boardPath(TASKS_DIR), { recursive: true });

  // Migrate tasks: read old files, assign new IDs
  const oldToNewId: Record<string, string> = {};
  const migratedTasks: Task[] = [];

  for (const col of columns) {
    for (const oldId of (oldTasksByColumn[col] ?? [])) {
      try {
        const oldContent = await readFile(join(oldRoot, "tasks", `${oldId}.md`), "utf-8");
        const { frontmatter: taskFm, body: taskBody } = parseFrontmatter(oldContent);

        const titleMatch = taskBody.match(/^# (.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : oldId;

        // Parse old-format body (has ## Sub-tasks and ## Relations inline)
        const stripped = taskBody.replace(/\n---\r?\n[\s\S]*?\r?\n---/g, "").trim();
        const bodyWithoutTitle = stripped.replace(/^# .+\n*/, "").trim().replace(/^# .+\n*/, "").trim();

        // Extract relations (old format)
        const relMatch = bodyWithoutTitle.match(/\n*## Relations\r?\n([\s\S]*?)(?:\n## |\s*$)/);
        let relationsRaw: { type: string; taskId: string }[] = [];
        let bodyNoRelations = bodyWithoutTitle;
        if (relMatch) {
          for (const line of relMatch[1].split("\n")) {
            const linkM = line.match(/^- \[([^\]]+)\]\([^)]+\)$/);
            const bracketM = !linkM && line.match(/^- \[([^\]]+)\]$/);
            const text = linkM ? linkM[1].trim() : bracketM ? bracketM[1].trim() : null;
            if (!text) continue;
            const parts = text.split(" ");
            const type = parts.length > 1 ? parts[0] : "";
            const taskId = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
            relationsRaw.push({ type, taskId });
          }
          bodyNoRelations = bodyWithoutTitle.replace(/\n*## Relations[\s\S]*?(?:\n## |$)/, "").trim();
        }

        // Extract subtasks (old format)
        const subMatch = bodyNoRelations.match(/## Sub-tasks\r?\n([\s\S]*?)(?:\n## |\n*$)/);
        let subtasks: { text: string; completed: boolean }[] = [];
        let description = bodyNoRelations;
        if (subMatch) {
          for (const line of subMatch[1].split("\n")) {
            const sm = line.match(/^- \[([ xX])\] (.+)$/);
            if (sm) subtasks.push({ text: sm[2].trim(), completed: sm[1] !== " " });
          }
          description = bodyNoRelations.replace(/\n*## Sub-tasks[\s\S]*/, "").trim();
        }

        const newId = generateTaskId();
        oldToNewId[oldId] = newId;

        migratedTasks.push({
          id: newId,
          title,
          description,
          subtasks,
          relations: relationsRaw,
          created: (taskFm.created as string) ?? now(),
          updated: (taskFm.updated as string) ?? now(),
          started: taskFm.started as string | undefined,
          completed: taskFm.completed as string | undefined,
          priority: (taskFm.priority as Task["priority"]) ?? "medium",
          assignee: (taskFm.assignee as string) ?? "",
          tags: Array.isArray(taskFm.tags)
            ? taskFm.tags as string[]
            : taskFm.tags ? [taskFm.tags as string] : [],
        });
      } catch { /* skip unreadable tasks */ }
    }
  }

  // Remap relation taskIds from old to new
  for (const task of migratedTasks) {
    for (const rel of task.relations) {
      if (oldToNewId[rel.taskId]) {
        rel.taskId = oldToNewId[rel.taskId];
      }
    }
  }

  // Write migrated tasks as v2 flat yaml files
  for (const task of migratedTasks) {
    await writeTask(task);
  }

  // Build v2 index
  const newTasksByColumn: Record<string, string[]> = {};
  for (const col of columns) {
    newTasksByColumn[col] = (oldTasksByColumn[col] ?? [])
      .map((oldId) => oldToNewId[oldId])
      .filter(Boolean);
  }

  const index: BoardIndex = {
    name,
    columns,
    tasksByColumn: newTasksByColumn,
    startedColumns,
    completedColumns,
  };
  await writeIndex(index);
  await writeFile(boardPath(VERSION_FILE), BOARD_VERSION);

  // Rename old board to .kanbn.bak
  const { rename } = await import("node:fs/promises");
  try {
    await rename(oldRoot, oldRoot.replace(/\.kanbn$/, ".kanbn.bak"));
  } catch { /* best effort */ }
}
