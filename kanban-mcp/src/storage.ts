import { readFile, writeFile, readdir, mkdir, rm, access } from "node:fs/promises";
import { openSync, closeSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Task, BoardIndex } from "./types.js";
import { TASKS_DIR, CONFIG_FILE, TASKS_INDEX_FILE, VERSION_FILE, BOARD_VERSION, DEFAULT_COLUMNS, BOARDS_ROOT } from "./constants.js";
import { cwd, boardPath, now } from "./helpers.js";
import { parseFrontmatter, toMarkdown, parseSubtasks, parseRelations, serializeSubtasks, serializeRelations } from "./parsers.js";

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
  try { await access(boardPath(CONFIG_FILE)); return true; } catch { return false; }
}

// ── Config (config.md) ─────────────────────────────────────────────────

export async function readConfig(): Promise<{ name: string; startedColumns: string[]; completedColumns: string[] }> {
  const content = await readFile(boardPath(CONFIG_FILE), "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const nameMatch = body.match(/^# (.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : basename(cwd());

  return {
    name,
    startedColumns: Array.isArray(frontmatter.startedColumns) ? frontmatter.startedColumns as string[] : [],
    completedColumns: Array.isArray(frontmatter.completedColumns) ? frontmatter.completedColumns as string[] : [],
  };
}

export async function writeConfig(config: { name: string; startedColumns: string[]; completedColumns: string[] }): Promise<void> {
  await mkdir(boardPath(), { recursive: true });

  const fm: Record<string, string[]> = {};
  if (config.startedColumns?.length) fm.startedColumns = config.startedColumns;
  if (config.completedColumns?.length) fm.completedColumns = config.completedColumns;

  const body = `# ${config.name}`;
  await writeFile(boardPath(CONFIG_FILE), toMarkdown(fm, body));
}

// ── Tasks index (tasks.md) ─────────────────────────────────────────────

interface TasksIndex {
  columns: string[];
  tasksByColumn: Record<string, { id: string; title: string }[]>;
}

export async function readTasksIndex(): Promise<TasksIndex> {
  const content = await readFile(boardPath(TASKS_INDEX_FILE), "utf-8");

  const columns: string[] = [];
  const tasksByColumn: Record<string, { id: string; title: string }[]> = {};
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

    // Match: - [Title](tasks/{hash}/task.md)
    const linkRegex = /^- \[([^\]]+)\]\(tasks\/([^/]+)\/task\.md\)/gm;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(sectionText)) !== null) {
      tasksByColumn[col].push({ id: lm[2], title: lm[1] });
    }
  }

  return { columns, tasksByColumn };
}

export async function writeTasksIndex(columns: string[], tasksByColumn: Record<string, string[]>, titleMap: Record<string, string>): Promise<void> {
  await mkdir(boardPath(), { recursive: true });

  let body = "";
  for (const col of columns) {
    const tasks = tasksByColumn[col] ?? [];
    body += `## ${col}\n`;
    if (tasks.length > 0) {
      body += "\n";
      for (const id of tasks) {
        const title = titleMap[id] ?? id;
        body += `- [${title}](tasks/${id}/task.md)\n`;
      }
    }
    body += "\n";
  }

  await writeFile(boardPath(TASKS_INDEX_FILE), body);
}

// ── Combined index (merges config + tasks index) ───────────────────────

export async function readIndex(): Promise<BoardIndex> {
  const config = await readConfig();
  const tasksIdx = await readTasksIndex();

  // Convert { id, title }[] to just id[]
  const tasksByColumn: Record<string, string[]> = {};
  for (const [col, tasks] of Object.entries(tasksIdx.tasksByColumn)) {
    tasksByColumn[col] = tasks.map((t) => t.id);
  }

  return {
    name: config.name,
    columns: tasksIdx.columns,
    tasksByColumn,
    startedColumns: config.startedColumns,
    completedColumns: config.completedColumns,
  };
}

export async function writeIndex(index: BoardIndex): Promise<void> {
  await writeConfig({
    name: index.name,
    startedColumns: index.startedColumns,
    completedColumns: index.completedColumns,
  });

  // Build title map from task files (authoritative source for titles)
  const titleMap: Record<string, string> = {};
  for (const ids of Object.values(index.tasksByColumn)) {
    for (const id of ids) {
      if (!titleMap[id]) {
        try {
          const task = await readTask(id);
          titleMap[id] = task.title;
        } catch {
          titleMap[id] = id;
        }
      }
    }
  }

  await writeTasksIndex(index.columns, index.tasksByColumn, titleMap);
}

// ── Task I/O (folder-based) ────────────────────────────────────────────

function taskDir(id: string): string {
  return boardPath(TASKS_DIR, id);
}

async function readFileOrEmpty(path: string): Promise<string> {
  try { return await readFile(path, "utf-8"); } catch { return ""; }
}

export async function readTask(id: string): Promise<Task> {
  const taskMd = await readFile(join(taskDir(id), "task.md"), "utf-8");
  const { frontmatter, body } = parseFrontmatter(taskMd);

  const titleMatch = body.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  const detailsContent = await readFileOrEmpty(join(taskDir(id), "details.md"));
  const subtasksContent = await readFileOrEmpty(join(taskDir(id), "subtasks.md"));
  const relationsContent = await readFileOrEmpty(join(taskDir(id), "relations.md"));

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

export async function writeTask(task: Task): Promise<void> {
  const dir = taskDir(task.id);
  await mkdir(dir, { recursive: true });

  // task.md — frontmatter + title
  const fm: Record<string, string | string[]> = {
    created: task.created ?? now(),
    updated: now(),
  };
  if (task.started)   fm.started   = task.started;
  if (task.completed) fm.completed = task.completed;
  if (task.priority && task.priority !== "medium") fm.priority = task.priority;
  if (task.assignee)  fm.assignee  = task.assignee;
  if (task.tags?.length) fm.tags   = task.tags;

  await writeFile(join(dir, "task.md"), toMarkdown(fm, `# ${task.title}`));

  // details.md
  await writeFile(join(dir, "details.md"), task.description || "");

  // subtasks.md
  await writeFile(join(dir, "subtasks.md"), serializeSubtasks(task.subtasks ?? []));

  // relations.md
  await writeFile(join(dir, "relations.md"), serializeRelations(task.relations ?? []));
}

export async function deleteTaskFile(id: string): Promise<void> {
  await rm(taskDir(id), { recursive: true, force: true });
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
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !indexed.has(name));
  } catch { return []; }
}

// ── Board initialization + auto-migration ──────────────────────────────

export async function ensureBoard(): Promise<void> {
  await ensureBoardsRootGit();
  if (await boardExists()) return;

  // Check for old-format board to migrate
  const oldIndexPath = join(cwd(), OLD_KANBN_DIR, "index.md");
  try {
    await access(oldIndexPath);
    await migrateFromV0(join(cwd(), OLD_KANBN_DIR));
    return;
  } catch { /* no old board, create fresh */ }

  await mkdir(boardPath(TASKS_DIR), { recursive: true });
  await writeFile(boardPath(VERSION_FILE), BOARD_VERSION);
  await writeConfig({
    name: basename(cwd()),
    startedColumns: ["In Progress"],
    completedColumns: ["Done"],
  });
  await writeTasksIndex(
    [...DEFAULT_COLUMNS],
    Object.fromEntries(DEFAULT_COLUMNS.map((c) => [c, []])),
    {}
  );
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
  await writeFile(boardPath(VERSION_FILE), BOARD_VERSION);
  await writeConfig({ name, startedColumns, completedColumns });

  // Migrate tasks: read old files, assign new IDs
  const oldToNewId: Record<string, string> = {};
  const titleMap: Record<string, string> = {};
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
        titleMap[newId] = title;

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

  // Write migrated tasks
  for (const task of migratedTasks) {
    await writeTask(task);
  }

  // Write tasks index with new IDs
  const newTasksByColumn: Record<string, string[]> = {};
  for (const col of columns) {
    newTasksByColumn[col] = (oldTasksByColumn[col] ?? [])
      .map((oldId) => oldToNewId[oldId])
      .filter(Boolean);
  }

  await writeTasksIndex(columns, newTasksByColumn, titleMap);

  // Rename old board to .kanbn.bak
  const { rename } = await import("node:fs/promises");
  try {
    await rename(oldRoot, oldRoot.replace(/\.kanbn$/, ".kanbn.bak"));
  } catch { /* best effort */ }
}
